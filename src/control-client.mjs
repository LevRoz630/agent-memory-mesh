// Boots server.mjs on its own port and drives it through the same HTTP and websocket API the control
// room uses. Shared by the headless orchestrator and the live fleet test.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function bootControlRoom({ port = 3999, onState = () => {} } = {}) {
  const base = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port) }, stdio: 'inherit' })

  async function api(path, method = 'GET') {
    const res = await fetch(`${base}${path}`, { method, headers: { 'x-demo-password': process.env.DEMO_PASSWORD ?? '' } })
    const data = await res.json()
    if (!res.ok) throw new Error(`${method} ${path}: ${data.error ?? res.status}`)
    return data
  }

  for (let i = 0; ; i++) {
    try {
      await api('/api/demo/state')
      break
    } catch (e) {
      if (i > 50) throw new Error(`server did not come up on ${base}: ${e.message}`)
      await sleep(200)
    }
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}/live`)
  ws.on('message', (data) => {
    const msg = JSON.parse(data)
    if (msg.type === 'demo') onState(msg.state)
  })

  return {
    api,
    start: () => api('/api/demo/start', 'POST'),
    kill: (agentId) => api(`/api/demo/kill/${encodeURIComponent(agentId)}`, 'POST'),
    state: () => api('/api/demo/state'),
    stop() {
      ws.close()
      server.kill('SIGTERM')
    },
  }
}
