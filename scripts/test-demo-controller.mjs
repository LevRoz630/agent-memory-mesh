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

console.log('demo controller: kill, lapse, takeover, resume\n')

const ops = fakeOps({ leaseMs: 150 })
const demo = createDemo({ ops, timings: { stepMs: 60, retryMs: 20, startDelayMs: { nova: 0, sol: 40 } } })

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

await waitFor(() => state.receiptRef !== undefined && demo.getState().receiptRef !== null, 'receipt to be published')
const stateAfterReceipt = demo.getState()
const receiptCalls = ops.log.filter((l) => l[0] === 'publishReceipt')
check('receipt published exactly once', receiptCalls.length === 1)
check('receipt published with phase resolved', ops.receipts[0]?.phase === 'resolved')
check('receipt published with a timeline containing "back online"', ops.receipts[0]?.timeline.some((e) => e.text.includes('back online')))
check('state.receiptRef equals the returned ref', stateAfterReceipt.receiptRef === 'cd'.repeat(32))
check('timeline logs the published receipt event', stateAfterReceipt.timeline.some((e) => e.text.includes('published a public receipt')))

console.log('\nscenario: restart mid-run\n')

const protocolCalls = []
const ops2 = {
  log: [],
  steps: [],
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
  async publishReceipt(state) {
    protocolCalls.push({ op: 'publishReceipt', tag: state.tag })
    this.log.push(['publishReceipt', state.tag])
    return 'cd'.repeat(32)
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

console.log('\nscenario: publishReceipt fails\n')

const ops3 = fakeOps({ leaseMs: 150 })
ops3.publishReceipt = async (state) => { throw new Error('gateway unreachable') }
const demo3 = createDemo({ ops: ops3, timings: { stepMs: 20, retryMs: 10, startDelayMs: { nova: 0, sol: 1000 } } })

await demo3.start()
await waitFor(() => demo3.getState().phase === 'resolved', 'the incident to resolve (receipt-failure scenario)')
await sleep(50)
const state3 = demo3.getState()

check('phase stays resolved when publishReceipt throws', state3.phase === 'resolved')
check('failure is logged in the timeline', state3.timeline.some((e) => e.text.includes('receipt upload failed')))

const passed = results.every(Boolean)
console.log(`\nRESULT: ${passed ? 'passed' : 'FAILED'}`)
process.exit(passed ? 0 : 1)
