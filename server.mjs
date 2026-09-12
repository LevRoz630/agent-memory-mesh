// Local dev entrypoint: the shared REST app plus the live websocket push that the serverless
// deployment (api/index.mjs) can't hold open.

import { createServer } from 'node:http'
import { createECDH } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { createApp, serializeAttrs } from './src/app.mjs'
import { makeClients, makeAgentSigners, watchMemories, AGENT_IDS } from './src/arkiv.mjs'
import { readMemoryContent } from './src/memory.mjs'
import { downloadSealed, decryptWithKey } from './src/swarm.mjs'
import { createDemo } from './src/demo.mjs'
import { createDemoOps } from './src/demo-ops.mjs'

const PORT = process.env.PORT || 3000

const privateKey = process.env.ARKIV_PRIVATE_KEY
if (!privateKey) {
  console.error('set ARKIV_PRIVATE_KEY (a Tiramisu-funded wallet) in the environment')
  process.exit(1)
}

// Reads need a client, not an identity. The funder key is only here to build one.
const { pub, wsClient } = makeClients({ privateKey })

const signers = makeAgentSigners()
if (signers.size === 0) {
  console.error('set ARKIV_PRIVATE_KEY_ATLAS / _NOVA / _SOL — no agent can write without its own signer')
  process.exit(1)
}
for (const [agentId, { account }] of signers) console.log(`signer ${agentId}: ${account.address}`)

const app = createApp({ pub, signers })
const httpServer = createServer(app)
const wss = new WebSocketServer({ server: httpServer, path: '/live' })

const liveClients = new Set()
wss.on('connection', (ws) => {
  liveClients.add(ws)
  ws.send(JSON.stringify({ type: 'connected' }))
  ws.on('close', () => liveClients.delete(ws))
})

function broadcast(msg) {
  const data = JSON.stringify(msg)
  for (const ws of liveClients) {
    if (ws.readyState === ws.OPEN) ws.send(data)
  }
}

const demo = createDemo({
  ops: createDemoOps({ pub, signers }),
  onUpdate: (state) => broadcast({ type: 'demo', state }),
})

app.get('/api/demo/state', (_req, res) => res.json(demo.getState()))

app.post('/api/demo/start', async (_req, res) => {
  try {
    res.json({ state: await demo.start() })
  } catch (e) {
    console.error('demo start failed:', e)
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/demo/kill/:agentId', (req, res) => {
  try {
    res.json({ state: demo.kill(req.params.agentId) })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.get('/api/demo/report', async (req, res) => {
  try {
    const { report } = demo.getState()
    if (!report) return res.status(404).json({ error: 'no incident filed yet' })
    const sealed = await downloadSealed(report.swarmRef)
    const as = String(req.query.as ?? '')
    if (AGENT_IDS.includes(as)) {
      const keyHex = process.env[`ARKIV_PRIVATE_KEY_${as.toUpperCase()}`]
      if (!keyHex) return res.status(400).json({ error: `no key configured for "${as}"` })
      const plaintext = decryptWithKey(sealed, AGENT_IDS.indexOf(as), Buffer.from(keyHex.replace(/^0x/, ''), 'hex'))
      return res.json({ ok: true, as, bytes: sealed.length, report: JSON.parse(plaintext.toString('utf8')) })
    }
    const outsider = createECDH('secp256k1')
    outsider.generateKeys()
    try {
      decryptWithKey(sealed, 0, outsider.getPrivateKey())
      res.status(500).json({ error: 'an outsider key decrypted the report, roster encryption is broken' })
    } catch {
      res.json({
        ok: false, as: 'outsider', bytes: sealed.length,
        ciphertextPreview: sealed.subarray(0, 48).toString('hex'),
        error: "Not on this incident's roster: cannot decrypt.",
      })
    }
  } catch (e) {
    console.error('demo report failed:', e)
    res.status(500).json({ error: e.message })
  }
})

// viem's websocket transport reconnects the socket but does not restore the eth_subscribe
// subscription behind it, so a dropped subscription stays dropped unless we re-arm it.
let unwatch = null
function startWatch() {
  unwatch = watchMemories(wsClient, pub, {
    onEvent: (e) => broadcast({ type: 'log', ...e }),
    onMemory: async ({ entityKey, owner, expiresAt, attributes }) => {
      let content = null
      try {
        content = await readMemoryContent(attributes)
      } catch (e) {
        content = { error: `content unavailable: ${e.message}` }
      }
      console.log(`live: agent_memory written by ${owner}, key=${entityKey}`)
      broadcast({
        type: 'memory', key: entityKey, owner, expiresAt: String(expiresAt),
        attributes: serializeAttrs(attributes),
        content,
      })
    },
    onExtended: ({ entityKey, owner, expiresAt }) => {
      broadcast({ type: 'extended', entityKey, owner, expiresAt: String(expiresAt) })
    },
    onDeleted: ({ entityKey }) => {
      broadcast({ type: 'deleted', entityKey })
    },
    onError: (err) => {
      console.error('watch error:', err.message)
      broadcast({ type: 'watch_error', message: err.message })
      try { unwatch?.() } catch {}
      setTimeout(startWatch, 3000)
    },
  })
}
startWatch()

httpServer.listen(PORT, () => console.log(`listening on http://localhost:${PORT}`))
