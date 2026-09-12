// feedback.md finding 1: the write path takes bare constructors (str/u64) but the read path
// returns typed wrapper objects ({ type, value }). Rendering a raw read result produces
// "[object Object]" with no error and no type mismatch.
//
//   node --env-file=.env scripts/feedback/01-attribute-wrapper-shape.mjs

import { str } from '@arkiv-network/sdk'
import { eq } from '@arkiv-network/sdk/query'
import { makeClients, createMemory, unwrapAttributes } from '../../src/arkiv.mjs'

const bigints = (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)

const { pub, wallet, account } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY })
const agentId = `repro01-${Date.now().toString(36)}`

console.log('finding 1: read path returns typed wrapper objects; write path takes bare constructors')
console.log(`wallet: ${account.address}\n`)

console.log('WRITE — attributes given as str()/u64() constructors:')
console.log("  { agent_id: str('" + agentId + "'), importance: u64(7n), ... }")
const { entityKey, txHash } = await createMemory(wallet, {
  agentId,
  memoryType: 'fact',
  tag: 'wrapper-shape',
  importance: 7,
  swarmRef: 'feedbackrepro',
  ttlBlocks: 300,
})
console.log(`  entityKey: ${entityKey}`)
console.log(`  tx:        ${txHash}\n`)

const fromGet = (await pub.getEntity(entityKey)).attributes
console.log('READ (getEntity) — raw .attributes:')
console.log(`  ${JSON.stringify(fromGet, bigints)}\n`)

const selected = await pub.select('*').where(eq('agent_id', str(agentId))).limit(1).fetch()
const rows = Array.isArray(selected) ? selected : (selected?.entities ?? [])
console.log('READ (select) — raw .attributes:')
console.log(`  ${JSON.stringify(rows[0]?.attributes, bigints)}\n`)

const rendered = `${fromGet.agent_id}`
console.log('CONSEQUENCE — interpolating a raw value into a template:')
console.log(`  \`\${attributes.agent_id}\` -> ${rendered}`)
console.log(`  threw: no    typeof: ${typeof fromGet.agent_id}\n`)

console.log("AFTER unwrapAttributes() — src/arkiv.mjs's central fix:")
console.log(`  ${JSON.stringify(unwrapAttributes(fromGet), bigints)}`)
console.log(`  \`\${unwrapped.agent_id}\` -> ${unwrapAttributes(fromGet).agent_id}\n`)

const wrapped = fromGet.agent_id?.type === 'str' && fromGet.agent_id?.value === agentId
const reproduced = wrapped && rendered === '[object Object]'
console.log(`RESULT: ${reproduced ? 'reproduced' : 'NOT reproduced'}`)
process.exit(reproduced ? 0 : 1)
