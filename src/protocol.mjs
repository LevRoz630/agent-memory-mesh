// The claim-takeover protocol state machine (ARCHITECTURE.md §7). Every write goes through
// src/memory.mjs's writeMemory, never src/arkiv.mjs's createMemory directly, so every entity
// this protocol writes has a real swarm_ref instead of a placeholder.

import { queryByTagAndType, extendMemory, deleteMemory, AGENT_IDS } from './arkiv.mjs'
import { writeMemory } from './memory.mjs'
import { writeToLane, readLane, nextFreeLaneIndex } from './lane.mjs'

const CLAIM_LEASE_BLOCKS = 12 // long enough to fit a two-block settle window ahead of the first
                               // renewal at ~1/3 lease; see spec's B7 resolution
export const LONG_LIVED_BLOCKS = 600 // matches event/lane/done/verdict TTL elsewhere in the protocol
const MAX_CLAIM_ATTEMPTS = 10 // bounds gas spend on repeated tie-break losses, not stack depth
const VERIFY_POLL_MAX_ATTEMPTS = 30 // ~60s at the 2s poll interval below

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForBlock(pub, targetBlock) {
  while ((await pub.getBlockNumber()) < targetBlock) {
    await sleep(500)
  }
}

async function currentBlock(pub) {
  return pub.getBlockNumber()
}

// Cheapest-to-honor first: a closed incident should never be reopened by a worker, and finished
// work should never be redone.
async function incidentIsSpokenFor(ctx, tag) {
  const { pub } = ctx
  const verdicts = await queryByTagAndType(pub, { tag, memoryType: 'verdict', limit: 1 })
  if (verdicts.length > 0) return true
  const dones = await queryByTagAndType(pub, { tag, memoryType: 'done', limit: 1 })
  if (dones.length > 0) return true
  const claims = await queryByTagAndType(pub, { tag, memoryType: 'claim', limit: 1 })
  return claims.length > 0
}

// Lowest key wins. `rivals.length === 0` means our own just-written row isn't even visible yet
// to this query, which is indistinguishable from "we won". It must NOT be read as a win: the
// caller retries instead of assuming victory.
function currentWinnerKey(rivals) {
  if (rivals.length === 0) return null
  const sorted = [...rivals].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return sorted[0].key
}

export async function tryClaim(ctx, agentId, tag, attempt = 0) {
  const { pub, signers } = ctx
  const signer = signers.get(agentId)
  if (!signer) throw new Error(`no signer configured for agentId "${agentId}"`)

  if (attempt >= MAX_CLAIM_ATTEMPTS) return { held: false }

  if (await incidentIsSpokenFor(ctx, tag)) return { held: false }

  const written = await writeMemory(signer.wallet, {
    agentId, memoryType: 'claim', tag, importance: 5, content: {}, ttlBlocks: CLAIM_LEASE_BLOCKS,
  })

  try {
    // Settle window: without waiting for both writers' claims to be visible, each can see only
    // its own row and both conclude they won. A single settle-and-query round isn't enough,
    // since a rival landing 1-2 blocks late can still slip in as the lower key after we've
    // already declared ourselves the winner. So this does two confirmation rounds, and only
    // finalizes {held: true} if we're still the lowest key one full block after we first
    // believed we won.
    const receipt = await pub.waitForTransactionReceipt({ hash: written.txHash })
    const txBlock = receipt.blockNumber

    await waitForBlock(pub, txBlock + 1n)
    let rivals = await queryByTagAndType(pub, { tag, memoryType: 'claim' })
    if (currentWinnerKey(rivals) !== written.entityKey) {
      await deleteMemory(signer.wallet, { entityKey: written.entityKey })
      await sleep(200 + Math.floor(Math.random() * 300))
      return tryClaim(ctx, agentId, tag, attempt + 1)
    }

    await waitForBlock(pub, txBlock + 2n)
    rivals = await queryByTagAndType(pub, { tag, memoryType: 'claim' })
    if (currentWinnerKey(rivals) !== written.entityKey) {
      await deleteMemory(signer.wallet, { entityKey: written.entityKey })
      await sleep(200 + Math.floor(Math.random() * 300))
      return tryClaim(ctx, agentId, tag, attempt + 1)
    }

    return { held: true, entityKey: written.entityKey }
  } catch (e) {
    // Any failure past this point (receipt lookup, settle wait, requery) must not leave an
    // orphaned claim sitting on the tag for a full lease with nobody working it.
    await deleteMemory(signer.wallet, { entityKey: written.entityKey }).catch(() => {})
    throw e
  }
}

