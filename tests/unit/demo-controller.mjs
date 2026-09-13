// The demo controller against fake ops: kill the claim holder mid-work, the survivor must wait for
// the lease to lapse, take over, and resume from the dead agent's progress. No network, no env vars.
//
//   node tests/unit/demo-controller.mjs

import { createDemo, WORK_STEPS } from '../../src/demo.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeOps({ leaseMs, verifyFails = false, loseLeaseFor = null }) {
  const log = []
  const steps = []
  // Watch callbacks are kept so a test can fire an outage on demand, the way a real peer-watch loop
  // would once a heartbeat lapses.
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
      if (verifyFails) throw new Error('no signer configured')
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
      let ticks = 0
      while (shouldContinue()) {
        await sleep(leaseMs / 3)
        if (!shouldContinue()) return { lost: false }
        ticks += 1
        // Stands in for the engine rejecting the extension because the claim already expired: the
        // row is gone and renewClaim() reports the loss instead of throwing.
        if (loseLeaseFor === agentId && ticks >= 2) {
          for (const [tag, held] of claims) if (held.agentId === agentId) claims.delete(tag)
          log.push(['lease-lost', agentId])
          return { lost: true }
        }
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

console.log('demo controller: atlas works first, dies, nova resumes, dies, sol finishes\n')

const ops = fakeOps({ leaseMs: 150 })
// Sol starts late enough that nova, not sol, is the one to pick up after atlas.
const demo = createDemo({ ops, timings: { stepMs: 60, retryMs: 20, verifyPollMs: 20, watchStartDelayMs: 20, reportDelayMs: 0, startDelayMs: { atlas: 0, nova: 40, sol: 500 } } })

await demo.start()
await waitFor(() => ops.log.some((l) => l[0] === 'report'), 'atlas to file the rack incident')
check('run is running', demo.getState().phase === 'running')

const atlasClaim = () => ops.log.find((l) => l[0] === 'claim' && l[3] === demo.getState().tag)
await waitFor(() => atlasClaim(), 'someone to claim the rack incident')
check('atlas takes the first claim', atlasClaim()[1] === 'atlas')

await waitFor(() => ops.steps.some((s) => s.agentId === 'atlas'), 'atlas to complete a step')
demo.kill('atlas')
check('atlas marked dead', demo.getState().agents.atlas.status === 'dead')
const atlasSteps = ops.steps.filter((s) => s.agentId === 'atlas').length

await waitFor(() => ops.steps.some((s) => s.agentId === 'nova'), 'nova to resume and complete a step', 5000)
demo.kill('nova')
const killedAt = Date.now()
const novaSteps = ops.steps.filter((s) => s.agentId === 'nova').length

await waitFor(() => demo.getState().phase === 'resolved', 'the incident to resolve', 5000)
await sleep(50)
const state = demo.getState()
const solClaim = ops.log.find((l) => l[0] === 'claim' && l[1] === 'sol')
const mainSteps = ops.steps.filter((s) => s.tag === state.tag)

check('sol finished the incident', state.agents.sol.status === 'done')
check('DC-2 stays down', !state.agents.nova.alive)
check('sol claimed only after nova went down', solClaim && solClaim[2] >= killedAt)
check('dead atlas and nova never finished', !ops.log.some((l) => l[0] === 'finish' && l[1] !== 'sol'))
check('every step done exactly once, in order', JSON.stringify(mainSteps.map((s) => s.step)) === JSON.stringify(WORK_STEPS.map((_, i) => i)))
check('nova resumed where atlas stopped', mainSteps.find((s) => s.agentId === 'nova')?.step === atlasSteps)
check('sol resumed where nova stopped', mainSteps.find((s) => s.agentId === 'sol')?.step === atlasSteps + novaSteps)
check('timeline records the resume', state.timeline.some((e) => e.agentId === 'sol' && e.text.includes('resuming')))
check('killing an unknown agent throws', (() => { try { demo.kill('mallory'); return false } catch { return true } })())
check('every agent runs a heartbeat', ['atlas', 'nova', 'sol'].every((id) => ops.log.some((l) => l[0] === 'heartbeat-start' && l[1] === id)))
check('a killed agent stops beating', ops.log.some((l) => l[0] === 'heartbeat-stop' && l[1] === 'nova'))
// The seeded incident is about a rack, not an agent: resolving it must not resurrect an agent that
// went down for an unrelated reason and that no peer has filed an outage for yet.
check('a killed agent is NOT revived by an unrelated incident resolving', !state.agents.atlas.alive)

console.log('\nscenario: a peer notices the silence and DC-1 comes back the honest way\n')

ops.watchers.get('sol')('atlas', 'outage-atlas')
await waitFor(() => demo.getState().agents.atlas.alive, 'the outage flow to bring atlas back', 5000)
const recovered = demo.getState()

await waitFor(() => ops.log.some((l) => l[0] === 'verify' && l[2] === state.tag), 'a revived peer to verify the rack incident')
check('the rack incident is verified by a revived peer, not by sol who fixed it', ops.log.find((l) => l[0] === 'verify' && l[2] === state.tag)[1] === 'atlas')
check('a peer worked the outage incident', ops.log.some((l) => l[0] === 'finish' && l[1] === 'sol' && l[2] === 'outage-atlas'))
check('the outage is tracked as its own incident', recovered.incidents['outage-atlas']?.phase === 'resolved')
check('the seeded incident is untouched by the outage work', recovered.incidents[recovered.tag].stepsDone === WORK_STEPS.length)
check('DC-1 comes back online once its own outage is fixed', recovered.agents.atlas.status === 'watching')
check('timeline records DC-1 coming back', recovered.timeline.some((e) => e.agentId === 'atlas' && e.text.includes('back online')))

await waitFor(() => ops.log.some((l) => l[0] === 'verify'), 'someone to verify a resolved incident')
const verdict = ops.log.find((l) => l[0] === 'verify')
check('the verdict is written by an agent other than the finisher', verdict[1] !== 'sol')

console.log('\nscenario: a permanently failing verify gives up instead of logging forever\n')

const opsF = fakeOps({ leaseMs: 150, verifyFails: true })
const demoF = createDemo({ ops: opsF, timings: { stepMs: 20, retryMs: 20, verifyPollMs: 20, watchStartDelayMs: 20, reportDelayMs: 0, startDelayMs: { nova: 0, sol: 40 } } })
await demoF.start()
await waitFor(() => demoF.getState().phase === 'resolved', 'the incident to resolve (verify-failure test)', 5000)
const countVerifyEvents = () => demoF.getState().timeline.filter((e) => /verif/.test(e.text)).length
await sleep(400)
const afterFirstWait = countVerifyEvents()
await sleep(600)
const afterSecondWait = countVerifyEvents()

check('a failing verify stops retrying', afterSecondWait === afterFirstWait)
check('a failing verify logs a bounded number of events', afterSecondWait > 0 && afterSecondWait <= 4)
check('the last word is that it gave up', demoF.getState().timeline.some((e) => e.text.includes('gave up verifying')))

console.log('\nscenario: a lapsed lease mid-work drops the claim instead of crashing the worker\n')

const opsL = fakeOps({ leaseMs: 150, loseLeaseFor: 'nova' })
const demoL = createDemo({ ops: opsL, timings: { stepMs: 60, retryMs: 20, verifyPollMs: 20, watchStartDelayMs: 20, reportDelayMs: 0, startDelayMs: { atlas: 400, nova: 0, sol: 40 } } })
await demoL.start()
await waitFor(() => opsL.log.some((l) => l[0] === 'lease-lost' && l[1] === 'nova'), 'nova to lose its lease', 5000)
await waitFor(() => demoL.getState().phase === 'resolved', 'the incident to resolve after the lapse', 5000)
const lapsed = demoL.getState()
const lapsedSteps = opsL.steps.filter((s) => s.tag === lapsed.tag)

check('the worker whose lease lapsed said so and dropped the claim', lapsed.timeline.some((e) => e.agentId === 'nova' && e.text.includes('lapsed before the work finished')))
check('a lapsed lease is not reported as a crash', !lapsed.timeline.some((e) => e.text.startsWith('error:')) && !Object.values(lapsed.agents).some((a) => a.status === 'error'))
check('the incident still resolved', lapsed.phase === 'resolved')
check('every step still done exactly once, in order', JSON.stringify(lapsedSteps.map((s) => s.step)) === JSON.stringify(WORK_STEPS.map((_, i) => i)))

// This demo instance also resolves the unrelated `outage-atlas` incident triggered above (line
// 145), and every resolved incident now publishes its own receipt under peer symmetry. `run`
// only tracks one `receiptRef`, last-writer-wins across incidents -- so wait for THIS tag's own
// publishReceipt call, not the shared field, or the wait can resolve on the other incident's.
await waitFor(() => ops.log.some((l) => l[0] === 'publishReceipt' && l[1] === state.tag), 'receipt to be published')
const stateAfterReceipt = demo.getState()
const receiptCallsForTag = ops.log.filter((l) => l[0] === 'publishReceipt' && l[1] === state.tag)
const receiptForTag = ops.receipts.find((r) => r.tag === state.tag)
check('receipt published exactly once for this incident', receiptCallsForTag.length === 1)
check('receipt published with phase resolved', receiptForTag?.phase === 'resolved')
check('receipt published with a timeline containing "back online"', receiptForTag?.timeline.some((e) => e.text.includes('back online')))
check('state.receiptRef equals the returned ref', stateAfterReceipt.receiptRef === 'cd'.repeat(32))
check('timeline logs the published receipt event', stateAfterReceipt.timeline.some((e) => e.text.includes('published a public receipt')))

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
  async nextLaneIndex() {
    return 0
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
  timings: { stepMs: 60, retryMs: 20, reportDelayMs: 0, startDelayMs: { atlas: 0, nova: 40, sol: 80 } }
})

