// Three agents sharing one batch never stamp the same bucket slot, and a restarted agent resumes past
// the slots it already used. No network.
//
//   node tests/unit/stamp-slots.mjs

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { Stamper } from '@ethersphere/core-sdk'
import { createPartitionedStamper } from '../../src/stamp-slots.mjs'

let failed = false
function check(name, ok) {
  console.log(`  ${ok ? 'pass' : 'FAIL'}: ${name}`)
  if (!ok) failed = true
}

const dir = mkdtempSync(join(tmpdir(), 'stamp-slots-'))
const signer = randomBytes(32).toString('hex')
const batchId = randomBytes(32).toString('hex')
const depth = 20
const statePath = (i) => pathToFileURL(join(dir, `agent-${i}.bin`))
const make = (i) => createPartitionedStamper({ signer, batchId, depth, agentIndex: i, partitions: 3, statePath: statePath(i) })

// Every chunk address in one bucket, so every stamp competes for that bucket's slots.
const address = () => Buffer.concat([Buffer.from([0x12, 0x34]), randomBytes(30)])
const slotOf = (envelope) => Buffer.from(envelope.index).readUInt32BE(4)

const seen = new Set()
let collision = false
const stampers = [0, 1, 2].map(make)
for (let round = 0; round < 4; round++) {
  for (const s of stampers) {
    const slot = slotOf(s.stamp(address()))
    if (seen.has(slot)) collision = true
    seen.add(slot)
  }
}
check('three agents never share a slot in one bucket', !collision && seen.size === 12)

const restarted = make(1)
const slot = slotOf(restarted.stamp(address()))
check('a restarted agent resumes past its used slots', !seen.has(slot) && slot % 3 === 1)

const single = createPartitionedStamper({ signer, batchId, depth, agentIndex: 0, partitions: 1, statePath: pathToFileURL(join(dir, 'single.bin')) })
const reference = Stamper.fromBlank(signer, batchId, depth)
const addr = address()
check('with one partition it stamps the same index as bee-js Stamper',
  Buffer.from(single.stamp(addr).index).equals(Buffer.from(reference.stamp(addr).index)))

console.log(`\nRESULT: ${failed ? 'FAILED' : 'passed'}`)
process.exit(failed ? 1 : 0)
