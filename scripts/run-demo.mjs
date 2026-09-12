// npm run demo — Atlas remembers, Nova recalls the same memory, a compound query, then the
// expiry demo. Needs `npm start` running in another terminal.

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
  console.log(`\n${title}`)
}

// A 500 from a dead chain connection is still an HTTP response, so this used to pass while
// nothing worked.
async function checkServer() {
  try {
    const res = await fetch(`${BASE_URL}/api/head`)
    return res.ok
  } catch {
    return false
  }
}

if (!(await checkServer())) {
  console.error(`can't reach ${BASE_URL} — start the server first: npm start`)
  process.exit(1)
}

const runTag = `demo-${Date.now().toString().slice(-6)}`

try {
  banner('1/4 — Atlas remembers')
  await run('node', [
    join(__dirname, 'agent-chat.mjs'), 'atlas',
    `Please remember that I prefer dark mode and 24-hour time as lasting preferences. ` +
    `Tag each memory starting with "${runTag}-".`,
  ])

  await wait(2000)

  banner('2/4 — Nova recalls')
  await run('node', [
    join(__dirname, 'agent-chat.mjs'), 'nova',
    'The user just asked me about their display settings — do we know anything relevant?',
  ])

  await wait(1000)

  banner(`3/4 — compound query: agent_id=atlas AND memory_type=preference AND tag STARTSWITH "${runTag}-"`)
  if (!(await checkServer())) throw new Error(`lost connection to ${BASE_URL} — is npm start still running?`)
  const params = new URLSearchParams({ agentId: 'atlas', memoryType: 'preference', tagPrefix: `${runTag}-` })
  const rows = await (await fetch(`${BASE_URL}/api/query?${params}`)).json()
  console.log(`${rows.length} row(s):`)
  for (const r of rows) {
    console.log(`  - [${r.attributes.tag}] ${JSON.stringify(r.content)}`)
  }
  // Zero rows means Atlas ignored the run tag, chose a different memory_type, or the memory
  // already expired. Reporting that as a successful demo step hides all three.
  if (rows.length === 0) {
    throw new Error(`compound query returned 0 rows — the memory was never written as expected, or expired before step 3`)
  }

  banner('4/4 — Mission 02: built to expire')
  await run('node', [join(__dirname, 'demo-expiry.mjs')])

  banner('demo complete')
} catch (e) {
  console.error(`\ndemo stopped: ${e.message}`)
  process.exit(1)
}
