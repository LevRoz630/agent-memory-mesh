// A claim that has fully lapsed must not be mistaken for a transient "too soon to extend" no-op.
// Both of the engine's extension rejections are captured live here, against real entities, so a
// change in either wording fails loudly instead of silently reverting classifyExtendError to a
// rethrow: the benign "would move the expiry backwards" case, and a claim written with a tiny TTL,
// never renewed, left to expire for real. Neither wording matched the original /expiry/i guard.
// renewClaim() must report the lapse as { lost: true } rather than throwing.
//
//   node --env-file=.env tests/live/claim-lapse.mjs

import { makeClients, makeAgentSigners, extendMemory, deleteMemory } from '../../src/arkiv.mjs'
import { writeMemory } from '../../src/memory.mjs'
import { renewClaim } from '../../src/protocol.mjs'

const httpUrl = process.env.ARKIV_HTTP_URL
const { pub } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY, httpUrl })
const signers = makeAgentSigners({ httpUrl })
const ctx = { pub, signers }

const nova = signers.get('nova')
if (!nova) throw new Error('set ARKIV_PRIVATE_KEY_NOVA in the environment')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tag = `verify-claim-lapse-${Date.now()}`
const LAPSE_TTL_BLOCKS = 2

console.log('a lapsed claim is reported, not thrown\n')
console.log(`  tag: ${tag}`)

const results = []
const check = (name, ok) => {
  results.push(Boolean(ok))
  console.log(`  ${ok ? 'pass' : 'FAIL'}: ${name}`)
}

// The benign arm first, on its own claim: a long-lived claim asked to extend to a nearer block is
// exactly the "this renewal would move the expiry backwards" case renewClaim must treat as a no-op.
// Captured live so an SDK wording change can't quietly turn it back into a rethrow.
const benign = await writeMemory(nova.wallet, {
  agentId: 'nova', memoryType: 'claim', tag: `${tag}-too-soon`, importance: 5, content: {}, ttlBlocks: 60,
})
let tooSoonMessage = null
try {
  await extendMemory(nova.wallet, { entityKey: benign.entityKey, ttlBlocks: 2 })
} catch (e) {
  tooSoonMessage = e.message
}
console.log(`  extendMemory() that would move the expiry backwards said: ${tooSoonMessage ?? '(no rejection at all)'}`)
check('a backwards extension is rejected', tooSoonMessage !== null)
// classifyExtendError's 'too-soon' arm: matches /expir/i, but must NOT hit the /expired/i arm first.
check('the rejection is classified as too-soon, not as a lapse', /expir/i.test(tooSoonMessage ?? '') && !/expired/i.test(tooSoonMessage ?? ''))
await deleteMemory(nova.wallet, { entityKey: benign.entityKey })
console.log('')

const written = await writeMemory(nova.wallet, {
  agentId: 'nova', memoryType: 'claim', tag, importance: 5, content: {}, ttlBlocks: LAPSE_TTL_BLOCKS,
})
console.log(`  wrote nova's claim ${written.entityKey} with a ${LAPSE_TTL_BLOCKS}-block TTL, expiring at block ${written.appliedExpiresAt}`)

// Past the expiry with a margin, so the entity is unambiguously gone and not merely at its edge.
const deadline = BigInt(written.appliedExpiresAt) + 3n
while ((await pub.getBlockNumber()) <= deadline) await sleep(500)
console.log(`  waited to block ${await pub.getBlockNumber()} — the claim has lapsed`)

let directMessage = null
try {
  await extendMemory(nova.wallet, { entityKey: written.entityKey, ttlBlocks: 12 })
} catch (e) {
  directMessage = e.message
}

console.log('')
console.log(`  extendMemory() on the lapsed claim said: ${directMessage ?? '(no rejection at all)'}`)
check('extending a lapsed claim is rejected', directMessage !== null)
check('the rejection says "expired"', /expired/i.test(directMessage ?? ''))
check('the old /expiry/i guard would NOT have matched it', !/expiry/i.test(directMessage ?? ''))

let renewResult = null
let renewThrew = null
try {
  renewResult = await renewClaim(ctx, 'nova', written.entityKey, 3, () => true)
} catch (e) {
  renewThrew = e.message
}
console.log(`  renewClaim() returned ${JSON.stringify(renewResult)}${renewThrew ? `, threw: ${renewThrew}` : ''}`)
check('renewClaim() did not throw on the lapsed claim', renewThrew === null)
check('renewClaim() reported the lease as lost', renewResult?.lost === true)

const passed = results.every(Boolean)
console.log(`\nRESULT: ${passed ? 'passed' : 'FAILED'}`)
process.exit(passed ? 0 : 1)
