// Live check: heartbeat is accepted as a memory_type, queryable the same way claims are.
//
//   node --env-file=.env scripts/verify-heartbeat-schema.mjs

import { makeClients, createMemory, queryByTagAndType } from '../src/arkiv.mjs'

const { wallet } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY })
const tag = `verify-heartbeat-${Date.now()}`

console.log('heartbeat entity type\n')

const { entityKey } = await createMemory(wallet, {
  agentId: 'atlas', memoryType: 'heartbeat', tag, importance: 1, swarmRef: '0'.repeat(64), ttlBlocks: 8,
})
console.log(`  wrote heartbeat row, entityKey ${entityKey.slice(0, 18)}…`)

const rows = await queryByTagAndType(makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY }).pub, { tag, memoryType: 'heartbeat' })
const found = rows.length === 1 && rows[0].attributes.memory_type === 'heartbeat'
console.log(`  queryByTagAndType finds it: ${found}`)

console.log(`\nRESULT: ${found ? 'passed' : 'FAILED'}`)
process.exit(found ? 0 : 1)
