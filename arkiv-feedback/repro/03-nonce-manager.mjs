// feedback.md finding 3: concurrent createEntity calls from one wallet collide on nonce
// unless the account was built with viem's nonceManager. Builds both accounts here, since
// src/arkiv.mjs's makeClients now always passes one.
//
//   node --env-file=.env arkiv-feedback/repro/03-nonce-manager.mjs

import { createWalletClient, ExpirationTime, str, stringToPayload } from '@arkiv-network/sdk'
import { tiramisu } from '@arkiv-network/sdk/chains'
import { http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { nonceManager } from 'viem/nonce'

const N = 6

function walletFor({ withNonceManager }) {
  const pk = process.env.ARKIV_PRIVATE_KEY
  const account = withNonceManager ? privateKeyToAccount(pk, { nonceManager }) : privateKeyToAccount(pk)
  return createWalletClient({ account, chain: tiramisu, transport: http(undefined, { cacheTime: 0 }) })
}

async function burst(label, withNonceManager) {
  const wallet = walletFor({ withNonceManager })
  const agentId = `repro03-${label}-${Date.now().toString(36)}`
  const results = await Promise.allSettled(
    Array.from({ length: N }, (_, i) =>
      wallet.createEntity({
        expires: ExpirationTime.fromBlocks(120),
        payload: stringToPayload(''),
        contentType: 'application/octet-stream',
        attributes: { agent_id: str(agentId), tag: str(`t${i}`) },
      }),
    ),
  )
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const distinct = new Set(fulfilled.map((r) => r.value.entityKey)).size

  console.log(`\nprivateKeyToAccount(key${withNonceManager ? ', { nonceManager }' : ''})`)
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') console.log(`  #${i} ok     ${r.value.entityKey}`)
    else console.log(`  #${i} failed ${r.reason?.constructor?.name}: ${String(r.reason?.message).split('\n')[0]}`)
  })
  console.log(`  ${fulfilled.length}/${N} fulfilled, ${distinct} distinct entity keys`)
  return { fulfilled: fulfilled.length, distinct }
}

console.log(`finding 3: ${N} concurrent createEntity calls from one wallet, without vs with a nonce manager`)
console.log(`wallet: ${privateKeyToAccount(process.env.ARKIV_PRIVATE_KEY).address}`)

const without = await burst('nonm', false)
const withNm = await burst('withnm', true)

console.log(`\nwithout nonceManager: ${without.fulfilled}/${N}`)
console.log(`with    nonceManager: ${withNm.fulfilled}/${N}, ${withNm.distinct} distinct keys`)

const reproduced = without.fulfilled < N && withNm.fulfilled === N && withNm.distinct === N
console.log(`\nRESULT: ${reproduced ? 'reproduced' : 'NOT reproduced'}`)
process.exit(reproduced ? 0 : 1)
