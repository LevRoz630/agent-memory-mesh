// Live check of the independent agent processes: boot the server, let atlas file the rack incident,
// cut one agent's power, and confirm on Arkiv — not from the launcher's state — that a peer filed
// the outage, finished it, powered the DC back on, and that someone other than the finisher verified.
//
//   node --env-file=.env tests/live/fleet.mjs [atlas|nova|sol]

import { makePublicClient, queryByTagAndType, queryByTagPrefixAndType } from '../../src/arkiv.mjs'
import { outageTagPrefix } from '../../src/protocol.mjs'
import { ROSTER } from '../../src/roster.mjs'
import { bootControlRoom } from '../../src/control-client.mjs'

const victim = process.argv[2] ?? 'atlas'
const pub = makePublicClient({ httpUrl: process.env.ARKIV_HTTP_URL })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ownerOf = (row) => Object.keys(ROSTER).find((id) => ROSTER[id].address.toLowerCase() === row.owner.toLowerCase())

let latest = null
let printed = 0
const room = await bootControlRoom({
  onState: (state) => {
    latest = state
    for (const e of state.timeline.slice(printed)) console.log(`  [${e.agentId}] ${e.text}`)
    printed = state.timeline.length
  },
})

async function waitFor(cond, what, timeoutMs) {
  const started = Date.now()
  while (!(await cond())) {
    if (Date.now() - started > timeoutMs) {
      console.log(`  TIMED OUT waiting for ${what}`)
      return false
    }
    await sleep(3000)
  }
  return true
}

const results = []
const check = (name, ok) => {
  results.push(Boolean(ok))
  console.log(`  ${ok ? 'pass' : 'FAIL'}: ${name}`)
}

try {
  const { state } = await room.start()
  const runId = state.id
  const rackTag = state.tag

  const filed = await waitFor(async () => (await queryByTagAndType(pub, { tag: rackTag, memoryType: 'event', limit: 1 })).length > 0, 'the rack incident on Arkiv', 120000)
  check('the rack incident is on Arkiv', filed)
  const rackEvent = (await queryByTagAndType(pub, { tag: rackTag, memoryType: 'event', limit: 1 }))[0]
  check('it was written by atlas\'s own wallet', rackEvent && ownerOf(rackEvent) === 'atlas')

  await sleep(15000)
  console.log(`\n  --- cutting power to ${victim} ---\n`)
  await room.kill(victim)

  const prefix = outageTagPrefix(victim, runId)
  const outageFiled = await waitFor(async () => (await queryByTagPrefixAndType(pub, { tagPrefix: prefix, memoryType: 'event' })).length > 0, `${victim}'s outage on Arkiv`, 180000)
  const outageEvent = (await queryByTagPrefixAndType(pub, { tagPrefix: prefix, memoryType: 'event' }))[0]
  check(`a peer filed ${victim}'s outage (${outageEvent ? ownerOf(outageEvent) : 'none'})`, outageFiled && ownerOf(outageEvent) !== victim)

  const outageTag = outageEvent?.attributes.tag
  const outageDone = await waitFor(async () => outageTag && (await queryByTagAndType(pub, { tag: outageTag, memoryType: 'done', limit: 1 })).length > 0, `a done row for ${outageTag}`, 240000)
  const doneRow = outageTag ? (await queryByTagAndType(pub, { tag: outageTag, memoryType: 'done', limit: 1 }))[0] : null
  check(`a peer finished the outage (${doneRow ? ownerOf(doneRow) : 'none'})`, outageDone && ownerOf(doneRow) !== victim)

  const back = await waitFor(async () => (await queryByTagAndType(pub, { tag: `agent-${victim}`, memoryType: 'heartbeat', limit: 1 })).length > 0, `${victim} beating again`, 120000)
  check(`${victim}'s new process is beating on Arkiv`, back)

  const verdict = await waitFor(async () => outageTag && (await queryByTagAndType(pub, { tag: outageTag, memoryType: 'verdict', limit: 1 })).length > 0, `a verdict on ${outageTag}`, 120000)
  const verdictRow = outageTag ? (await queryByTagAndType(pub, { tag: outageTag, memoryType: 'verdict', limit: 1 }))[0] : null
  check(`the verdict (${verdictRow?.attributes.outcome}) came from someone other than the finisher (${verdictRow ? ownerOf(verdictRow) : 'none'})`,
    verdict && ownerOf(verdictRow) !== ownerOf(doneRow))

  const rackDone = await waitFor(async () => (await queryByTagAndType(pub, { tag: rackTag, memoryType: 'verdict', limit: 1 })).length > 0, 'a verdict on the rack incident', 300000)
  check('the rack incident was finished and verified', rackDone)
  check('the control room shows every agent alive', latest && Object.values(latest.agents).every((a) => a.alive))
} finally {
  room.stop()
}

const passed = results.every(Boolean)
console.log(`\nRESULT: ${passed ? 'passed' : 'FAILED'}`)
process.exit(passed ? 0 : 1)
