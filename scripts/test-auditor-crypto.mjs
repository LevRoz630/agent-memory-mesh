// Pure crypto round trip for the auditor's fourth roster slot. No network, no env vars needed —
// sets AUDITOR_PUBLIC_KEY itself for the duration of the process.
//
//   node scripts/test-auditor-crypto.mjs

import { createECDH } from 'node:crypto'

function freshKeypair() {
  const ecdh = createECDH('secp256k1')
  ecdh.generateKeys()
  let priv = ecdh.getPrivateKey()
  if (priv.length < 32) priv = Buffer.concat([Buffer.alloc(32 - priv.length), priv])
  return { priv, pub: ecdh.getPublicKey(null, 'compressed') }
}

const auditor = freshKeypair()
process.env.AUDITOR_PUBLIC_KEY = auditor.pub.toString('hex')
process.env.ARKIV_PRIVATE_KEY_ATLAS = freshKeypair().priv.toString('hex')
process.env.ARKIV_PRIVATE_KEY_NOVA = freshKeypair().priv.toString('hex')
process.env.ARKIV_PRIVATE_KEY_SOL = freshKeypair().priv.toString('hex')

const { sealForRoster, openForAnyAgent, openForAuditor } = await import('../src/swarm.mjs')

console.log('auditor roster slot round trip\n')

const plaintext = Buffer.from(JSON.stringify({ note: 'incident-77 diagnosis' }), 'utf8')
const blob = sealForRoster(plaintext, ['atlas', 'nova', 'sol'])
console.log(`  blob size with auditor included (4 recipients): ${blob.length} bytes`)

let auditorOk = false
try {
  const decrypted = openForAuditor(blob, auditor.priv)
  auditorOk = decrypted.equals(plaintext)
  console.log(`  auditor decrypts with only their own key: ${auditorOk}`)
} catch (e) {
  console.log(`  auditor FAILED to decrypt: ${e.message}`)
}

let agentStillOk = false
try {
  const decrypted = openForAnyAgent(blob)
  agentStillOk = decrypted.equals(plaintext)
  console.log(`  an operational agent (openForAnyAgent) still decrypts unaffected: ${agentStillOk}`)
} catch (e) {
  console.log(`  operational agent FAILED to decrypt: ${e.message}`)
}

let wrongAuditorKeyRejected = false
try {
  openForAuditor(blob, freshKeypair().priv)
  console.log('  a different, unrelated key decrypted as auditor — THIS IS WRONG')
} catch (e) {
  wrongAuditorKeyRejected = true
  console.log(`  an unrelated key correctly rejected as auditor: ${e.message}`)
}

console.log('\n  with AUDITOR_PUBLIC_KEY unset, sealing stays 3-recipient (no regression):')
delete process.env.AUDITOR_PUBLIC_KEY
const blobNoAuditor = sealForRoster(plaintext, ['atlas', 'nova', 'sol'])
const noAuditorSlot = blobNoAuditor[0] === 3
console.log(`  nRecipients byte is 3 (no auditor slot appended): ${noAuditorSlot}, size ${blobNoAuditor.length}`)

const reproduced = auditorOk && agentStillOk && wrongAuditorKeyRejected && noAuditorSlot
console.log(`\nRESULT: ${reproduced ? 'passed' : 'FAILED'}`)
process.exit(reproduced ? 0 : 1)
