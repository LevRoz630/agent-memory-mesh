// Live check: the demo controller is peer-symmetric. Kill any agent mid-run — including atlas,
// which used to be the only monitor — and its peers must notice the silence on their own, file the
// outage, claim it, fix it, verify it, and bring the agent back.
//
//   node --env-file=.env scripts/verify-demo-peer-symmetry.mjs nova
//   node --env-file=.env scripts/verify-demo-peer-symmetry.mjs atlas
//
// `--early` pulls the plug while the seeded incident is still open, so the agent can only come back
// through its own outage incident — never as a side effect of the seeded one resolving.
// `--before-report` cuts atlas before it can file the rack incident at all.

import { makeClients, makeAgentSigners, queryByTagAndType } from '../src/arkiv.mjs'
import { createDemo } from '../src/demo.mjs'
import { createDemoOps } from '../src/demo-ops.mjs'

const victim = process.argv[2] ?? 'nova'
const early = process.argv.includes('--early')
const httpUrl = process.env.ARKIV_HTTP_URL
const { pub } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY, httpUrl })
const signers = makeAgentSigners({ httpUrl })
const ctx = { pub, signers }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
console.log(`demo peer symmetry: kill ${victim}\n`)

let printed = 0
const demo = createDemo({
  ops: createDemoOps(ctx),
  timings: { stepMs: 2000, retryMs: 3000, verifyPollMs: 4000, watchStartDelayMs: 20000 },
  onUpdate: (s) => {
    for (const e of s.timeline.slice(printed)) console.log(`  [${e.agentId}] ${e.text}`)
    printed = s.timeline.length
  },
})

async function waitFor(cond, what, timeoutMs) {
  const started = Date.now()
  while (!(await cond())) {
    if (Date.now() - started > timeoutMs) {
      console.log(`  TIMED OUT waiting for ${what}`)
      return false
    }
    await sleep(2000)
  }
  return true
}

await demo.start()

// Normally the seeded incident is allowed to play out first, so the outage is the only thing in
// flight. `--early` cuts power while it is still open, which is the case that used to bring the
// victim back through the seeded incident's revival instead of through real detection.
await sleep(process.argv.includes('--before-report') ? 1000 : early ? 8000 : 45000)
console.log(`\n  --- cutting power to ${victim} ---`)
demo.kill(victim)

const heartbeatStopped = await waitFor(
  async () => (await queryByTagAndType(pub, { tag: `agent-${victim}`, memoryType: 'heartbeat', limit: 1 })).length === 0,
  `${victim}'s heartbeat to lapse`, 90000,
)

const detected = await waitFor(
  () => demo.getState().timeline.some((e) => e.agentId !== victim && e.text.includes(`noticed ${victim} stopped beating`)),
  `a peer to notice ${victim} is silent`, 120000,
)

const outageTag = Object.values(demo.getState().incidents).find((i) => i.subject === victim)?.tag ?? `outage-${victim}-(not filed)`
const claimed = await waitFor(
  () => demo.getState().timeline.some((e) => e.agentId !== victim && e.text.includes(`claimed ${outageTag}`)),
  `a peer to claim ${outageTag}`, 120000,
)

const resolved = await waitFor(
  () => demo.getState().timeline.some((e) => e.text.includes(`${outageTag} resolved`)),
  `${outageTag} to be resolved`, 180000,
)

const verdicts = []
const verified = await waitFor(
  async () => {
    const rows = await queryByTagAndType(pub, { tag: outageTag, memoryType: 'verdict', limit: 1 })
    verdicts.push(...rows)
    return rows.length > 0
  },
  `a verdict on ${outageTag}`, 120000,
)

const backOnline = demo.getState().agents[victim].alive

const state = demo.getState()
const detector = state.timeline.find((e) => e.text.includes(`noticed ${victim} stopped beating`))?.agentId
const fixer = state.timeline.find((e) => e.text.includes(`claimed ${outageTag}`))?.agentId
const verifier = state.timeline.find((e) => e.text.startsWith(`verified ${outageTag}`))?.agentId

console.log('')
const results = []
const check = (name, ok) => {
  results.push(Boolean(ok))
  console.log(`  ${ok ? 'pass' : 'FAIL'}: ${name}`)
}
check(`${victim}'s heartbeat stopped after the kill`, heartbeatStopped)
check(`a peer detected the outage (${detector})`, detected && detector !== victim)
check(`a peer claimed and fixed it (${fixer})`, claimed && resolved && fixer !== victim)
check(`a verdict was written (${verifier ?? 'n/a'}: ${verdicts[0]?.content?.outcome ?? 'see chain'})`, verified)
check(`${victim} is back online`, backOnline)

// The revival has to be a consequence of the outage incident, not of anything else resolving.
const texts = state.timeline.map((e) => `${e.agentId}|${e.text}`)
// Match the revival message, not WORK_STEPS' "confirm servers back online".
const cameBackAt = texts.findIndex((x) => x.startsWith(`${victim}|`) && x.includes('is watching again'))
const claimedAt = texts.findIndex((x) => x.includes(`claimed ${outageTag}`))
check(
  `${victim} came back only after its own outage was worked (claimed@${claimedAt}, back@${cameBackAt})`,
  cameBackAt > -1 && claimedAt > -1 && cameBackAt > claimedAt,
)

const passed = results.every(Boolean)
console.log(`\nRESULT: ${passed ? 'passed' : 'FAILED'}`)
process.exit(passed ? 0 : 1)
