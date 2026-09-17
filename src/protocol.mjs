// The claim-takeover protocol state machine (ARCHITECTURE.md §4). Every write goes through
// src/memory.mjs's writeMemory, never src/arkiv.mjs's createMemory directly, so every entity
// this protocol writes has a real swarm_ref instead of a placeholder.

import { queryByTagAndType, queryByTagPrefixAndType, extendMemory, deleteMemory, AGENT_IDS } from './arkiv.mjs'
import { writeMemory } from './memory.mjs'
import { ROSTER } from './roster.mjs'
import { writeToLane, readLane, nextFreeLaneIndex } from './lane.mjs'

// Tiramisu has held every one of our transactions back for 11 blocks at a time, so a lease must outlive
// a renewal that lands that late: renewing every 4 blocks (claim) and every 2 (heartbeat) survives a
// 20- and 14-block delay.
const CLAIM_LEASE_BLOCKS = 24
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

async function heartbeatIsLive(pub, agentId) {
  return (await queryByTagAndType(pub, { tag: `agent-${agentId}`, memoryType: 'heartbeat', limit: 1 })).length > 0
}

// A lapsed claim alone can't tell a dead holder from a slow one; its heartbeat can. Every claimant
// has a `lane` row (tryClaim writes it on winning), so a previous worker whose heartbeat is still
// live is alive and gets to resume. Among several live previous workers the first in AGENT_IDS
// goes, so they never all wait on each other.
async function yieldsToLivePriorWorker(ctx, agentId, tag) {
  const lanes = await queryByTagAndType(ctx.pub, { tag, memoryType: 'lane' })
  // By the chain-enforced owner, not the `agent_id` a row says about itself.
  const priorWorkers = AGENT_IDS.filter((id) => lanes.some((row) => row.owner.toLowerCase() === ROSTER[id].address.toLowerCase()))
  for (const id of priorWorkers) {
    if (id === agentId) return false
    if (await heartbeatIsLive(ctx.pub, id)) return true
  }
  return false
}

// One `lane` row per agent per tag, written the first time that agent holds the claim, so a
// successor can find this agent's lane even if it dies before publishing anything to it.
async function ensureLaneRow(ctx, agentId, tag) {
  const signer = ctx.signers.get(agentId)
  if (!signer) throw new Error(`no signer configured for agentId "${agentId}"`)
  const lanes = await queryByTagAndType(ctx.pub, { tag, memoryType: 'lane' })
  if (lanes.some((row) => row.owner.toLowerCase() === signer.account.address.toLowerCase())) return
  await writeMemory(signer.wallet, {
    agentId, memoryType: 'lane', tag, importance: 5, content: { note: 'lane provenance marker' }, ttlBlocks: LONG_LIVED_BLOCKS,
  })
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
  if (await yieldsToLivePriorWorker(ctx, agentId, tag)) return { held: false }

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
    for (const settleBlocks of [1n, 2n]) {
      await waitForBlock(pub, receipt.blockNumber + settleBlocks)
      const rivals = await queryByTagAndType(pub, { tag, memoryType: 'claim' })
      if (currentWinnerKey(rivals) !== written.entityKey) {
        await deleteMemory(signer.wallet, { entityKey: written.entityKey })
        await sleep(200 + Math.floor(Math.random() * 300))
        return tryClaim(ctx, agentId, tag, attempt + 1)
      }
    }

    await ensureLaneRow(ctx, agentId, tag)
    // The settle rounds and the lane row above eat about half the lease before the holder's first
    // renewal is even due, which live runs showed is enough to lose it. Start the work on a full lease.
    try {
      await extendMemory(signer.wallet, { entityKey: written.entityKey, ttlBlocks: CLAIM_LEASE_BLOCKS })
    } catch (e) {
      const kind = classifyExtendError(e)
      if (kind === 'lapsed') return { held: false }
      if (kind === 'other') throw e
    }
    return { held: true, entityKey: written.entityKey }
  } catch (e) {
    // Any failure past this point (receipt lookup, settle wait, requery) must not leave an
    // orphaned claim sitting on the tag for a full lease with nobody working it.
    await deleteMemory(signer.wallet, { entityKey: written.entityKey }).catch(() => {})
    throw e
  }
}

