// Local dev entrypoint: the shared REST app plus the live websocket push that the serverless
// deployment (api/index.mjs) can't hold open.

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
