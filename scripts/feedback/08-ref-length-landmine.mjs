// Claim: a Swarm-Encrypt reference is 128 hex chars — exactly Arkiv's MAX_STRING_BYTES, with
// zero headroom. Prefixing it with "0x" makes it 130 bytes and str() rejects it.
//
// Not hit by this build (app-level encryption yields plain 64-hex refs), but any switch to
// Swarm-Encrypt must store the reference without the 0x prefix.
//
//   node --env-file=.env scripts/feedback/08-ref-length-landmine.mjs

import { str, MAX_STRING_BYTES } from '@arkiv-network/sdk'
import { uploadMemory } from '../../src/swarm.mjs'

const GATEWAY = process.env.SWARM_GATEWAY ?? 'https://api.gateway.ethswarm.org'

console.log(`CLAIM: an encrypted Swarm ref is 128 chars == MAX_STRING_BYTES (${MAX_STRING_BYTES}).\n`)

const res = await fetch(`${GATEWAY}/bytes`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream', 'Swarm-Encrypt': 'true' },
  body: Buffer.from('encrypted-ref-length-probe'),
  signal: AbortSignal.timeout(30000),
})
const { reference: encRef } = await res.json()

console.log(`Swarm-Encrypt upload (HTTP ${res.status})`)
console.log(`  ref:    ${encRef}`)
console.log(`  length: ${encRef.length} chars`)

function tryStr(value) {
  try {
    str(value)
    return 'accepted'
  } catch (e) {
    return `${e.constructor.name}: ${e.message}`
  }
}

console.log(`\nstr() at the boundary`)
console.log(`  ref as-is        (${Buffer.byteLength(encRef)} bytes): ${tryStr(encRef)}`)
console.log(`  "0x" + ref       (${Buffer.byteLength('0x' + encRef)} bytes): ${tryStr('0x' + encRef)}`)

const appRef = await uploadMemory({ probe: 'app-ref-length' })
console.log(`\nwhat this build actually stores (app-level encryption, plain ref)`)
console.log(`  ref:    ${appRef}`)
console.log(`  length: ${appRef.length} chars`)
console.log(`  str():  ${tryStr(appRef)}`)

const reproduced =
  encRef.length === 128 &&
  tryStr(encRef) === 'accepted' &&
  tryStr('0x' + encRef).startsWith('InvalidValueError') &&
  appRef.length === 64

console.log(`\nRESULT: ${reproduced ? 'reproduced' : 'NOT reproduced'}`)
process.exit(reproduced ? 0 : 1)