// The engine rejects an extension two different ways, and they are not the same news. Both messages
// below were captured live (tests/live/claim-lapse.mjs re-captures them on every run):
//   "entity 0x… expired at block N" — the entity is already gone. The lease is lost.
//   "entity 0x… already expires at block N, so extending it to M would shorten its life" — this
//     renewal followed so close behind the previous one that it would move the expiry backwards.
//     The lease is intact; skipping this one extension is a no-op.
// "expired" is checked first, since "expires" is a prefix match away from it.
function classifyExtendError(e) {
  if (/expired/i.test(e.message)) return 'lapsed'
  if (/expir/i.test(e.message)) return 'too-soon'
  return 'other'
}

// Resolves { lost: false } when it stopped because shouldContinue() went false, and { lost: true }
// when the lease turned out to have already lapsed — the caller must stop believing it holds the
// claim in that case. Any other failure (an RPC hiccup) is retried on the next round: a lease that
// really is gone reports itself as expired then.
export async function renewClaim(ctx, agentId, entityKey, leaseBlocks = CLAIM_LEASE_BLOCKS, shouldContinue = () => true) {
  const { pub, signers } = ctx
  const signer = signers.get(agentId)
  if (!signer) throw new Error(`no signer configured for agentId "${agentId}"`)
  const renewEveryBlocks = Math.max(1, Math.floor(leaseBlocks / 6))
  while (shouldContinue()) {
    const start = await pub.getBlockNumber()
    await waitForBlock(pub, start + BigInt(renewEveryBlocks))
    if (!shouldContinue()) break
    try {
      await extendMemory(signer.wallet, { entityKey, ttlBlocks: leaseBlocks })
    } catch (e) {
      // Nothing left to renew: looping on a lapsed entity would keep the caller convinced it still
      // holds a claim another agent is free to take.
      if (classifyExtendError(e) === 'lapsed') return { lost: true, reason: e.message }
    }
  }
  return { lost: false }
}

// An agent's profile (for now just its location) is a lane on its own `agent-<id>` topic, sealed to
// the roster. The address derives from the agent's wallet alone, so a peer can read the latest entry
// after the agent is gone without ever having watched it beat. A new entry is written only when the
// profile changes, so the feed is one entry per move, not one per run.
function profileTag(agentId) {
  return `agent-${agentId}`
}

export async function publishProfile(ctx, agentId, profile) {
  const signer = ctx.signers.get(agentId)
  if (!signer) throw new Error(`no signer configured for agentId "${agentId}"`)
  const address = signer.account.address
  const index = await nextFreeLaneIndex(address, profileTag(agentId))
  if (index > 0 && JSON.stringify(await readLane(address, profileTag(agentId), index - 1)) === JSON.stringify(profile)) return
  await writeToLane(process.env[`ARKIV_PRIVATE_KEY_${agentId.toUpperCase()}`], address, profileTag(agentId), index, profile)
}

export async function readProfile(ctx, agentId) {
  const address = ROSTER[agentId]?.address
  if (!address) return null
  const index = await nextFreeLaneIndex(address, profileTag(agentId))
  return index === 0 ? null : readLane(address, profileTag(agentId), index - 1)
}

export const HEARTBEAT_LEASE_BLOCKS = 16

