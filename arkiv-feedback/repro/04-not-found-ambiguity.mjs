// feedback.md finding 4: getEntity returns a byte-identical error for a key that never
// existed and one whose entity expired naturally. A malformed key does differ.
//
//   node --env-file=.env arkiv-feedback/repro/04-not-found-ambiguity.mjs

import { makeClients, createMemory } from '../../src/arkiv.mjs'

const TTL_BLOCKS = 5
const NEVER_CREATED = '0x' + 'ab'.repeat(32)
const MALFORMED = '0xdead'

const { pub, wallet, account } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY })

async function readError(key) {
  try {
    await pub.getEntity(key)
    return null
  } catch (e) {
    return { name: e.constructor.name, message: e.message.split('\n')[0] }
  }
}

console.log('finding 4: getEntity cannot distinguish "never created" from "expired"')
console.log(`wallet: ${account.address}\n`)

const { entityKey, txHash, appliedExpiresAt } = await createMemory(wallet, {
  agentId: `repro04-${Date.now().toString(36)}`,
  memoryType: 'event',
  tag: 'not-found',
  importance: 5,
  swarmRef: 'feedbackrepro',
  ttlBlocks: TTL_BLOCKS,
})
console.log(`wrote entity ${entityKey}`)
console.log(`tx ${txHash}`)
console.log(`requested TTL ${TTL_BLOCKS} blocks, applied expiry block ${appliedExpiresAt}`)
console.log(`getEntity while live: ${(await readError(entityKey)) === null ? 'ok' : 'unexpected error'}\n`)

console.log('waiting for the chain to pass the expiry block (no delete call is made)...')
let head = await pub.getBlockNumber()
while (head <= BigInt(appliedExpiresAt)) {
  await new Promise((r) => setTimeout(r, 3000))
  head = await pub.getBlockNumber()
  process.stdout.write(`\r  head ${head} / expiry ${appliedExpiresAt}   `)
}
console.log('\n')

const expired = await readError(entityKey)
const never = await readError(NEVER_CREATED)
const malformed = await readError(MALFORMED)

console.log(`expired      (${entityKey.slice(0, 18)}…)`)
console.log(`  ${expired?.name}: ${expired?.message}`)
console.log(`never created (${NEVER_CREATED.slice(0, 18)}…)`)
console.log(`  ${never?.name}: ${never?.message}`)
console.log(`malformed     (${MALFORMED})`)
console.log(`  ${malformed?.name}: ${malformed?.message}`)

// Identical apart from the key each message quotes.
const normalise = (m) => m?.message.replace(/0x[0-9a-f]+/gi, '<key>')
const sameShape = expired && never && expired.name === never.name && normalise(expired) === normalise(never)

console.log(`\nsame error class:           ${expired?.name === never?.name} (${expired?.name})`)
console.log(`identical apart from key:   ${sameShape}`)
console.log(`malformed key differs:      ${malformed?.name !== expired?.name} (${malformed?.name})`)

const reproduced = Boolean(sameShape) && malformed?.name !== expired?.name
console.log(`\nRESULT: ${reproduced ? 'reproduced' : 'NOT reproduced'}`)
process.exit(reproduced ? 0 : 1)
