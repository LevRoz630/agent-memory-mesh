// Stands in for scripts/agent.mjs in tests/unit/fleet.mjs: reports which keys it was given and stays up.

const keys = Object.keys(process.env).filter((name) => name.startsWith('ARKIV_PRIVATE_KEY'))
process.send({ type: 'event', at: Date.now(), agentId: process.env.HYDRA_AGENT_ID, text: `keys:${keys.join(',')}`, pid: process.pid })
process.send({ type: 'status', status: 'watching' })
process.on('message', (msg) => {
  if (msg.type === 'decrypt') process.send({ type: 'decrypted', id: msg.id, ok: true, bytes: 1, report: { by: process.env.HYDRA_AGENT_ID } })
})
setInterval(() => {}, 1000)