export async function startHeartbeat(ctx, agentId, shouldContinue = () => true) {
  const { pub, signers } = ctx
  const signer = signers.get(agentId)
  if (!signer) throw new Error(`no signer configured for agentId "${agentId}"`)
  const written = await writeMemory(signer.wallet, {
    agentId, memoryType: 'heartbeat', tag: `agent-${agentId}`, importance: 1, content: {}, ttlBlocks: HEARTBEAT_LEASE_BLOCKS,
  })
  const receipt = await pub.waitForTransactionReceipt({ hash: written.txHash })
  let anchor = receipt.blockNumber
  const renewEveryBlocks = Math.max(1, Math.floor(HEARTBEAT_LEASE_BLOCKS / 8))
  while (shouldContinue()) {
    await waitForBlock(pub, anchor + BigInt(renewEveryBlocks))
    if (!shouldContinue()) break
    // Only this agent's wallet can renew or delete its row, so the key it wrote is the one to extend;
    // re-querying for it only let a momentarily empty query result restart the beat.
    try {
      await extendMemory(signer.wallet, { entityKey: written.entityKey, ttlBlocks: HEARTBEAT_LEASE_BLOCKS })
    } catch (e) {
      // A lapsed beat is gone for good; the caller starts a fresh one. Anything else is retried.
      if (classifyExtendError(e) === 'lapsed') return
    }
    anchor = await pub.getBlockNumber()
  }
}

const PEER_WATCH_POLL_MS = 4000
const EMPTY_POLLS_BEFORE_OUTAGE = 2
// One heartbeat lease at Tiramisu's ~2s blocks.
const REVIVAL_GRACE_MS = HEARTBEAT_LEASE_BLOCKS * 2000

export function outageTagPrefix(peerId, scope) {
  return `outage-${peerId}-${scope}-`
}

// The nth outage of a peer in a run is `outage-<peer>-<scope>-<n>`, where n counts that peer's
// outages in this run that already have a `done` row. Every watcher reads n from the chain, so they
// converge on one tag instead of each naming the outage from what it happened to see. A dead peer
// only comes back by its outage being finished, so dying again after that is outage n+1. `scope`
// (the demo run's id) keeps rows an earlier run left on chain from passing for this one's.
async function currentOutageTag(pub, peerId, scope) {
  const prefix = outageTagPrefix(peerId, scope)
  const dones = await queryByTagPrefixAndType(pub, { tagPrefix: prefix, memoryType: 'done' })
  return prefix + new Set(dones.map((r) => r.attributes.tag)).size
}

