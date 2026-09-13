// Entrypoint: launches the agent processes, serves the simulated data centers' power controller they
// call, and pushes their telemetry to the control room over the websocket on /live. It signs nothing
// and decrypts nothing itself.

import { createServer } from 'node:http'
import { createECDH, randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { WebSocketServer } from 'ws'
import { makePublicClient, AGENT_IDS } from './src/arkiv.mjs'
import { downloadSealed, decryptWithKey } from './src/swarm.mjs'
import { createInfra } from './src/infra.mjs'
import { createFleet } from './src/fleet.mjs'

const PORT = process.env.PORT || 3000

const missing = AGENT_IDS.filter((id) => !process.env[`ARKIV_PRIVATE_KEY_${id.toUpperCase()}`])
if (missing.length > 0) {
  console.error(`set ${missing.map((id) => `ARKIV_PRIVATE_KEY_${id.toUpperCase()}`).join(', ')}; each is handed only to that agent's process`)
  process.exit(1)
}

const pub = makePublicClient({ httpUrl: process.env.ARKIV_HTTP_URL })

const app = express()
app.use(express.json())
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))))
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

// Only the agent processes get this token, so a visitor to a public URL can't flip a data center's
// power from outside the control room's password.
const infraToken = randomBytes(24).toString('hex')
const infra = createInfra()
const fleet = createFleet({
  infra,
  infraUrl: `http://127.0.0.1:${PORT}/infra`,
  env: { ...process.env, HYDRA_INFRA_TOKEN: infraToken },
  onUpdate: (state) => broadcast({ type: 'demo', state }),
})

function secretMatches(expected, got) {
  const expectedBuf = Buffer.from(expected)
  const gotBuf = Buffer.from(got ?? '')
  return expectedBuf.length === gotBuf.length && timingSafeEqual(expectedBuf, gotBuf)
}

function requireDemoPassword(req, res, next) {
  const expected = process.env.DEMO_PASSWORD
  if (!expected || secretMatches(expected, req.get('x-demo-password'))) return next()
  res.status(401).json({ error: 'password required' })
}

function requireInfraToken(req, res, next) {
  if (secretMatches(infraToken, req.get('x-hydra-infra-token'))) return next()
  res.status(401).json({ error: 'not an agent of this deployment' })
}

app.get('/', (_req, res) => res.redirect('/control.html'))

app.get('/api/head', async (_req, res) => {
  try {
    res.json({ head: (await pub.getBlockNumber()).toString() })
  } catch (e) {
    console.error('head failed:', e)
    res.status(500).json({ error: e.message })
  }
})

app.get('/infra/status', requireInfraToken, (_req, res) => res.json(infra.status()))

app.post('/infra/dc/:id/power', requireInfraToken, (req, res) => {
  try {
    const { id } = req.params
    const state = req.body?.power === 'off' ? fleet.powerOff(id) : req.body?.power === 'on' ? fleet.powerOn(id) : null
    if (!state) return res.status(400).json({ error: 'power must be "on" or "off"' })
    res.json(infra.status())
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.post('/infra/rack/:id/power-cycle', requireInfraToken, (req, res) => {
  try {
    infra.powerCycleRack(req.params.id)
    res.json(infra.status())
  } catch (e) {
    res.status(409).json({ error: e.message })
  }
})

app.get('/api/demo/state', (_req, res) => res.json(fleet.getState()))

app.post('/api/demo/start', requireDemoPassword, async (_req, res) => {
  try {
    res.json({ state: await fleet.start() })
  } catch (e) {
    console.error('demo start failed:', e)
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/demo/kill/:agentId', requireDemoPassword, (req, res) => {
  try {
    res.json({ state: fleet.powerOff(req.params.agentId) })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Opening as an agent asks that agent's own process to decrypt with the only key it holds.
app.get('/api/demo/report', requireDemoPassword, async (req, res) => {
  try {
    const { report } = fleet.getState()
    if (!report) return res.status(404).json({ error: 'no incident filed yet' })
    const as = String(req.query.as ?? '')
    if (AGENT_IDS.includes(as)) {
      const opened = await fleet.decrypt(as, report.swarmRef)
      return res.json({ ok: true, as, bytes: opened.bytes, report: opened.report })
    }
    const sealed = await downloadSealed(report.swarmRef)
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

process.on('SIGTERM', () => {
  fleet.stop()
  process.exit(0)
})

httpServer.listen(PORT, () => console.log(`listening on http://localhost:${PORT}`))
