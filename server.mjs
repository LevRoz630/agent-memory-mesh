// Entrypoint: the shared REST app plus the control room's demo endpoints, with demo state pushed
// over the websocket on /live.

import { createServer } from 'node:http'
import { createECDH, timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { createApp } from './src/app.mjs'
import { makeClients, makeAgentSigners, AGENT_IDS } from './src/arkiv.mjs'
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
const { pub } = makeClients({ privateKey })

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

function requireDemoPassword(req, res, next) {
  const expected = process.env.DEMO_PASSWORD
  if (!expected) return next()
  const got = req.get('x-demo-password') ?? ''
  const expectedBuf = Buffer.from(expected)
  const gotBuf = Buffer.from(got)
  if (expectedBuf.length !== gotBuf.length || !timingSafeEqual(expectedBuf, gotBuf)) {
    return res.status(401).json({ error: 'password required' })
  }
  next()
}

app.get('/', (_req, res) => res.redirect('/control.html'))

app.get('/api/demo/state', (_req, res) => res.json(demo.getState()))

app.post('/api/demo/start', requireDemoPassword, async (_req, res) => {
  try {
    res.json({ state: await demo.start() })
  } catch (e) {
    console.error('demo start failed:', e)
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/demo/kill/:agentId', requireDemoPassword, (req, res) => {
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

httpServer.listen(PORT, () => console.log(`listening on http://localhost:${PORT}`))