// onOutage(peerId, tag, { filed, location }) fires once per tag per watcher, whether this watcher
// filed the row or found it already there, so every live peer can pick the incident up — not only
// the filer. `location` comes from the peer's sealed profile, null if it has none or can't be read.
export function watchForPeerOutages(ctx, watchingAgentId, scope, onOutage) {
  const { pub, signers } = ctx
  let stopped = false
  // A single empty query is not evidence a peer is down: a row that was just renewed stays
  // invisible to queries for a block or two (the same lag startHeartbeat anchors around). Only a
  // second consecutive empty poll for the same peer separates chain-index lag from a real lapse.
  const emptyPolls = new Map()
  // Our own just-filed incident is invisible to the existence check below for a block or two, so
  // the on-chain check alone would let the next poll file a second one.
  const handled = new Set()
  const lastHandled = new Map()
  const graceUntil = new Map()
  const pollPeer = async (peerId) => {
    const heartbeats = await queryByTagAndType(pub, { tag: `agent-${peerId}`, memoryType: 'heartbeat', limit: 1 })
    if (heartbeats.length > 0) {
      emptyPolls.set(peerId, 0)
      return
    }
    const misses = (emptyPolls.get(peerId) ?? 0) + 1
    emptyPolls.set(peerId, misses)
    if (misses < EMPTY_POLLS_BEFORE_OUTAGE) return

    const outageTag = await currentOutageTag(pub, peerId, scope)
    if (handled.has(outageTag)) return
    // A new tag after one this watcher handled means that outage was just finished and the peer is
    // being brought back. Its new heartbeat takes a write and a block or two to show, so it gets one
    // lease to beat again before its silence counts as another outage.
    if (lastHandled.has(peerId) && !graceUntil.has(outageTag)) graceUntil.set(outageTag, Date.now() + REVIVAL_GRACE_MS)
    if (Date.now() < (graceUntil.get(outageTag) ?? 0)) return
    const existing = await queryByTagAndType(pub, { tag: outageTag, memoryType: 'event', limit: 1 })
    const filed = existing.length === 0
    const location = (await readProfile(ctx, peerId).catch(() => null))?.location ?? null
    if (filed) {
      const signer = signers.get(watchingAgentId)
      await writeMemory(signer.wallet, {
        agentId: watchingAgentId, memoryType: 'event', tag: outageTag, importance: 8,
        content: { note: `${peerId} heartbeat lapsed`, location }, ttlBlocks: LONG_LIVED_BLOCKS,
      })
    }
    handled.add(outageTag)
    lastHandled.set(peerId, outageTag)
    if (!stopped) onOutage?.(peerId, outageTag, { filed, location })
  }
  // One failed query must not end the watch: a watcher that has quietly stopped is a peer nobody
  // is watching for the rest of the run.
  const loop = async () => {
    while (!stopped) {
      for (const peerId of AGENT_IDS) {
        if (stopped) return
        if (peerId === watchingAgentId) continue
        try {
          await pollPeer(peerId)
        } catch (e) {
          console.error(`watchForPeerOutages(${watchingAgentId}) poll of ${peerId} failed:`, e.message)
        }
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
    // Walk from index 0 until a clean 404, matching the discovery method ARCHITECTURE.md §4
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
  await ensureLaneRow(ctx, agentId, tag)
  await writeMemory(signer.wallet, {
    agentId, memoryType: 'done', tag, importance: 5, content: { note: 'work complete' }, ttlBlocks: LONG_LIVED_BLOCKS,
  })
  // The `done` row already closes the incident. A claim that lapsed during the last step can't be
  // deleted, and throwing here would report a finished incident as a failed one.
  await deleteMemory(signer.wallet, { entityKey }).catch(() => {})
}

// `probe` is the verifier's own check of the world (is the rack up, does the DC have power). The
// finisher's lane saying `fix` is its claim; the probe is what makes the verdict independent of it.
export async function verify(ctx, verifierAgentId, tag, probe = async () => true) {
  const { pub, signers } = ctx
  const verifierSigner = signers.get(verifierAgentId)
  if (!verifierSigner) throw new Error(`no signer configured for agentId "${verifierAgentId}"`)
  let doneRows = []
  let pollAttempt = 0
  while (doneRows.length === 0) {
    if (pollAttempt >= VERIFY_POLL_MAX_ATTEMPTS) {
      throw new Error(`verify(): no 'done' row appeared for tag "${tag}" within timeout`)
    }
    doneRows = await queryByTagAndType(pub, { tag, memoryType: 'done' })
    if (doneRows.length === 0) {
      await sleep(2000)
      pollAttempt += 1
    }
  }
  // Checked against the chain-enforced owner of the `done` row, not anything the caller remembers.
  const verifierAddress = verifierSigner.account.address.toLowerCase()
  if (doneRows.some((row) => row.owner.toLowerCase() === verifierAddress)) return { outcome: null, refused: true }
  const existing = await queryByTagAndType(pub, { tag, memoryType: 'verdict', limit: 1 })
  if (existing.length > 0) return { outcome: existing[0].attributes.outcome, alreadyVerified: true }
  const doneRow = doneRows[0]
  const lanes = await takeOver(ctx, tag)
  const finisherLane = lanes.find((l) => l.ownerAddress.toLowerCase() === doneRow.owner.toLowerCase())
  const laneKind = finisherLane?.latestContent?.kind ?? 'missing'
  const probed = await probe()
  const outcome = laneKind === 'fix' && probed ? 'fixed' : 'reopened'
  const written = await writeMemory(verifierSigner.wallet, {
    agentId: verifierAgentId, memoryType: 'verdict', tag, importance: 5,
    content: { reasoning: `checked ${doneRow.owner}'s lane, found a ${laneKind} entry; own probe ${probed ? 'passed' : 'failed'}` },
    ttlBlocks: LONG_LIVED_BLOCKS, outcome,
  })
  return { outcome, probed, entityKey: written.entityKey }
}
