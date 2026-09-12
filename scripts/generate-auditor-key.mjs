// One-off: generates the auditor identity used by scripts/audit-exporter.mjs. Run once, then
// split the two halves: AUDITOR_PUBLIC_KEY goes into the writers' .env (atlas/nova/sol's process),
// AUDITOR_PRIVATE_KEY goes only to whoever runs the exporter. Never both in the same .env, or
// the "separate observer" is cosmetic instead of real.
//
//   node scripts/generate-auditor-key.mjs

import { createECDH } from 'node:crypto'

function freshKeypair() {
  const ecdh = createECDH('secp256k1')
  ecdh.generateKeys()
  let priv = ecdh.getPrivateKey()
  // Node trims a leading zero byte, so a fresh key occasionally comes back 31 bytes instead of 32.
  if (priv.length < 32) priv = Buffer.concat([Buffer.alloc(32 - priv.length), priv])
  return { priv, pub: ecdh.getPublicKey(null, 'compressed') }
}

let kp = freshKeypair()
while (kp.priv.length !== 32) kp = freshKeypair()

console.log('# Give this half only to whoever runs scripts/audit-exporter.mjs — never commit it,')
console.log('# never put it in the same .env as ARKIV_PRIVATE_KEY_ATLAS/NOVA/SOL.')
console.log(`AUDITOR_PRIVATE_KEY=${kp.priv.toString('hex')}`)
console.log()
console.log('# Add this half to the writers\' .env (wherever atlas/nova/sol actually run) so every')
console.log('# memory and lane write seals a copy of its content key to the auditor too.')
console.log(`AUDITOR_PUBLIC_KEY=${kp.pub.toString('hex')}`)
