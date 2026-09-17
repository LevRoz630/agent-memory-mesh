// Live round trip for lane (feed) writes: stamp our own address with the shared batch, write at
// an explicit index, read it back with no key at all, and confirm an unwritten index reads as a
// clean null rather than an error. This is the mechanism ARCHITECTURE.md §4 depends on.
//
//   node --env-file=.env tests/live/lane.mjs

import { privateKeyToAccount } from 'viem/accounts'
import { writeToLane, readLane } from '../../src/lane.mjs'

const agentKey = process.env.ARKIV_PRIVATE_KEY_NOVA
const account = privateKeyToAccount(agentKey)
const tag = `verify-lane-${Date.now()}`

console.log('lane round trip\n')
console.log(`  owner: ${account.address}, tag: ${tag}`)

const unwritten = await readLane(account.address, tag, 0)
console.log(`  index 0 before any write: ${unwritten === null ? 'null (clean)' : JSON.stringify(unwritten)}`)

const address = await writeToLane(agentKey, account.address, tag, 0, { kind: 'diagnosis', note: 'root cause: stale cache' })
console.log(`  wrote index 0 at SOC address ${address}`)

const readBack = await readLane(account.address, tag, 0)
const matches = readBack?.kind === 'diagnosis' && readBack?.note === 'root cause: stale cache'
console.log(`  read back matches: ${matches}`)

const stillUnwritten = await readLane(account.address, tag, 1)
console.log(`  index 1 (never written) still reads null: ${stillUnwritten === null}`)

const address1 = await writeToLane(agentKey, account.address, tag, 1, { kind: 'fix', note: 'deployed cache-buster' })
console.log(`  wrote index 1 at SOC address ${address1}`)

const readBack1 = await readLane(account.address, tag, 1)
const matches1 = readBack1?.kind === 'fix' && readBack1?.note === 'deployed cache-buster'
console.log(`  read back index 1 matches: ${matches1}`)

const distinctFromIndex0 = address1 !== address && JSON.stringify(readBack1) !== JSON.stringify(readBack)
console.log(`  index 1 is distinct from index 0 (different address and content): ${distinctFromIndex0}`)

const reproduced = unwritten === null && matches && stillUnwritten === null && matches1 && distinctFromIndex0
console.log(`\nRESULT: ${reproduced ? 'passed' : 'FAILED'}`)
process.exit(reproduced ? 0 : 1)
