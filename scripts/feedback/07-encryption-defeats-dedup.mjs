// Claim: Swarm's content addressing deduplicates identical bytes, but this app never uploads
// identical bytes — encrypt() draws a fresh random IV per call, so identical content yields a
// different ciphertext and therefore a different reference every time.
//
// Both halves run here on purpose: without the raw-gateway half, "the gateway dedupes" and
// "this app's uploads never dedupe" read as a contradiction rather than a trade-off.
//
//   node --env-file=.env scripts/feedback/07-encryption-defeats-dedup.mjs

import { uploadMemory, downloadMemory } from '../../src/swarm.mjs'

const GATEWAY = process.env.SWARM_GATEWAY ?? 'https://api.gateway.ethswarm.org'

async function rawUpload(bytes) {
  const res = await fetch(`${GATEWAY}/bytes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
    signal: AbortSignal.timeout(30000),
  })
  const { reference } = await res.json()
  return reference
}

console.log('CLAIM (a): the raw gateway returns ONE reference for identical bytes.')
console.log('CLAIM (b): this app returns a DIFFERENT reference for identical content.\n')

const fixedBytes = Buffer.from('raw-gateway-dedup-fixed-bytes-v1')
const [rawA, rawB] = [await rawUpload(fixedBytes), await rawUpload(fixedBytes)]

console.log('(a) raw gateway POST /bytes, identical bytes, twice')
console.log(`  ref #1: ${rawA}`)
console.log(`  ref #2: ${rawB}`)
console.log(`  identical: ${rawA === rawB}`)

const content = { fixed: 'dedupe-check' }
const [appA, appB] = await Promise.all([uploadMemory(content), uploadMemory(content)])

console.log('\n(b) app uploadMemory(), identical content, twice')
console.log(`  ref #1: ${appA}`)
console.log(`  ref #2: ${appB}`)
console.log(`  identical: ${appA === appB}`)

const roundTrip = await downloadMemory(appA)
console.log(`  both still decrypt correctly: ${JSON.stringify(roundTrip)}`)

const reproduced = rawA === rawB && appA !== appB
console.log(`\nRESULT: ${reproduced ? 'reproduced' : 'NOT reproduced'}`)
process.exit(reproduced ? 0 : 1)
