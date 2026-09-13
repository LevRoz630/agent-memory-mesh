// Headless run of the same peer-symmetric controller the control room drives: atlas, nova and sol
// as identical peers in one process (so they share one Swarm Stamper), each renewing a heartbeat,
// watching the other two, and claiming/working/verifying incidents. Optional kills cut an agent's
// power a number of seconds in, the way the control room's buttons do. Runs until Ctrl+C.
//
//   node --env-file=.env scripts/orchestrator.mjs [agent@seconds ...]
//
// Example, the double hand-off: node --env-file=.env scripts/orchestrator.mjs atlas@14 nova@60

import { makeClients, makeAgentSigners } from '../src/arkiv.mjs'
import { createDemo } from '../src/demo.mjs'
import { createDemoOps } from '../src/demo-ops.mjs'

const httpUrl = process.env.ARKIV_HTTP_URL
const { pub } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY, httpUrl, wsUrl: process.env.ARKIV_WS_URL })
const signers = makeAgentSigners({ httpUrl })

let printed = 0
const demo = createDemo({
  ops: createDemoOps({ pub, signers }),
  onUpdate: (state) => {
    for (const e of state.timeline.slice(printed)) console.log(`[${e.agentId}] ${e.text}`)
    printed = state.timeline.length
  },
})

for (const arg of process.argv.slice(2)) {
  const [agentId, seconds] = arg.split('@')
  setTimeout(() => demo.kill(agentId), Number(seconds) * 1000)
}

await demo.start()
