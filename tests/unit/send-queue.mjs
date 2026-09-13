// A wallet's writes get consecutive nonces, a write that fails before broadcast leaves no gap, and a
// write waiting on its receipt doesn't hold the next one up. No network.
//
//   node tests/unit/send-queue.mjs

import { extendMemory } from '../../src/arkiv.mjs'

let failed = false
function check(name, ok) {
  console.log(`  ${ok ? 'pass' : 'FAIL'}: ${name}`)
  if (!ok) failed = true
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Mirrors the node: pending count is the next nonce after everything broadcast so far.
function fakeWallet() {
  const broadcasts = []
  const receipts = new Map()
  const wallet = {
    account: { address: '0xabc' },
    sender: { tail: Promise.resolve(), nextNonce: null, onBroadcast: null },
    broadcasts,
    receipts,
    async getTransactionCount() {
      return 5 + broadcasts.length
    },
    async extendEntity({ entityKey }, { nonce }) {
      await sleep(5)
      if (entityKey === 'gone') throw Object.assign(new Error('gas estimation reverted'), { txHash: undefined })
      broadcasts.push(nonce)
      wallet.sender.onBroadcast?.()
      if (entityKey === 'slow') await new Promise((resolve) => receipts.set(entityKey, resolve))
      return { txHash: `0x${nonce}` }
    },
  }
  return wallet
}

{
  const w = fakeWallet()
  await Promise.all(['a', 'b', 'c'].map((entityKey) => extendMemory(w, { entityKey, ttlBlocks: 16 })))
  check('concurrent writes get consecutive nonces', JSON.stringify(w.broadcasts) === '[5,6,7]')
}

{
  const w = fakeWallet()
  const results = await Promise.allSettled(['a', 'gone', 'b'].map((entityKey) => extendMemory(w, { entityKey, ttlBlocks: 16 })))
  check('the write that failed before broadcast is rejected', results[1].status === 'rejected')
  check('the write after it reuses its nonce, leaving no gap', JSON.stringify(w.broadcasts) === '[5,6]')
}

{
  const w = fakeWallet()
  const slow = extendMemory(w, { entityKey: 'slow', ttlBlocks: 16 })
  const next = await Promise.race([extendMemory(w, { entityKey: 'a', ttlBlocks: 16 }).then(() => 'landed'), sleep(200).then(() => 'blocked')])
  check('a write waiting on its receipt does not hold up the next one', next === 'landed' && JSON.stringify(w.broadcasts) === '[5,6]')
  w.receipts.get('slow')()
  await slow
}

console.log(`\nRESULT: ${failed ? 'FAILED' : 'passed'}`)
process.exit(failed ? 1 : 0)
