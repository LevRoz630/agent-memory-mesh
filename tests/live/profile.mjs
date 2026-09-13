// Live check: an agent's sealed profile can be read back by a peer from the wallet address alone, and
// republishing an unchanged profile adds no new feed entry.
//
//   node --env-file=.env tests/live/profile.mjs

import { makeClients, makeAgentSigners } from '../../src/arkiv.mjs'
import { nextFreeLaneIndex } from '../../src/lane.mjs'
import { publishProfile, readProfile } from '../../src/protocol.mjs'

const httpUrl = process.env.ARKIV_HTTP_URL
const { pub } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY, httpUrl })
const signers = makeAgentSigners({ httpUrl })
const ctx = { pub, signers }
const atlas = signers.get('atlas').account.address

console.log('agent profile feed\n')

const results = []
const check = (name, ok) => {
  results.push(Boolean(ok))
  console.log(`  ${ok ? 'pass' : 'FAIL'}: ${name}`)
}

const profile = { location: 'DC-1 Frankfurt' }
await publishProfile(ctx, 'atlas', profile)
const read = await readProfile(ctx, 'atlas')
console.log(`  read back: ${JSON.stringify(read)}`)
check("a peer reads atlas's location from its wallet address alone", read?.location === profile.location)

const before = await nextFreeLaneIndex(atlas, 'agent-atlas')
await publishProfile(ctx, 'atlas', profile)
check('republishing an unchanged profile adds no entry', (await nextFreeLaneIndex(atlas, 'agent-atlas')) === before)

const passed = results.every(Boolean)
console.log(`\nRESULT: ${passed ? 'passed' : 'FAILED'}`)
process.exit(passed ? 0 : 1)
