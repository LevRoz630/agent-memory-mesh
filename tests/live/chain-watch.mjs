// Live check: the control room's subscription sees a real heartbeat renew and then lapse, from the
// stream alone.
//
//   node --env-file=.env tests/live/chain-watch.mjs

import { makeClients, makeAgentSigners, makeStreamClient } from '../../src/arkiv.mjs'
import { startHeartbeat, HEARTBEAT_LEASE_BLOCKS } from '../../src/protocol.mjs'
import { createChainWatch } from '../../src/chain-watch.mjs'

const httpUrl = process.env.ARKIV_HTTP_URL
const { pub } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY, httpUrl })
const signers = makeAgentSigners({ httpUrl })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('chain watch over a websocket subscription\n')

const leases = []
let latest = null
const watch = createChainWatch({
  client: makeStreamClient({ wsUrl: process.env.ARKIV_WS_URL }),
  onUpdate: (state) => {
    latest = state
    if (state.heartbeats.nova && leases.at(-1) !== state.heartbeats.nova) leases.push(state.heartbeats.nova)
  },
})

let running = true
const hb = startHeartbeat({ pub, signers }, 'nova', () => running)
await sleep(HEARTBEAT_LEASE_BLOCKS * 1.5 * 2000)
running = false
await hb

const renewals = leases.length
console.log(`  lease ends seen from the stream: ${leases.join(', ')}`)

await sleep((HEARTBEAT_LEASE_BLOCKS + 3) * 2000)
const lapsed = latest?.heartbeats.nova === undefined
const expiredInFeed = latest?.feed.some((e) => e.kind === 'expired' && e.agentId === 'nova' && e.memoryType === 'heartbeat')
watch.close()

console.log(`  head followed:                   ${latest?.head}`)
console.log(`  heartbeat seen and renewed:      ${renewals >= 2}`)
console.log(`  lease lapsed after renewals stop: ${lapsed}`)
console.log(`  lapse reported in the feed:      ${expiredInFeed}`)

const ok = renewals >= 2 && lapsed && expiredInFeed
console.log(`\nRESULT: ${ok ? 'passed' : 'FAILED'}`)
process.exit(ok ? 0 : 1)