// The engine rejects an extension two different ways, and they are not the same news:
//   "...would not extend the expiry..." — the new expiry wouldn't land later than the current one,
//     because this renewal followed extremely close behind the previous one. The lease is intact.
//   "entity 0x... expired at block N" — the entity is already gone. The lease is lost.
// "expired" does not match /expiry/, which is how the second case used to escape as a throw that
// aborted the renewal loop without the caller ever learning the claim had lapsed.
function classifyExtendError(e) {
  if (/expired/i.test(e.message)) return 'lapsed'
  if (/expiry/i.test(e.message)) return 'too-soon'
  return 'other'
}

// Resolves { lost: false } when it stopped because shouldContinue() went false, and { lost: true }
// when the lease turned out to have already lapsed — the caller must stop believing it holds the
// claim in that case. A genuinely unexpected failure still throws.
export async function renewClaim(ctx, agentId, entityKey, leaseBlocks = CLAIM_LEASE_BLOCKS, shouldContinue = () => true) {
  const { pub, signers } = ctx
  const signer = signers.get(agentId)
  if (!signer) throw new Error(`no signer configured for agentId "${agentId}"`)
  const renewEveryBlocks = Math.max(1, Math.floor(leaseBlocks / 3))
  while (shouldContinue()) {
    const start = await currentBlock(pub)
    await waitForBlock(pub, start + BigInt(renewEveryBlocks))
    if (!shouldContinue()) break
    try {
      await extendMemory(signer.wallet, { entityKey, ttlBlocks: leaseBlocks })
    } catch (e) {
      const kind = classifyExtendError(e)
      if (kind === 'other') throw e
      // Nothing left to renew: looping on a lapsed entity would keep the caller convinced it still
      // holds a claim another agent is free to take.
      if (kind === 'lapsed') return { lost: true }
    }
  }
  return { lost: false }
}

export const HEARTBEAT_LEASE_BLOCKS = 8

export async function startHeartbeat(ctx, agentId, shouldContinue = () => true) {
  const { pub, signers } = ctx
  const signer = signers.get(agentId)
  if (!signer) throw new Error(`no signer configured for agentId "${agentId}"`)
  const tag = `agent-${agentId}`
  const written = await writeMemory(signer.wallet, {
    agentId, memoryType: 'heartbeat', tag, importance: 1, content: {}, ttlBlocks: HEARTBEAT_LEASE_BLOCKS,
  })
  // writeMemory returns on the tx hash, not the receipt, and a just-written row stays invisible to
  // queries for a block or two (same lag currentWinnerKey documents). Anchoring the first wait to
  // the write's own block keeps the first lookup below from reading that lag as "already down".
  const receipt = await pub.waitForTransactionReceipt({ hash: written.txHash })
  let anchor = receipt.blockNumber
  const renewEveryBlocks = Math.max(1, Math.floor(HEARTBEAT_LEASE_BLOCKS / 3))
  while (shouldContinue()) {
    await waitForBlock(pub, anchor + BigInt(renewEveryBlocks))
    if (!shouldContinue()) break
    const rows = await queryByTagAndType(pub, { tag, memoryType: 'heartbeat', limit: 1 })
    if (rows.length === 0) return // agent was already considered down elsewhere; stop renewing
    try {
      await extendMemory(signer.wallet, { entityKey: rows[0].key, ttlBlocks: HEARTBEAT_LEASE_BLOCKS })
    } catch (e) {
      const kind = classifyExtendError(e)
      if (kind === 'other') throw e
      // Same as the rows.length === 0 case above: the beat lapsed between the query and the extend,
      // so this row is gone. Give up and let the caller start a fresh beat.
      if (kind === 'lapsed') return
    }
    anchor = await currentBlock(pub)
  }
}

const PEER_WATCH_POLL_MS = 4000
const EMPTY_POLLS_BEFORE_OUTAGE = 2