await demo2.start()
const firstTag = demo2.getState().tag
await waitFor(() => demo2.getState().agents.atlas.status === 'working', 'atlas to start working (restart test)')

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
const demo3 = createDemo({ ops: ops3, timings: { stepMs: 20, retryMs: 10, reportDelayMs: 0, startDelayMs: { nova: 0, sol: 1000 } } })

await demo3.start()
await waitFor(() => demo3.getState().phase === 'resolved', 'the incident to resolve (receipt-failure scenario)')
await sleep(50)
const state3 = demo3.getState()

check('phase stays resolved when publishReceipt throws', state3.phase === 'resolved')
check('failure is logged in the timeline', state3.timeline.some((e) => e.text.includes('receipt upload failed')))

console.log('\nscenario: DC-1 loses power before atlas files anything\n')

const opsE = fakeOps({ leaseMs: 150 })
const demoE = createDemo({ ops: opsE, timings: { stepMs: 20, retryMs: 20, verifyPollMs: 20, watchStartDelayMs: 20, reportDelayMs: 100 } })
await demoE.start()
demoE.kill('atlas')
await waitFor(() => opsE.watchers.has('nova') && opsE.watchers.has('sol'), 'nova and sol to start watching')
await sleep(150)
check('a dark DC-1 files no rack incident', !opsE.log.some((l) => l[0] === 'report') && !demoE.getState().report)
opsE.watchers.get('nova')('atlas', 'outage-atlas-run-a', { filed: true, location: 'DC-1 Frankfurt' })
opsE.watchers.get('sol')('atlas', 'outage-atlas-run-a', { filed: false })
await waitFor(() => demoE.getState().agents.atlas.alive, "atlas's outage to bring it back", 5000)
check("atlas's outage is its only incident", Object.keys(demoE.getState().incidents).join() === 'outage-atlas-run-a')
check('the filer is recorded as the detector', demoE.getState().incidents['outage-atlas-run-a'].detectedBy === 'nova')
check("the outage carries atlas's last known location", demoE.getState().incidents['outage-atlas-run-a'].location === 'DC-1 Frankfurt')
check('the timeline says where the silent agent was', demoE.getState().timeline.some((e) => e.text.includes('last beat from DC-1 Frankfurt')))

