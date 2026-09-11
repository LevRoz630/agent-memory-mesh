// The whole product, one server: write memories, query them, and push live updates over a
// websocket as they're written elsewhere — the Mission 03 / two-panel demo artifact.
//
// The private key never leaves this process. The browser never sees it, never signs
// anything, never talks to Arkiv or Swarm directly — it talks to this server, which does.

import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { makeClients, queryMemories, watchMemories } from './src/arkiv.mjs'
import { writeMemory, readMemoryContent } from './src/memory.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3000

const privateKey = process.env.ARKIV_PRIVATE_KEY
if (!privateKey) {
  console.error('set ARKIV_PRIVATE_KEY (a Tiramisu-funded wallet) in the environment')
  process.exit(1)
}

const { account, pub, wallet, wsClient } = makeClients({ privateKey })
console.log(`Arkiv account: ${account.address}`)

function serializeAttrs(a) {
  return Object.fromEntries(Object.entries(a ?? {}).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]))
}

async function withContent(entity) {
  let content = null
  try {
    content = await readMemoryContent(entity.attributes)
  } catch (e) {
    content = { error: `content unavailable: ${e.message}` }
  }
  return { key: entity.key, expiresAt: String(entity.expiresAt), attributes: serializeAttrs(entity.attributes), content }
}

const app = express()
app.use(express.json())
app.use(express.static(join(__dirname, 'public')))

app.post('/api/memory', async (req, res) => {
  try {
    const { agentId, memoryType, tag, importance, content, ttlBlocks } = req.body
    if (!agentId || !memoryType || !tag || importance === undefined || !content || !ttlBlocks) {
      return res.status(400).json({ error: 'agentId, memoryType, tag, importance, content, ttlBlocks are all required' })
    }
    const result = await writeMemory(wallet, {
      agentId, memoryType, tag, importance: Number(importance), content, ttlBlocks: Number(ttlBlocks),
    })
    res.json({ ...result, appliedExpiresAt: result.appliedExpiresAt.toString() })
  } catch (e) {
    console.error('write failed:', e)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/query', async (req, res) => {
  try {
    const { agentId, memoryType, minImportance, tagPrefix } = req.query
    if (!agentId) return res.status(400).json({ error: 'agentId is required' })
    const entities = await queryMemories(pub, {
      agentId,
      memoryType: memoryType || undefined,
      minImportance: minImportance !== undefined ? Number(minImportance) : undefined,
      tagPrefix: tagPrefix || undefined,
    })
    res.json(await Promise.all(entities.map(withContent)))
  } catch (e) {
    console.error('query failed:', e)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/head', async (_req, res) => {
  const head = await pub.getBlockNumber()
  res.json({ head: head.toString() })
})

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

// The actual Mission 03 mechanism: a live subscription, no fromBlock, no polling loop.
// watchMemories already does the bounded getEntity follow-up read and silently skips
// anything that isn't an agent_memory entity — an irrelevant chain event never reaches
// broadcast() at all, which is the "does the filter actually work" demo requirement.
watchMemories(
  wsClient,
  pub,
  async ({ entityKey, owner, expiresAt, attributes }) => {
    let content = null
    try {
      content = await readMemoryContent(attributes)
    } catch (e) {
      content = { error: `content unavailable: ${e.message}` }
    }
    console.log(`live: agent_memory written by ${owner}, key=${entityKey}`)
    broadcast({ type: 'memory', key: entityKey, owner, expiresAt: String(expiresAt), attributes: serializeAttrs(attributes), content })
  },
  (err) => {
    console.error('watch error:', err.message)
    broadcast({ type: 'watch_error', message: err.message })
  },
)

httpServer.listen(PORT, () => console.log(`listening on http://localhost:${PORT}`))
