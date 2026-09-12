// Mission 02 evidence, reproducible: write a short-lived memory, query it (present), wait
// past its expiry block, query the SAME filter again (gone) — no deleteEntity call anywhere
// in this file. Records requested vs. applied expiry, since createEntity's returned
// expiresAt for a fromBlocks() duration is a lower bound resolved against whatever block
// the tx actually lands in (they can differ).
//
//   node --env-file=.env scripts/demo-expiry.mjs

import { makeClients, queryMemories } from '../src/arkiv.mjs'
import { writeMemory } from '../src/memory.mjs'

const TTL_BLOCKS = 8 // ~16s at Tiramisu's ~2s block time — short enough for a live demo

const MAX_WAIT_POLLS = 40 // 3s each — bail out rather than hang if the RPC stalls

try {
  const { pub, wallet } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY })

  const tag = `expiry-demo-${Date.now().toString().slice(-6)}`
  console.log(`writing a memory with requested TTL = ${TTL_BLOCKS} blocks, tag=${tag}`)

  const headBefore = await pub.getBlockNumber()
  const result = await writeMemory(wallet, {
    agentId: 'atlas',
    memoryType: 'task',
    tag,
    importance: 5,
    content: { note: 'working-memory scratch note that should not outlive this task' },
    ttlBlocks: TTL_BLOCKS,
  })
  console.log(`written at block ${headBefore}`)
  console.log(`requested TTL: ${result.requestedTtlBlocks} blocks`)
  console.log(`applied expiry: block ${result.appliedExpiresAt}`)
  console.log(`entity key: ${result.entityKey}`)
  console.log(`tx: ${result.txHash}\n`)

  const q = () => queryMemories(pub, { agentId: 'atlas', tagPrefix: tag })

  const before = await q()
  console.log(`BEFORE expiry — query returns ${before.length} row(s)`)
  if (before.length === 0) {
    console.log('unexpected — the entity should be queryable immediately after being written')
    process.exit(1)
  }

  console.log('\nwaiting for the chain to pass the expiry block...')
  let headNow = headBefore
  let polls = 0
  while (headNow <= BigInt(result.appliedExpiresAt)) {
    if (++polls > MAX_WAIT_POLLS) throw new Error('gave up waiting for the chain to advance — RPC may be stalled')
    await new Promise((r) => setTimeout(r, 3000))
    headNow = await pub.getBlockNumber()
    process.stdout.write(`\r  head block ${headNow} / expiry ${result.appliedExpiresAt}   `)
  }
  console.log()

  const after = await q()
  console.log(`\nAFTER expiry — same query returns ${after.length} row(s)`)

  if (before.length > 0 && after.length === 0) {
    console.log('\nPASS — entity left query results on its own. Expiry is the mechanism;')
    console.log('nothing in this script ever called deleteEntity.')
  } else {
    console.log('\nUNEXPECTED — re-check expiry semantics before relying on this in the demo.')
  }
} catch (e) {
  console.error(`\nexpiry demo failed: ${e.message}`)
  process.exit(1)
}
