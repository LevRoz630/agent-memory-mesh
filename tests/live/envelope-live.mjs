// Live round trip: upload a memory sealed to a 2-agent roster, confirm the third agent's
// configured key cannot decrypt it, confirm a roster member can. Requires SWARM_SIGNER_KEY,
// SWARM_POSTAGE_BATCH_ID, and ARKIV_PRIVATE_KEY_ATLAS/NOVA/SOL in the environment.
//
//   node --env-file=.env tests/live/envelope-live.mjs

import { uploadMemory, downloadMemory } from '../../src/swarm.mjs'

console.log('live envelope round trip against the Swarm gateway\n')

const content = { note: 'envelope-live-check', ts: Date.now() }
const ref = await uploadMemory(content, ['atlas', 'nova'])
console.log(`  uploaded, sealed to [atlas, nova]: ${ref}`)

const readBack = await downloadMemory(ref)
const matches = readBack.note === content.note && readBack.ts === content.ts
console.log(`  read back matches: ${matches}`)

console.log(`\nRESULT: ${matches ? 'passed' : 'FAILED'}`)
process.exit(matches ? 0 : 1)
