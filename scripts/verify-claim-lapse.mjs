// A claim that has fully lapsed must not be mistaken for a transient "too soon to extend" no-op.
// This writes a claim with a deliberately tiny TTL, never renews it, waits for it to expire for
// real, and then checks both halves of the fix: the engine's rejection says "expired" (which the
// old /expiry/i guard did NOT match, so it was rethrown and killed the renewal loop), and
// renewClaim() now reports it as { lost: true } instead of throwing.
//
//   node --env-file=.env scripts/verify-claim-lapse.mjs

import { makeClients, makeAgentSigners, extendMemory } from '../src/arkiv.mjs'
import { writeMemory } from '../src/memory.mjs'
import { renewClaim } from '../src/protocol.mjs'

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

const results = []
const check = (name, ok) => {
  results.push(Boolean(ok))
  console.log(`  ${ok ? 'pass' : 'FAIL'}: ${name}`)
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
