// Watch an existing claim entity lapse live, rather than writing one ourselves like
// demo-expiry.mjs does. Polls the same compound query until the row count drops to zero.
//
//   node --env-file=.env scripts/watch-claim.mjs <agentId> [tagPrefix]

import { makeClients, queryMemories } from '../src/arkiv.mjs'

const MAX_WAIT_POLLS = 60 // 3s each — bail out rather than hang if the RPC stalls

const [agentId, tagPrefix] = process.argv.slice(2)
if (!agentId) {
  console.error('usage: node scripts/watch-claim.mjs <agentId> [tagPrefix]')
  process.exit(1)
}

const filter = `agent_id=${agentId} AND memory_type=claim` + (tagPrefix ? ` AND tag STARTSWITH "${tagPrefix}"` : '')

try {
  const { pub } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY })

  const q = () => queryMemories(pub, { agentId, memoryType: 'claim', tagPrefix })

  const before = await q()
  if (before.length === 0) {
    console.error(`no live claim found for ${filter} — write one first`)
    process.exit(1)
  }
  // Arkiv's query builder has no orderBy, so before[0] is an arbitrary match. Waiting on it
  // rather than the longest-lived row reports a false failure whenever the prefix matches more
  // than one claim.
  const last = before.reduce((a, b) => (BigInt(b.expiresAt) > BigInt(a.expiresAt) ? b : a))
  const expiresAt = BigInt(last.expiresAt)
  console.log(`watching ${filter}`)
  console.log(`claim entity: ${last.key}${before.length > 1 ? ` (latest of ${before.length} matches)` : ''}`)
  console.log(`applied expiry: block ${expiresAt}`)
  console.log(`\nBEFORE — query returns ${before.length} row(s)\n`)

  let headNow = await pub.getBlockNumber()
  let polls = 0
  while (headNow <= expiresAt) {
    if (++polls > MAX_WAIT_POLLS) throw new Error('gave up waiting for the chain to advance — RPC may be stalled')
    await new Promise((r) => setTimeout(r, 3000))
    headNow = await pub.getBlockNumber()
    const rows = await q()
    process.stdout.write(`\r  head block ${headNow} / expiry ${expiresAt} — ${rows.length} row(s)   `)
  }
  console.log()

  const after = await q()
  console.log(`\nAFTER — same query returns ${after.length} row(s)`)

  if (after.length === 0) {
    console.log('\nPASS — claim lapsed on its own. No deleteEntity call, no cleanup job, nobody watching had to be alive.')
  } else {
    console.log('\nUNEXPECTED — claim is still live past its own applied expiry block.')
  }
} catch (e) {
  console.error(`\nwatch-claim failed: ${e.message}`)
  process.exit(1)
}
