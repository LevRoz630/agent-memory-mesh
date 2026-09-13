// Two peers down at once: the survivor must detect, claim, and finish both outage incidents
// concurrently, reviving both — not serialize behind one, and not silently drop the second.
//
//   node tests/unit/demo-double-outage.mjs

import { createDemo } from '../../src/demo.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeOps({ leaseMs }) {
  const log = []
  const steps = []
  const watchers = new Map()
  const claims = new Map()
  const done = new Set()
  return {
    log,
    steps,
    watchers,
    async startHeartbeat(agentId, shouldContinue) {
      log.push(['heartbeat-start', agentId])
      while (shouldContinue()) await sleep(5)
      log.push(['heartbeat-stop', agentId])
    },
    watchForPeerOutages(agentId, _scope, onOutageDetected) {
      watchers.set(agentId, onOutageDetected)
      return () => watchers.delete(agentId)
    },
    async verify(agentId, tag) {
      log.push(['verify', agentId, tag])
      return { outcome: 'fixed' }
    },
    async reportIncident(tag) {
      log.push(['report', tag])
      return { swarmRef: 'ab'.repeat(32), entityKey: '0x' + '1'.repeat(64) }
    },
    async tryClaim(agentId, tag) {
      await sleep(5)
      if (done.has(tag)) return { held: false }
      const held = claims.get(tag)
      if (held && held.expiresAt > Date.now()) return { held: false }
      claims.set(tag, { agentId, expiresAt: Date.now() + leaseMs })
      log.push(['claim', agentId, Date.now(), tag])
      return { held: true, entityKey: `claim-${agentId}-${tag}` }
    },
    async renewClaim(agentId, _entityKey, shouldContinue) {
      while (shouldContinue()) {
        await sleep(leaseMs / 3)
        if (!shouldContinue()) return { lost: false }
        for (const held of claims.values()) {
          if (held.agentId === agentId) held.expiresAt = Date.now() + leaseMs
        }
      }
      return { lost: false }
    },
    async readProgress(tag) {
      return steps.filter((s) => s.tag === tag).length
    },
    async nextLaneIndex(agentId, tag) {
      return steps.filter((s) => s.agentId === agentId && s.tag === tag).length
    },
    async recordStep(agentId, tag, step) {
      steps.push({ agentId, tag, step })
    },
    async finish(agentId, tag, entityKey) {
      done.add(tag)
      claims.delete(tag)
      log.push(['finish', agentId, tag])
    },
    async publishProfile() {},
    async isDone(tag) {
      return done.has(tag)
    },
    receipts: [],
    async publishReceipt(state) {
      log.push(['publishReceipt', state.tag])
      this.receipts.push(state)
      return 'cd'.repeat(32)
    },
  }
}

async function waitFor(cond, what, timeoutMs = 3000) {
  const started = Date.now()
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

const results = []
const check = (name, ok) => {
  results.push(Boolean(ok))
  console.log(`  ${ok ? 'pass' : 'FAIL'}: ${name}`)
}

console.log('demo controller: two peers down at once, sol must revive both\n')

const ops = fakeOps({ leaseMs: 150 })
// Push the seeded incident's own worker starts far out so it doesn't interleave with this scenario.
const demo = createDemo({
  ops,
  timings: { stepMs: 40, retryMs: 20, verifyPollMs: 20, watchStartDelayMs: 20, startDelayMs: { atlas: 5000, nova: 5000, sol: 5000 } },
})

await demo.start()
await waitFor(() => ops.watchers.has('sol'), 'sol to register its peer watch')

demo.kill('atlas')
demo.kill('nova')

// Simulate sol's peer-watch loop noticing both lapsed heartbeats in the same poll pass, the way
// protocol.mjs's watchForPeerOutages iterates every peer per iteration before sleeping again.
ops.watchers.get('sol')('atlas', 'outage-atlas')
ops.watchers.get('sol')('nova', 'outage-nova')

await waitFor(
  () => demo.getState().agents.atlas.alive && demo.getState().agents.nova.alive,
  'both dead peers to be revived',
  5000,
)
const state = demo.getState()

check('two distinct outage incidents are tracked', Boolean(state.incidents['outage-atlas']) && Boolean(state.incidents['outage-nova']))
check('each outage incident has the right subject', state.incidents['outage-atlas']?.subject === 'atlas' && state.incidents['outage-nova']?.subject === 'nova')
check('sol claimed both outages', ops.log.some((l) => l[0] === 'claim' && l[1] === 'sol' && l[3] === 'outage-atlas') && ops.log.some((l) => l[0] === 'claim' && l[1] === 'sol' && l[3] === 'outage-nova'))
check('sol finished both outages', ops.log.some((l) => l[0] === 'finish' && l[1] === 'sol' && l[2] === 'outage-atlas') && ops.log.some((l) => l[0] === 'finish' && l[1] === 'sol' && l[2] === 'outage-nova'))
check('atlas came back online', state.agents.atlas.alive)
check('nova came back online', state.agents.nova.alive)
check('atlas heartbeat restarted after revival (not just its original one)', ops.log.filter((l) => l[0] === 'heartbeat-start' && l[1] === 'atlas').length >= 2)
check('nova heartbeat restarted after revival (not just its original one)', ops.log.filter((l) => l[0] === 'heartbeat-start' && l[1] === 'nova').length >= 2)

const passed = results.every(Boolean)
console.log(`\nRESULT: ${passed ? 'passed' : 'FAILED'}`)
process.exit(passed ? 0 : 1)
