// Writes roster.json: each agent's address and compressed public key, derived from the keys in .env.
// Everything in it is public, so it is committed; agent processes read peers from it instead of
// holding each other's private keys.
//
//   node --env-file=.env scripts/roster.mjs

import { createECDH } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { privateKeyToAccount } from 'viem/accounts'

const roster = {}
for (const agentId of ['atlas', 'nova', 'sol']) {
  const hex = process.env[`ARKIV_PRIVATE_KEY_${agentId.toUpperCase()}`]
  if (!hex) throw new Error(`set ARKIV_PRIVATE_KEY_${agentId.toUpperCase()}`)
  const ecdh = createECDH('secp256k1')
  ecdh.setPrivateKey(Buffer.from(hex.replace(/^0x/, ''), 'hex'))
  roster[agentId] = { address: privateKeyToAccount(hex).address, publicKey: ecdh.getPublicKey('hex', 'compressed') }
}
writeFileSync(new URL('../roster.json', import.meta.url), JSON.stringify(roster, null, 2) + '\n')
console.log(roster)
