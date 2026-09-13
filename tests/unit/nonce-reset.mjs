// A write that fails before it is sent must give its nonce back, or every later write from that wallet
// waits behind the gap. No network.
//
//   node tests/unit/nonce-reset.mjs

import { extendMemory, deleteMemory } from '../../src/arkiv.mjs'

let failed = false
function check(name, ok) {
  console.log(`  ${ok ? 'pass' : 'FAIL'}: ${name}`)
  if (!ok) failed = true
}

function fakeWallet(error) {
  const resets = []
  const reject = async () => { throw error }
  return {
    resets,
    chain: { id: 7738577 },
    account: { address: '0xabc', nonceManager: { reset: (args) => resets.push(args) } },
    extendEntity: reject,
    deleteEntity: reject,
  }
}

const unsent = fakeWallet(Object.assign(new Error('Transaction failed: no entity'), { txHash: undefined }))
await extendMemory(unsent, { entityKey: '0x1', ttlBlocks: 16 }).catch(() => {})
check('a write rejected before sending resets the nonce manager', unsent.resets.length === 1 && unsent.resets[0].chainId === 7738577)

const mined = fakeWallet(Object.assign(new Error('Transaction 0xdef reverted'), { txHash: '0xdef' }))
await deleteMemory(mined, { entityKey: '0x1' }).catch(() => {})
check('a mined, reverted write keeps its nonce', mined.resets.length === 0)

let rethrown = false
await extendMemory(fakeWallet(new Error('boom')), { entityKey: '0x1', ttlBlocks: 16 }).catch(() => { rethrown = true })
check('the error still reaches the caller', rethrown)

console.log(`\nRESULT: ${failed ? 'FAILED' : 'passed'}`)
process.exit(failed ? 1 : 0)
