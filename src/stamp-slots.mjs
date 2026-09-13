// A stamper for one of several processes sharing a postage batch. Each bucket's slots are dealt out
// round-robin across partitions, so partition i only ever uses slots n*partitions + i, and the
// per-bucket counters are written to disk after every stamp so a restart resumes past them.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stamp } from '@ethersphere/core-sdk'

const BUCKETS = 65536

function loadCounts(statePath) {
  try {
    const buf = readFileSync(statePath)
    return new Uint32Array(buf.buffer, buf.byteOffset, BUCKETS).slice()
  } catch (e) {
    if (e.code === 'ENOENT') return new Uint32Array(BUCKETS)
    throw e
  }
}

export function createPartitionedStamper({ signer, batchId, depth, agentIndex, partitions, statePath }) {
  if (!(agentIndex >= 0 && agentIndex < partitions)) throw new Error(`agent index ${agentIndex} is outside ${partitions} partitions`)
  const counts = loadCounts(statePath)
  const maxSlot = 2 ** (depth - 16)
  mkdirSync(dirname(fileURLToPath(statePath)), { recursive: true })
  return {
    stamp(address) {
      const bucket = (address[0] << 8) | address[1]
      const slot = counts[bucket] * partitions + agentIndex
      if (slot >= maxSlot) throw new Error(`bucket ${bucket} has no free slot left for agent index ${agentIndex}`)
      const envelope = stamp(signer, batchId, address, slot)
      counts[bucket] += 1
      writeFileSync(statePath, Buffer.from(counts.buffer))
      return envelope
    },
  }
}
