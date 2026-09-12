// npm run demo — chains the pieces already built into one run: Atlas remembers, Nova
// recalls (cross-agent, proving portability), a compound query, then Mission 02's expiry
// demo. Needs `npm start` running in another terminal with the mission-control page open.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: process.env })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))))
  })
}

function banner(title) {
  console.log(`\n${'='.repeat(60)}\n${title}\n${'='.repeat(60)}`)
}

try {
  await fetch(`${BASE_URL}/api/head`)
} catch {
  console.error(`can't reach ${BASE_URL} — start the server first: npm start`)
  process.exit(1)
}

banner('1/4 — Atlas remembers (watch the mission-control panel)')
await run('node', [
  join(__dirname, 'agent-chat.mjs'), 'atlas',
  'Please remember that I prefer dark mode and 24-hour time — this is a lasting preference, not a one-off task detail.',
])

await wait(2000)

banner('2/4 — Nova recalls (independent session, cross-agent)')
await run('node', [
  join(__dirname, 'agent-chat.mjs'), 'nova',
  'The user just asked me about their display settings — do we know anything relevant?',
])

await wait(1000)

banner('3/4 — compound query: agent_id=atlas AND memory_type=preference AND importance>=5')
const params = new URLSearchParams({ agentId: 'atlas', memoryType: 'preference', minImportance: '5' })
const rows = await (await fetch(`${BASE_URL}/api/query?${params}`)).json()
console.log(`${rows.length} row(s):`)
for (const r of rows) {
  console.log(`  - [${r.attributes.tag}] ${JSON.stringify(r.content)} (importance ${r.attributes.importance}, expires block ${r.expiresAt})`)
}

banner('4/4 — Mission 02: built to expire')
await run('node', [join(__dirname, 'demo-expiry.mjs')])

banner('demo complete')
