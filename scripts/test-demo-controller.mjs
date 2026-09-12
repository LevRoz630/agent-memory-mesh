// The demo controller against fake ops: kill the claim holder mid-work, the survivor must wait for
// the lease to lapse, take over, and resume from the dead agent's progress. No network, no env vars.
//
//   node scripts/test-demo-controller.mjs

import { createDemo, WORK_STEPS } from '../src/demo.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeOps({ leaseMs }) {
  const log = []
  const steps = []
  let claim = null
  let done = false
  return {
    log,
    steps,
    async startHeartbeat(agentId, shouldContinue) {
      log.push(['heartbeat-start', agentId])
      while (shouldContinue()) await sleep(5)
      log.push(['heartbeat-stop', agentId])
    },
    watchForPeerOutages() {
      return () => {}
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
      if (done) return { held: false }
      if (claim && claim.expiresAt > Date.now()) return { held: false }
      claim = { agentId, expiresAt: Date.now() + leaseMs }
      log.push(['claim', agentId, Date.now()])
      return { held: true, entityKey: `claim-${agentId}` }
    },
    async renewClaim(agentId, _entityKey, shouldContinue) {
      while (shouldContinue()) {
        await sleep(leaseMs / 3)
        if (!shouldContinue()) return
        if (claim?.agentId === agentId) claim.expiresAt = Date.now() + leaseMs
      }
    },
    async readProgress(tag) {
      return steps.length
    },
    async recordStep(agentId, tag, step) {
      steps.push({ agentId, step })
    },
    async finish(agentId, tag, entityKey) {
      done = true
      claim = null
      log.push(['finish', agentId])
    },
    async isDone(tag) {
      return done
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

console.log('demo controller: kill, lapse, takeover, resume\n')

const ops = fakeOps({ leaseMs: 150 })
const demo = createDemo({ ops, timings: { stepMs: 60, retryMs: 20, verifyPollMs: 20, startDelayMs: { nova: 0, sol: 40 } } })

await demo.start()
check('report filed at start', ops.log.some((l) => l[0] === 'report'))
check('run is running', demo.getState().phase === 'running')

await waitFor(() => demo.getState().agents.nova.status === 'working', 'nova to start working')
demo.kill('atlas')
check('atlas marked dead', demo.getState().agents.atlas.status === 'dead')

await waitFor(() => ops.steps.length >= 1, 'nova to complete a step')
demo.kill('nova')
const killedAt = Date.now()
const novaSteps = ops.steps.filter((s) => s.agentId === 'nova').length

await waitFor(() => demo.getState().phase === 'resolved', 'the incident to resolve', 5000)
const state = demo.getState()
const solClaim = ops.log.find((l) => l[0] === 'claim' && l[1] === 'sol')

check('sol finished the incident', state.agents.sol.status === 'done')
check('DC-1 comes back online once its rack is recovered', state.agents.atlas.alive && state.agents.atlas.status === 'watching')
check('timeline records DC-1 coming back', state.timeline.some((e) => e.agentId === 'atlas' && e.text.includes('back online')))
check('DC-2 stays down', !state.agents.nova.alive)
check('sol claimed only after nova went down', solClaim && solClaim[2] >= killedAt)
check('dead nova never finished', !ops.log.some((l) => l[0] === 'finish' && l[1] === 'nova'))
check('every step done exactly once, in order', JSON.stringify(ops.steps.map((s) => s.step)) === JSON.stringify(WORK_STEPS.map((_, i) => i)))
check('sol resumed where nova stopped', ops.steps.find((s) => s.agentId === 'sol')?.step === novaSteps)
check('timeline records the resume', state.timeline.some((e) => e.agentId === 'sol' && e.text.includes('resuming')))
check('killing an unknown agent throws', (() => { try { demo.kill('mallory'); return false } catch { return true } })())
check('every agent runs a heartbeat', ['atlas', 'nova', 'sol'].every((id) => ops.log.some((l) => l[0] === 'heartbeat-start' && l[1] === id)))
check('a killed agent stops beating', ops.log.some((l) => l[0] === 'heartbeat-stop' && l[1] === 'nova'))

await waitFor(() => ops.log.some((l) => l[0] === 'verify'), 'someone to verify the resolved incident')
const verdict = ops.log.find((l) => l[0] === 'verify')
check('the verdict is written by an agent other than the finisher', verdict[1] !== 'sol')

console.log('\nscenario: restart mid-run\n')

const protocolCalls = []
const ops2 = {
  log: [],
  steps: [],
  async startHeartbeat(_agentId, shouldContinue) {
    while (shouldContinue()) await sleep(5)
  },
  watchForPeerOutages() {
    return () => {}
  },
  async verify(agentId, tag) {
    protocolCalls.push({ op: 'verify', tag })
    return { outcome: 'fixed' }
  },
  async reportIncident(tag) {
    protocolCalls.push({ op: 'reportIncident', tag })
    this.log.push(['report', tag])
    return { swarmRef: 'ab'.repeat(32), entityKey: '0x' + '1'.repeat(64) }
  },
  async tryClaim(agentId, tag) {
    protocolCalls.push({ op: 'tryClaim', tag })
    await sleep(5)
    if (this.done) return { held: false }
    if (this.claim && this.claim.expiresAt > Date.now()) return { held: false }
    this.claim = { agentId, expiresAt: Date.now() + 150 }
    this.log.push(['claim', agentId, Date.now()])
    return { held: true, entityKey: `claim-${agentId}` }
  },
  async renewClaim(agentId, _entityKey, shouldContinue) {
    while (shouldContinue()) {
      await sleep(50)
      if (!shouldContinue()) return
      if (this.claim?.agentId === agentId) this.claim.expiresAt = Date.now() + 150
    }
  },
  async readProgress(tag) {
    protocolCalls.push({ op: 'readProgress', tag })
    return this.steps.length
  },
  async recordStep(agentId, tag, step) {
    protocolCalls.push({ op: 'recordStep', tag })
    this.steps.push({ agentId, step })
  },
  async finish(agentId, tag, entityKey) {
    protocolCalls.push({ op: 'finish', tag })
    this.done = true
    this.claim = null
    this.log.push(['finish', agentId])
  },
  async isDone(tag) {
    protocolCalls.push({ op: 'isDone', tag })
    return this.done
  },
  claim: null,
  done: false
}

const demo2 = createDemo({
  ops: ops2,
  timings: { stepMs: 60, retryMs: 20, startDelayMs: { nova: 0, sol: 40 } }
})

await demo2.start()
const firstTag = demo2.getState().tag
await waitFor(() => demo2.getState().agents.nova.status === 'working', 'nova to start working (restart test)')

await demo2.start()
const secondTag = demo2.getState().tag

await sleep(200)
const callsWithFirstTagAfterRestart = protocolCalls.filter((c) => c.tag === firstTag).length

await sleep(200)

const state2 = demo2.getState()
const callsWithFirstTagFinal = protocolCalls.filter((c) => c.tag === firstTag).length

check('restart creates a new run', secondTag !== firstTag)
check('restart revives every agent', state2.agents.atlas.alive && state2.agents.nova.alive && state2.agents.sol.alive)
check('superseded run makes no further protocol calls', callsWithFirstTagFinal === callsWithFirstTagAfterRestart)

const passed = results.every(Boolean)
console.log(`\nRESULT: ${passed ? 'passed' : 'FAILED'}`)
process.exit(passed ? 0 : 1)
