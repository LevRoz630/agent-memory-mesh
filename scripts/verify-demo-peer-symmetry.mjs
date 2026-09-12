// Live check: the demo controller is peer-symmetric. Kill any agent mid-run — including atlas,
// which used to be the only monitor — and its peers must notice the silence on their own, file the
// outage, claim it, fix it, verify it, and bring the agent back.
//
//   node --env-file=.env scripts/verify-demo-peer-symmetry.mjs nova
//   node --env-file=.env scripts/verify-demo-peer-symmetry.mjs atlas

import { makeClients, makeAgentSigners, queryByTagAndType, deleteMemory } from '../src/arkiv.mjs'
import { createDemo } from '../src/demo.mjs'
import { createDemoOps } from '../src/demo-ops.mjs'

const victim = process.argv[2] ?? 'nova'
const httpUrl = process.env.ARKIV_HTTP_URL
const { pub } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY, httpUrl })
const signers = makeAgentSigners({ httpUrl })
const ctx = { pub, signers }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const outageTag = `outage-${victim}`

// Outage rows live for ~20 minutes and a watcher skips a peer that already has one on-chain, so an
// earlier run would otherwise make this script a no-op.
async function clearTag(tag) {
  let cleared = 0
  for (const memoryType of ['event', 'claim', 'done', 'verdict', 'lane', 'heartbeat']) {
    for (const row of await queryByTagAndType(pub, { tag, memoryType })) {
      const owner = [...signers.values()].find((s) => s.account.address.toLowerCase() === row.owner.toLowerCase())
      if (owner) {
        await deleteMemory(owner.wallet, { entityKey: row.key })
        cleared += 1
      }
    }
  }
  return cleared
}

console.log(`demo peer symmetry: kill ${victim}\n`)
const cleared = await clearTag(outageTag)
if (cleared > 0) console.log(`  cleared ${cleared} stale ${outageTag} row(s)`)

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

// Let the watch loops come up and the seeded incident play out before pulling the plug, so the
// outage is the only thing in flight.
await sleep(45000)
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

const passed = results.every(Boolean)
console.log(`\nRESULT: ${passed ? 'passed' : 'FAILED'}`)
process.exit(passed ? 0 : 1)
