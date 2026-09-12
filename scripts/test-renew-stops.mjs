// renewClaim must not extend a lease once shouldContinue() has gone false during its wait.
// No network, no env vars.
//
//   node scripts/test-renew-stops.mjs

import { renewClaim } from '../src/protocol.mjs'

let block = 100n
const pub = { getBlockNumber: async () => block++ }
let extendCalls = 0
const wallet = {
  extendEntity: async () => {
    extendCalls += 1
    return { txHash: '0x0', expiresAt: 0n }
  },
}
const signers = new Map([['nova', { wallet }]])

let alive = true
setTimeout(() => { alive = false }, 100)
await renewClaim({ pub, signers }, 'nova', '0xabc', 12, () => alive)

const ok = extendCalls === 0
console.log(`  ${ok ? 'pass' : 'FAIL'}: no extension after shouldContinue() went false (extendEntity calls: ${extendCalls})`)
console.log(`\nRESULT: ${ok ? 'passed' : 'FAILED'}`)
process.exit(ok ? 0 : 1)
