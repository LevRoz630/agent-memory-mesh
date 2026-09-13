// Live check: outcome round-trips on a verdict row, memory_type whitelist rejects garbage,
// queryByTagAndType filters on both tag and type together.
//
//   node --env-file=.env tests/live/schema-additions.mjs

import { ExpirationTime } from '@arkiv-network/sdk'
import { makeClients, createMemory, queryByTagAndType } from '../../src/arkiv.mjs'

const { pub, wallet, wsClient } = makeClients({
  privateKey: process.env.ARKIV_PRIVATE_KEY,
  httpUrl: process.env.ARKIV_HTTP_URL,
  wsUrl: process.env.ARKIV_WS_URL,
})
wsClient.transport?.destroy?.() // this script never watches; avoid an idle open socket

const tag = `verify-schema-${Date.now()}`

console.log('schema additions\n')

const { entityKey } = await createMemory(wallet, {
  agentId: 'atlas', memoryType: 'verdict', tag, importance: 5,
  swarmRef: '0'.repeat(64), ttlBlocks: 20, outcome: 'fixed',
})
console.log(`  wrote verdict row with outcome, entityKey ${entityKey.slice(0, 18)}…`)

const rows = await queryByTagAndType(pub, { tag, memoryType: 'verdict' })
const outcomeRoundTrips = rows.length === 1 && rows[0].attributes.outcome === 'fixed'
console.log(`  queryByTagAndType found it with outcome intact: ${outcomeRoundTrips}`)

const noMatch = await queryByTagAndType(pub, { tag, memoryType: 'claim' })
const typeFilters = noMatch.length === 0
console.log(`  queryByTagAndType('claim') on a verdict-only tag returns nothing: ${typeFilters}`)

let whitelistRejects = false
try {
  await createMemory(wallet, {
    agentId: 'atlas', memoryType: 'bogus', tag, importance: 1, swarmRef: '0'.repeat(64), ttlBlocks: 20,
  })
} catch (e) {
  whitelistRejects = /memory_type/.test(e.message)
  console.log(`  memory_type "bogus" rejected client-side: ${whitelistRejects} (${e.message})`)
}

const reproduced = outcomeRoundTrips && typeFilters && whitelistRejects
console.log(`\nRESULT: ${reproduced ? 'passed' : 'FAILED'}`)
process.exit(reproduced ? 0 : 1)
