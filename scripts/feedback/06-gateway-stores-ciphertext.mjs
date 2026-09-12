// Claim: the gateway stores ciphertext only — content is encrypted in-process before upload,
// so plaintext never leaves this machine. Uploads a canary string through the app's own
// uploadMemory, then fetches the raw stored bytes straight from the gateway and looks for it.
//
//   node --env-file=.env scripts/feedback/06-gateway-stores-ciphertext.mjs

import { uploadMemory } from '../../src/swarm.mjs'

const GATEWAY = process.env.SWARM_GATEWAY ?? 'https://api.gateway.ethswarm.org'
const CANARY = 'CANARY_12345'

console.log('CLAIM: the Swarm gateway never receives plaintext; it stores ciphertext only.\n')

const content = { canary: CANARY }
const plaintext = Buffer.from(JSON.stringify(content), 'utf8')

const ref = await uploadMemory(content)
console.log(`uploaded via src/swarm.mjs uploadMemory()`)
console.log(`  ref:             ${ref}`)
console.log(`  plaintext bytes: ${plaintext.length}`)

const res = await fetch(`${GATEWAY}/bytes/${ref}`, { signal: AbortSignal.timeout(30000) })
const raw = Buffer.from(await res.arrayBuffer())

const canaryPresent = raw.toString('utf8').includes(CANARY)
const delta = raw.length - plaintext.length

console.log(`\nraw bytes as stored by the gateway (HTTP ${res.status})`)
console.log(`  stored bytes:    ${raw.length}`)
console.log(`  first 32 bytes:  ${raw.subarray(0, 32).toString('hex')}`)
console.log(`  canary "${CANARY}" present: ${canaryPresent}`)
console.log(`  stored - plaintext = ${delta} bytes (12-byte IV + 16-byte GCM authTag = 28)`)

const reproduced = canaryPresent === false && delta === 28
console.log(`\nRESULT: ${reproduced ? 'reproduced' : 'NOT reproduced'}`)
process.exit(reproduced ? 0 : 1)
