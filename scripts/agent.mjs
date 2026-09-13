// One agent process. It holds only its own key; peers come from roster.json and everything else from
// Arkiv, Swarm and the power controller at HYDRA_INFRA_URL. Launched by src/fleet.mjs, or by hand on
// any machine that can reach those:
//
//   HYDRA_AGENT_ID=nova HYDRA_RUN_ID=1 HYDRA_INFRA_URL=http://host:3000/infra node --env-file=.env scripts/agent.mjs
//
// Telemetry goes to the launcher over IPC when there is one, otherwise to stdout as JSON lines.

import { makePublicClient, makeAgentSigners } from '../src/arkiv.mjs'
import { createAgent } from '../src/agent.mjs'
import { createDemoOps } from '../src/demo-ops.mjs'

const agentId = process.env.HYDRA_AGENT_ID
const runId = process.env.HYDRA_RUN_ID
const infraUrl = process.env.HYDRA_INFRA_URL
if (!agentId || !runId || !infraUrl) {
  console.error('set HYDRA_AGENT_ID, HYDRA_RUN_ID and HYDRA_INFRA_URL')
  process.exit(1)
}

const httpUrl = process.env.ARKIV_HTTP_URL
const signers = makeAgentSigners({ httpUrl })
if (!signers.has(agentId)) {
  console.error(`set ARKIV_PRIVATE_KEY_${agentId.toUpperCase()}`)
  process.exit(1)
}
for (const id of signers.keys()) {
  if (id !== agentId) console.error(`warning: ${agentId} can see ${id}'s private key; an agent should hold only its own`)
}

const send = (msg) => (process.send ? process.send(msg) : console.log(JSON.stringify(msg)))
const ops = createDemoOps({ pub: makePublicClient({ httpUrl }), signers, infraUrl })

// A launcher that died can't stop its agents any more, so they must not keep writing on their own.
process.on('disconnect', () => process.exit(0))

process.on('message', async (msg) => {
  if (msg?.type !== 'decrypt') return
  try {
    send({ type: 'decrypted', id: msg.id, ok: true, ...(await ops.decrypt(msg.ref)) })
  } catch (e) {
    send({ type: 'decrypted', id: msg.id, ok: false, error: e.message })
  }
})

createAgent({ agentId, runId, ops, send }).start()
