// Live check: a heartbeat renews while its loop runs, and lapses cleanly once stopped.
//
//   node --env-file=.env scripts/verify-heartbeat-lapse.mjs

import { makeClients, makeAgentSigners, queryByTagAndType } from '../src/arkiv.mjs'
import { startHeartbeat, HEARTBEAT_LEASE_BLOCKS } from '../src/protocol.mjs'

const httpUrl = process.env.ARKIV_HTTP_URL
const { pub } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY, httpUrl })
const signers = makeAgentSigners({ httpUrl })
const ctx = { pub, signers }

console.log('heartbeat renewal and lapse\n')

let running = true
const hb = startHeartbeat(ctx, 'nova', () => running)

// Wait past one full lease (~1.5 lease periods) so only a genuinely renewed row is still there.
// A shorter wait would pass on the initial write's TTL alone, proving nothing about renewal.
await new Promise((r) => setTimeout(r, HEARTBEAT_LEASE_BLOCKS * 1.5 * 2000))
const tag = 'agent-nova'
const alive = await queryByTagAndType(pub, { tag, memoryType: 'heartbeat', limit: 1 })
console.log(`  heartbeat visible while running: ${alive.length === 1}`)

running = false
await hb

// Wait past the lease so it lapses.
await new Promise((r) => setTimeout(r, (HEARTBEAT_LEASE_BLOCKS + 2) * 2000))
const gone = await queryByTagAndType(pub, { tag, memoryType: 'heartbeat', limit: 1 })
console.log(`  heartbeat lapsed after stopping: ${gone.length === 0}`)

const reproduced = alive.length === 1 && gone.length === 0
console.log(`\nRESULT: ${reproduced ? 'passed' : 'FAILED'}`)
process.exit(reproduced ? 0 : 1)
