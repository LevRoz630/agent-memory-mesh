// Live check: nova's heartbeat lapses, sol's watch loop detects it and files exactly one
// outage incident — not zero, not a duplicate.
//
//   node --env-file=.env tests/live/peer-outage-detection.mjs

import { makeClients, makeAgentSigners, queryByTagPrefixAndType } from '../../src/arkiv.mjs'
import { startHeartbeat, watchForPeerOutages, outageTagPrefix } from '../../src/protocol.mjs'

const httpUrl = process.env.ARKIV_HTTP_URL
const { pub } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY, httpUrl })
const signers = makeAgentSigners({ httpUrl })
const ctx = { pub, signers }

console.log('peer outage detection\n')

// Outage tags are scoped, so rows an earlier run left on chain can't stand in for this one's.
const scope = `verify-${Date.now()}`

// Nova beats briefly, then stops — simulating a crash, not a graceful shutdown.
let novaRunning = true
const novaHb = startHeartbeat(ctx, 'nova', () => novaRunning)
await new Promise((r) => setTimeout(r, 3000))
novaRunning = false
await novaHb
console.log('  nova heartbeat stopped (simulated crash)')

const detected = []
const startedAt = Date.now()
const stopWatch = watchForPeerOutages(ctx, 'sol', scope, (peerId, tag) => detected.push({ peerId, tag, at: Date.now() }))

// Wait past nova's lease plus enough polling cycles for sol to notice. Detection needs two
// consecutive empty polls for the same peer, so budget one extra poll interval on top of the
// lease.
await new Promise((r) => setTimeout(r, 45000))
stopWatch()

const novaDetected = detected.filter((d) => d.peerId === 'nova')
console.log(`  sol detected nova's outage: ${novaDetected.length === 1} (${novaDetected.length} time(s))`)

// The heartbeat still had a live lease when the watch started, so a detection that fires on the
// very first poll would mean the lease was read as gone before it actually lapsed.
const delaySec = novaDetected.length > 0 ? Math.round((novaDetected[0].at - startedAt) / 1000) : null
const delayedPastLease = novaDetected.length > 0 && novaDetected[0].at - startedAt >= 8000
console.log(`  detection waited for the lease to lapse: ${delayedPastLease} (${delaySec}s after watch start)`)

const rows = await queryByTagPrefixAndType(pub, { tagPrefix: outageTagPrefix('nova', scope), memoryType: 'event' })
console.log(`  exactly one outage incident on-chain: ${rows.length === 1} (found ${rows.length})`)

const reproduced = novaDetected.length === 1 && delayedPastLease && rows.length === 1
console.log(`\nRESULT: ${reproduced ? 'passed' : 'FAILED'}`)
process.exit(reproduced ? 0 : 1)
