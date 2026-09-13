// Pure crypto round-trip for the binary envelope format (spec §2). No network, no env vars.
//
//   node tests/unit/envelope-crypto.mjs

import { randomBytes, createECDH } from 'node:crypto'
import { derivePublicKey, encryptForRoster, decryptWithKey } from '../../src/swarm.mjs'

function freshPrivateKey() {
  const ecdh = createECDH('secp256k1')
  ecdh.generateKeys()
  return ecdh.getPrivateKey()
}

console.log('binary envelope encryption round trip\n')

const keys = { atlas: freshPrivateKey(), nova: freshPrivateKey(), sol: freshPrivateKey() }
const AGENT_INDEX = { atlas: 0, nova: 1, sol: 2 }
const plaintext = Buffer.from(JSON.stringify({ note: 'incident-42 diagnosis' }), 'utf8')

const recipients = ['atlas', 'nova'].map((agentId) => ({
  agentIndex: AGENT_INDEX[agentId],
  publicKey: derivePublicKey(keys[agentId]),
}))
const blob = encryptForRoster(plaintext, recipients)
console.log(`  blob size for 2 recipients, ${plaintext.length}-byte plaintext: ${blob.length} bytes`)

let atlasOk = false
try {
  const decrypted = decryptWithKey(blob, AGENT_INDEX.atlas, keys.atlas)
  atlasOk = decrypted.equals(plaintext)
  console.log(`  atlas (on roster) decrypts correctly: ${atlasOk}`)
} catch (e) {
  console.log(`  atlas (on roster) FAILED to decrypt: ${e.message}`)
}

let novaOk = false
try {
  const decrypted = decryptWithKey(blob, AGENT_INDEX.nova, keys.nova)
  novaOk = decrypted.equals(plaintext)
  console.log(`  nova (on roster) decrypts correctly: ${novaOk}`)
} catch (e) {
  console.log(`  nova (on roster) FAILED to decrypt: ${e.message}`)
}

let solRejected = false
try {
  decryptWithKey(blob, AGENT_INDEX.sol, keys.sol)
  console.log('  sol (NOT on roster) decrypted — THIS IS WRONG')
} catch (e) {
  solRejected = true
  console.log(`  sol (not on roster) correctly rejected: ${e.message}`)
}

let wrongKeyRejected = false
try {
  decryptWithKey(blob, AGENT_INDEX.atlas, keys.nova)
  console.log('  atlas slot decrypted with nova\'s key — THIS IS WRONG')
} catch (e) {
  wrongKeyRejected = true
  console.log(`  atlas slot with nova's key correctly rejected: ${e.message}`)
}

const reproduced = atlasOk && novaOk && solRejected && wrongKeyRejected && blob.length < 300
console.log(`\nRESULT: ${reproduced ? 'passed' : 'FAILED'}`)
process.exit(reproduced ? 0 : 1)