console.log('\nscenario: the agent that filed an outage dies before fixing it\n')

const opsO = fakeOps({ leaseMs: 150 })
const demoO = createDemo({ ops: opsO, timings: { stepMs: 60, retryMs: 20, verifyPollMs: 20, watchStartDelayMs: 20, reportDelayMs: 5000, startDelayMs: { atlas: 5000, nova: 5000, sol: 5000 } } })
await demoO.start()
await waitFor(() => opsO.watchers.has('nova') && opsO.watchers.has('sol'), 'nova and sol to start watching')
demoO.kill('atlas')
opsO.watchers.get('nova')('atlas', 'outage-atlas-run-b')
opsO.watchers.get('sol')('atlas', 'outage-atlas-run-b', { filed: false })
await waitFor(() => opsO.log.some((l) => l[0] === 'claim' && l[3] === 'outage-atlas-run-b'), 'a peer to claim the outage')
const firstHolder = opsO.log.find((l) => l[0] === 'claim' && l[3] === 'outage-atlas-run-b')[1]
const other = firstHolder === 'nova' ? 'sol' : 'nova'
demoO.kill(firstHolder)
await waitFor(() => demoO.getState().agents.atlas.alive, 'the surviving peer to finish the outage and revive atlas', 5000)
check('the peer that did not file still picked the outage up', opsO.log.some((l) => l[0] === 'finish' && l[1] === other && l[2] === 'outage-atlas-run-b'))

const passed = results.every(Boolean)
console.log(`\nRESULT: ${passed ? 'passed' : 'FAILED'}`)
process.exit(passed ? 0 : 1)
