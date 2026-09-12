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
    async tryClaim(agentId) {
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
    async readProgress() {
      return steps.length
    },
    async recordStep(agentId, _tag, step) {
      steps.push({ agentId, step })
    },
    async finish(agentId) {
      done = true
      claim = null
      log.push(['finish', agentId])
    },
    async isDone() {
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
check('sol claimed only after nova went down', solClaim && solClaim[2] >= killedAt)
check('dead nova never finished', !ops.log.some((l) => l[0] === 'finish' && l[1] === 'nova'))
check('every step done exactly once, in order', JSON.stringify(ops.steps.map((s) => s.step)) === JSON.stringify(WORK_STEPS.map((_, i) => i)))
check('sol resumed where nova stopped', ops.steps.find((s) => s.agentId === 'sol')?.step === novaSteps)
check('timeline records the resume', state.timeline.some((e) => e.agentId === 'sol' && e.text.includes('resuming')))
check('killing an unknown agent throws', (() => { try { demo.kill('mallory'); return false } catch { return true } })())

console.log('\nscenario: restart mid-run\n')

const ops2 = fakeOps({ leaseMs: 150 })
const recordedTags = []
const demo2 = createDemo({
  ops: ops2,
  onUpdate: (state) => recordedTags.push(state.tag),
  timings: { stepMs: 60, retryMs: 20, startDelayMs: { nova: 0, sol: 40 } }
})

await demo2.start()
const firstTag = demo2.getState().tag
await waitFor(() => demo2.getState().agents.nova.status === 'working', 'nova to start working (restart test)')

await demo2.start()
const secondTag = demo2.getState().tag
const secondStartTime = parseInt(secondTag.split('-')[1])
const updateCountAtSecondStart = recordedTags.length

await sleep(300)

const state2 = demo2.getState()
const updatesAfterRestart = recordedTags.slice(updateCountAtSecondStart)

check('restart creates a new run', secondTag !== firstTag)
check('restart revives every agent', state2.agents.atlas.alive && state2.agents.nova.alive && state2.agents.sol.alive)
check('superseded run no longer emits', !updatesAfterRestart.some((tag) => tag === firstTag))
check('second run timeline has no entries before second start', state2.timeline.every((e) => e.at >= secondStartTime))

const passed = results.every(Boolean)
console.log(`\nRESULT: ${passed ? 'passed' : 'FAILED'}`)
process.exit(passed ? 0 : 1)
