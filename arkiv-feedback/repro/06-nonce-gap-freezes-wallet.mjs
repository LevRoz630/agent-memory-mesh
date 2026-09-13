// feedback.md finding 6: with a nonce manager, a write that fails at gas estimation keeps the nonce it
// was handed. Writes sent after it from the same wallet wait behind the gap and never land on their own.
// Resetting the nonce manager after the failure lets the next write fill the gap.
//
//   node --env-file=.env arkiv-feedback/repro/06-nonce-gap-freezes-wallet.mjs

import { createPublicClient, createWalletClient, ExpirationTime, str, stringToPayload } from '@arkiv-network/sdk'
import { tiramisu } from '@arkiv-network/sdk/chains'
import { http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { nonceManager } from 'viem/nonce'

const STUCK_AFTER_MS = 40000
const TTL_BLOCKS = 100

// Built here with viem's nonceManager, the fix finding 3 points to; src/arkiv.mjs counts nonces itself.
const account = privateKeyToAccount(process.env.ARKIV_PRIVATE_KEY, { nonceManager })
const pub = createPublicClient({ chain: tiramisu, transport: http(undefined, { cacheTime: 0 }) })
const wallet = createWalletClient({ account, chain: tiramisu, transport: http(undefined, { cacheTime: 0 }) })
const chainId = wallet.chain.id
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nonces = async () => `latest ${await pub.getTransactionCount({ address: account.address })}, pending ${await pub.getTransactionCount({ address: account.address, blockTag: 'pending' })}`

const row = async () => (await wallet.createEntity({
  expires: ExpirationTime.fromBlocks(TTL_BLOCKS),
  payload: stringToPayload(''),
  contentType: 'application/octet-stream',
  attributes: { agent_id: str('repro06'), tag: str('nonce-gap') },
})).entityKey
const extend = (entityKey) => wallet.extendEntity({ entityKey, expires: ExpirationTime.fromBlocks(TTL_BLOCKS) })

// A deleted entity makes gas estimation revert, the same as renewing a lease that just lapsed.
async function arm(label, resetAfterFailure) {
  const [first, second, gone] = [await row(), await row(), await row()]
  await wallet.deleteEntity({ entityKey: gone })
  console.log(`${label}\n  before: ${await nonces()}`)
  // Nonces are handed out in call order: the failing write sits between two valid ones.
  const started = Date.now()
  const firstWrite = extend(first)
  const failingWrite = extend(gone).catch((e) => {
    if (resetAfterFailure) account.nonceManager.reset({ address: account.address, chainId })
    throw e
  })
  const landed = extend(second).then(() => Date.now() - started)
  const results = await Promise.allSettled([firstWrite, failingWrite])
  console.log(`  valid write: ${results[0].status}; write on the deleted entity: ${results[1].status} (${results[1].reason?.message.slice(0, 70)}, txHash ${results[1].reason?.txHash})`)
  if (resetAfterFailure) await extend(first)
  const ms = await Promise.race([landed, sleep(STUCK_AFTER_MS).then(() => null)])
  console.log(`  second valid write: ${ms === null ? `still pending after ${STUCK_AFTER_MS / 1000}s` : `landed after ${(ms / 1000).toFixed(1)}s`}`)
  console.log(`  after: ${await nonces()}\n`)
  return ms !== null
}

console.log('finding 6: a write that fails at gas estimation leaves a nonce gap that freezes the wallet')
console.log(`wallet: ${account.address}\n`)

const withoutReset = await arm('without resetting the nonce manager', false)
const withReset = await arm('resetting the nonce manager after the failure, then writing once more', true)

const reproduced = !withoutReset && withReset
console.log(`RESULT: ${reproduced ? 'reproduced' : 'NOT reproduced'}`)
process.exit(reproduced ? 0 : 1)
