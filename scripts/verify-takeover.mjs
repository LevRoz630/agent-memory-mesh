// takeOver() is what makes "resume rather than restart" real: when a worker's claim lapses
// (process died mid-diagnosis) but it already published lane content, a successor should find
// that content instead of redoing the work. This simulates exactly that crash scenario — lane
// content and a `lane` Arkiv row for nova on a fresh tag, deliberately with NO claim ever held —
// and confirms takeOver() discovers it.
//
//   node --env-file=.env scripts/verify-takeover.mjs

import { makeClients, makeAgentSigners } from '../src/arkiv.mjs'
import { writeMemory } from '../src/memory.mjs'
import { writeToLane } from '../src/lane.mjs'
import { takeOver } from '../src/protocol.mjs'

const httpUrl = process.env.ARKIV_HTTP_URL
const wsUrl = process.env.ARKIV_WS_URL
const { pub } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY, httpUrl, wsUrl })
const signers = makeAgentSigners({ httpUrl })
const ctx = { pub, signers }

const nova = signers.get('nova')
if (!nova) throw new Error('set ARKIV_PRIVATE_KEY_NOVA in the environment')
const agentPrivateKeyHex = process.env.ARKIV_PRIVATE_KEY_NOVA

const tag = `verify-takeover-${Date.now()}`
console.log('claim-takeover discovery\n')
console.log(`  tag: ${tag}, "died mid-diagnosis" owner: ${nova.account.address}`)

// Simulate nova crashing right after publishing a diagnosis, before ever taking a claim (or
// after its claim already lapsed — takeOver() only looks at lane rows, not claim rows).
await writeToLane(agentPrivateKeyHex, nova.account.address, tag, 0, {
  kind: 'diagnosis', note: 'root cause: stale cache; nova died before writing a fix',
})
console.log('  wrote nova\'s lane content at index 0 (kind: diagnosis)')

await writeMemory(nova.wallet, {
  agentId: 'nova', memoryType: 'lane', tag, importance: 5,
  content: { note: 'lane provenance marker' }, ttlBlocks: 600,
})
console.log('  wrote the `lane` Arkiv row pointing at nova\'s lane')

const results = await takeOver(ctx, tag)
console.log(`  takeOver() found ${results.length} lane(s): ${JSON.stringify(results)}`)

const found = results.find((r) => r.ownerAddress.toLowerCase() === nova.account.address.toLowerCase())
const discovered = found?.latestContent?.kind === 'diagnosis' && found?.latestIndex === 0

console.log(`  discovered nova's lane content with kind 'diagnosis': ${discovered}`)

const reproduced = Boolean(discovered)
console.log(`\nRESULT: ${reproduced ? 'passed' : 'FAILED'}`)
process.exit(reproduced ? 0 : 1)
