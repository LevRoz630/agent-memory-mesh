// Headless run of the control room: boots the server, which launches atlas, nova and sol as separate
// processes, starts a run and prints the timeline. Optional kills cut an agent's power a number of
// seconds in, through the same endpoint as the control room's buttons. Runs until Ctrl+C.
//
//   node --env-file=.env scripts/orchestrator.mjs [agent@seconds ...]
//
// Example, the double hand-off: node --env-file=.env scripts/orchestrator.mjs atlas@14 nova@60

import { bootControlRoom } from '../src/control-client.mjs'

let printed = 0
const room = await bootControlRoom({
  port: Number(process.env.PORT ?? 3999),
  onState: (state) => {
    for (const e of state.timeline.slice(printed)) console.log(`[${e.agentId}] ${e.text}`)
    printed = state.timeline.length
  },
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    room.stop()
    process.exit(0)
  })
}

for (const arg of process.argv.slice(2)) {
  const [agentId, seconds] = arg.split('@')
  setTimeout(() => room.kill(agentId).catch((e) => console.error(e.message)), Number(seconds) * 1000)
}

await room.start()
