// The whole write/read flow, combining src/swarm.mjs (content) and src/arkiv.mjs (index).
// This is the module NOTES.md's architecture section describes.

import { uploadMemory, downloadMemory } from './swarm.mjs'
import { createMemory } from './arkiv.mjs'

/**
 * Encrypts + uploads `content` to Swarm, then indexes the pointer on Arkiv. One round trip
 * through both systems — this is the write path.
 */
export async function writeMemory(wallet, { agentId, memoryType, tag, importance, content, ttlBlocks }) {
  const swarmRef = await uploadMemory(content)
  const { entityKey, txHash, requestedTtlBlocks, appliedExpiresAt } = await createMemory(wallet, {
    agentId, memoryType, tag, importance, swarmRef, ttlBlocks,
  })
  return { entityKey, txHash, swarmRef, requestedTtlBlocks, appliedExpiresAt }
}

/**
 * Given an Arkiv entity's attributes (from getEntity or a query result), fetches and
 * decrypts the actual memory content from Swarm.
 */
export async function readMemoryContent(attributes) {
  const ref = attributes.swarm_ref
  if (!ref) throw new Error('entity has no swarm_ref attribute — not an agent_memory entity')
  return downloadMemory(ref)
}