export function watchForPeerOutages(ctx, watchingAgentId, onOutageDetected) {
  const { pub, signers } = ctx
  let stopped = false
  // A single empty query is not evidence a peer is down: a row that was just renewed stays
  // invisible to queries for a block or two (the same lag startHeartbeat anchors around). Only a
  // second consecutive empty poll for the same peer separates chain-index lag from a real lapse.
  const emptyPolls = new Map()
  // Our own just-filed incident is invisible to the existence check below for a block or two, so
  // the on-chain check alone would let the next poll file a second one.
  const filed = new Set()
  const loop = async () => {
    while (!stopped) {
      for (const peerId of AGENT_IDS) {
        if (stopped) return
        if (peerId === watchingAgentId) continue
        const peerTag = `agent-${peerId}`
        const heartbeats = await queryByTagAndType(pub, { tag: peerTag, memoryType: 'heartbeat', limit: 1 })
        if (heartbeats.length > 0) {
          emptyPolls.set(peerId, 0)
          filed.delete(peerId)
          continue // peer is alive
        }
        const misses = (emptyPolls.get(peerId) ?? 0) + 1
        emptyPolls.set(peerId, misses)
        if (misses < EMPTY_POLLS_BEFORE_OUTAGE) continue
        if (filed.has(peerId)) continue

        const outageTag = `outage-${peerId}`
        const existing = await queryByTagAndType(pub, { tag: outageTag, memoryType: 'event', limit: 1 })
        if (existing.length > 0) {
          filed.add(peerId)
          continue // already filed, by us or another watcher
        }

        const signer = signers.get(watchingAgentId)
        await writeMemory(signer.wallet, {
          agentId: watchingAgentId, memoryType: 'event', tag: outageTag, importance: 8,
          content: { note: `${peerId} heartbeat lapsed` }, ttlBlocks: LONG_LIVED_BLOCKS,
        })
        filed.add(peerId)
        onOutageDetected?.(peerId, outageTag)
      }
      await sleep(PEER_WATCH_POLL_MS)
    }
  }
  loop().catch((e) => console.error(`watchForPeerOutages(${watchingAgentId}) failed:`, e.message))
  return () => { stopped = true }
}

export async function takeOver(ctx, tag) {
  const { pub } = ctx
  const lanes = await queryByTagAndType(pub, { tag, memoryType: 'lane' })
  const results = []
  for (const laneRow of lanes) {
    const ownerAddress = laneRow.owner
    let index = 0
    let latestContent = null
    let latestIndex = -1
    // Walk from index 0 until a clean 404, matching the discovery method ARCHITECTURE.md §7
    // specifies. Small counts expected at demo scale.
    while (true) {
      const content = await readLane(ownerAddress, tag, index)
      if (content === null) break
      latestContent = content
      latestIndex = index
      index += 1
    }
    if (latestContent) results.push({ ownerAddress, latestIndex, latestContent })
  }
  return results
}

export async function finish(ctx, agentId, tag, entityKey, fixContent) {
  const { signers } = ctx
  const signer = signers.get(agentId)
  if (!signer) throw new Error(`no signer configured for agentId "${agentId}"`)
  const agentPrivateKeyHex = process.env[`ARKIV_PRIVATE_KEY_${agentId.toUpperCase()}`]
  if (!agentPrivateKeyHex) throw new Error(`no private key configured for agentId "${agentId}"`)
  const index = await nextFreeLaneIndex(signer.account.address, tag)
  await writeToLane(agentPrivateKeyHex, signer.account.address, tag, index, { kind: 'fix', ...fixContent })
  await writeMemory(signer.wallet, {
    agentId, memoryType: 'lane', tag, importance: 5, content: { note: 'lane provenance marker' }, ttlBlocks: LONG_LIVED_BLOCKS,
  })
  await writeMemory(signer.wallet, {
    agentId, memoryType: 'done', tag, importance: 5, content: { note: 'work complete' }, ttlBlocks: LONG_LIVED_BLOCKS,
  })
  await deleteMemory(signer.wallet, { entityKey })
}

export async function verify(ctx, verifierAgentId, tag) {
  const { pub, signers } = ctx
  const verifierSigner = signers.get(verifierAgentId)
  if (!verifierSigner) throw new Error(`no signer configured for agentId "${verifierAgentId}"`)
  let doneRows = []
  let pollAttempt = 0
  while (doneRows.length === 0) {
    if (pollAttempt >= VERIFY_POLL_MAX_ATTEMPTS) {
      throw new Error(`verify(): no 'done' row appeared for tag "${tag}" within timeout`)
    }
    doneRows = await queryByTagAndType(pub, { tag, memoryType: 'done', limit: 1 })
    if (doneRows.length === 0) {
      await sleep(2000)
      pollAttempt += 1
    }
  }
  const doneRow = doneRows[0]
  const lanes = await takeOver(ctx, tag)
  const finisherLane = lanes.find((l) => l.ownerAddress.toLowerCase() === doneRow.owner.toLowerCase())
  const outcome = finisherLane?.latestContent?.kind === 'fix' ? 'fixed' : 'reopened'
  await writeMemory(verifierSigner.wallet, {
    agentId: verifierAgentId, memoryType: 'verdict', tag, importance: 5,
    content: { reasoning: `checked ${doneRow.owner}'s lane, found a ${finisherLane?.latestContent?.kind ?? 'missing'} entry` },
    ttlBlocks: LONG_LIVED_BLOCKS, roster: AGENT_IDS, outcome,
  })
  return { outcome }
}
