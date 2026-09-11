// Local dev entrypoint: the shared REST app (src/app.mjs) plus a real websocket push on
// top — this is the Mission 03 artifact. The Vercel deployment (api/index.mjs) uses the
// same REST app without this layer, since serverless functions can't hold a persistent
// websocket server; see src/app.mjs's header comment.

import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { createApp, serializeAttrs } from './src/app.mjs'
import { makeClients, watchMemories } from './src/arkiv.mjs'
import { readMemoryContent } from './src/memory.mjs'

const PORT = process.env.PORT || 3000

const privateKey = process.env.ARKIV_PRIVATE_KEY
if (!privateKey) {
  console.error('set ARKIV_PRIVATE_KEY (a Tiramisu-funded wallet) in the environment')
  process.exit(1)
}

const { account, pub, wallet, wsClient } = makeClients({ privateKey })
console.log(`Arkiv account: ${account.address}`)

const app = createApp({ pub, wallet })
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

// This is the Mission 03 artifact — see watchMemories in src/arkiv.mjs for the mechanism.
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
    broadcast({
      type: 'memory', key: entityKey, owner, expiresAt: String(expiresAt),
      attributes: serializeAttrs(attributes),
      content,
    })
  },
  (err) => {
    console.error('watch error:', err.message)
    broadcast({ type: 'watch_error', message: err.message })
  },
)

httpServer.listen(PORT, () => console.log(`listening on http://localhost:${PORT}`))
