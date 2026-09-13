// renewClaim's control flow, with no network and no env vars:
//   - it must not extend a lease once shouldContinue() has gone false during its wait
//   - it must tell a lapsed lease apart from failures worth retrying (too soon, an RPC hiccup)
//
//   node tests/unit/renew-stops.mjs

import { renewClaim } from '../../src/protocol.mjs'

const results = []
const check = (name, ok) => {
  results.push(Boolean(ok))
  console.log(`  ${ok ? 'pass' : 'FAIL'}: ${name}`)
}

function fakeCtx(extendEntity) {
  let block = 100n
  const wallet = {
    extendEntity,
    account: { address: '0xabc' },
    sender: { tail: Promise.resolve(), nextNonce: null, onBroadcast: null },
    getTransactionCount: async () => 0,
  }
  return { pub: { getBlockNumber: async () => block++ }, signers: new Map([['nova', { wallet }]]) }
}

let extendCalls = 0
const ctx = fakeCtx(async () => {
  extendCalls += 1
  return { txHash: '0x0', expiresAt: 0n }
})

let alive = true
setTimeout(() => { alive = false }, 100)
await renewClaim(ctx, 'nova', '0xabc', 12, () => alive)
check(`no extension after shouldContinue() went false (extendEntity calls: ${extendCalls})`, extendCalls === 0)

console.log('\nextendEntity rejections, classified\n')

// leaseBlocks 3 makes renewEveryBlocks 1, so the block wait resolves on its first comparison and
// the loop needs no real time to spin.
async function renewAgainst(message, stopAfterCalls = Infinity) {
  let calls = 0
  const failing = fakeCtx(async () => {
    calls += 1
    throw new Error(message)
  })
  let result = null
  let threw = null
  try {
    result = await renewClaim(failing, 'nova', '0xabc', 3, () => calls < stopAfterCalls)
  } catch (e) {
    threw = e.message
  }
  return { result, threw, calls }
}

const lapsed = await renewAgainst('Transaction failed: entity 0xdeadbeef… expired at block 372425')
check('an already-expired entity reports { lost: true }', lapsed.result?.lost === true && lapsed.threw === null)
check('...and stops renewing immediately', lapsed.calls === 1)

const tooSoon = await renewAgainst(
  'Transaction failed: entity 0xdeadbeef… already expires at block 372781, so extending it to 372724 would shorten its life',
  3,
)
check('a too-soon extension keeps looping and is not a lost lease', tooSoon.result?.lost === false && tooSoon.threw === null)
check(`...retrying until shouldContinue() goes false (extendEntity calls: ${tooSoon.calls})`, tooSoon.calls === 3)

const unrelated = await renewAgainst('Transaction failed: Execution error without revert data', 3)
check('an RPC hiccup is retried, not treated as a lost lease', unrelated.threw === null && unrelated.result?.lost === false && unrelated.calls === 3)

const passed = results.every(Boolean)
console.log(`\nRESULT: ${passed ? 'passed' : 'FAILED'}`)
process.exit(passed ? 0 : 1)
