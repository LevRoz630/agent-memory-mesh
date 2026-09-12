// The claim-takeover protocol state machine (ARCHITECTURE.md §7). Every write goes through
// src/memory.mjs's writeMemory, never src/arkiv.mjs's createMemory directly — that guarantees
// every entity this protocol writes has a real swarm_ref, never a placeholder.

import { queryByTagAndType, extendMemory, deleteMemory, AGENT_IDS } from './arkiv.mjs'
import { writeMemory } from './memory.mjs'
import { writeToLane, readLane, nextFreeLaneIndex } from './lane.mjs'

const CLAIM_LEASE_BLOCKS = 12 // long enough to fit a two-block settle window ahead of the first
                               // renewal at ~1/3 lease; see spec's B7 resolution
const LONG_LIVED_BLOCKS = 600 // matches event/lane/done/verdict TTL elsewhere in the protocol
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

// Lowest key wins. `rivals.length === 0` means our own just-written row is not even visible yet
// to this query — that's indistinguishable from "we won", so it must NOT be read as a win; the
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
    // its own row and both conclude they won. A single settle-and-query round is not enough — a
    // rival landing 1-2 blocks late can still slip in as the lower key after we've already
    // declared ourselves the winner. So this does two confirmation rounds: only finalize
    // {held: true} if we are still the lowest key one full block after we first believed we won.
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

export async function renewClaim(ctx, agentId, entityKey, leaseBlocks = CLAIM_LEASE_BLOCKS, shouldContinue = () => true) {
  const { pub, signers } = ctx
  const signer = signers.get(agentId)
  if (!signer) throw new Error(`no signer configured for agentId "${agentId}"`)
  const renewEveryBlocks = Math.max(1, Math.floor(leaseBlocks / 3))
  while (shouldContinue()) {
    const start = await currentBlock(pub)
    await waitForBlock(pub, start + BigInt(renewEveryBlocks))
    try {
      await extendMemory(signer.wallet, { entityKey, ttlBlocks: leaseBlocks })
    } catch (e) {
      // The engine rejects an extension that would not move the expiry later — that happens when
      // this renewal landed extremely close behind a previous one. Treat it as a no-op, not a
      // dropped lease.
      if (!/expiry/i.test(e.message)) throw e
    }
  }
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
    // Walk from index 0 until a clean 404 — matches the discovery method ARCHITECTURE.md §7
    // specifies; small counts expected at demo scale.
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

export async function verify(ctx, tag) {
  const { pub, signers } = ctx
  const atlasSigner = signers.get('atlas')
  if (!atlasSigner) throw new Error('no signer configured for agentId "atlas"')
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
  await writeMemory(atlasSigner.wallet, {
    agentId: 'atlas', memoryType: 'verdict', tag, importance: 5,
    content: { reasoning: `checked ${doneRow.owner}'s lane, found a ${finisherLane?.latestContent?.kind ?? 'missing'} entry` },
    ttlBlocks: LONG_LIVED_BLOCKS, roster: AGENT_IDS, outcome,
  })
  return { outcome }
}
