// Runs atlas, nova, and sol as concurrent loops in one process, so they share one Swarm Stamper
// (see Global Constraints in the implementation plan — splitting them into separate OS processes
// would let each start every postage bucket at slot 0 on the same shared batch).
//
//   node --env-file=.env scripts/orchestrator.mjs <tag>
//
// Example: node --env-file=.env scripts/orchestrator.mjs incident-42

import { makeClients, makeAgentSigners } from '../src/arkiv.mjs'
import { writeMemory } from '../src/memory.mjs'
import { writeToLane, nextFreeLaneIndex } from '../src/lane.mjs'
import { tryClaim, renewClaim, takeOver, finish, verify } from '../src/protocol.mjs'

const httpUrl = process.env.ARKIV_HTTP_URL
const wsUrl = process.env.ARKIV_WS_URL
const { pub } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY, httpUrl, wsUrl })
const signers = makeAgentSigners({ httpUrl })
const ctx = { pub, signers }

const tag = process.argv[2] ?? `incident-${Date.now()}`
const log = (agent, msg) => console.log(`[${agent}] ${msg}`)

async function atlasReports() {
  const atlas = signers.get('atlas')
  const agentPrivateKeyHex = process.env.ARKIV_PRIVATE_KEY_ATLAS
  const index = await nextFreeLaneIndex(atlas.account.address, tag)
  await writeToLane(agentPrivateKeyHex, atlas.account.address, tag, index, { kind: 'diagnosis', note: 'incident detected' })
  await writeMemory(atlas.wallet, {
    agentId: 'atlas', memoryType: 'event', tag, importance: 8,
    content: { note: 'incident detected' }, ttlBlocks: 600,
  })
  log('atlas', `reported ${tag}`)
}

async function workerLoop(agentId) {
  const claimed = await tryClaim(ctx, agentId, tag)
  if (!claimed.held) {
    log(agentId, 'lost the race or incident already spoken for — exiting')
    return
  }
  log(agentId, `holds the claim (${claimed.entityKey.slice(0, 18)}…)`)
  let renewing = true
  let renewalError = null
  // Attach .catch() immediately, not after the sleep below — otherwise a rejection during the
  // sleep window is an unhandled rejection that can crash the process before we ever await it.
  const renewalPromise = renewClaim(ctx, agentId, claimed.entityKey, undefined, () => renewing)
    .catch((e) => { renewalError = e })

  // Simulated work: a real worker would diagnose and fix here. This orchestrator just
  // demonstrates the mechanism, so it pauses briefly then finishes.
  await new Promise((resolve) => setTimeout(resolve, 5000))

  renewing = false
  await renewalPromise
  if (renewalError) log(agentId, `renewal failed: ${renewalError.message}`)
  await finish(ctx, agentId, tag, claimed.entityKey, { note: `fixed by ${agentId}` })
  log(agentId, 'finished')
}

async function atlasVerifies() {
  const result = await verify(ctx, tag)
  log('atlas', `verdict: ${result.outcome}`)
}

await atlasReports()
await Promise.race([workerLoop('nova'), workerLoop('sol')])
await atlasVerifies()
