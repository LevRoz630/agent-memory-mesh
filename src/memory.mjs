import { uploadMemory, downloadMemory } from './swarm.mjs'
import { createMemory } from './arkiv.mjs'

export async function writeMemory(wallet, { agentId, memoryType, tag, importance, content, ttlBlocks, outcome }) {
  const swarmRef = await uploadMemory(content)
  const { entityKey, txHash, appliedExpiresAt } = await createMemory(wallet, {
    agentId, memoryType, tag, importance, swarmRef, ttlBlocks, outcome,
  })
  return { entityKey, txHash, swarmRef, appliedExpiresAt }
}

export async function readMemoryContent(attributes) {
  const ref = attributes.swarm_ref
  if (!ref) throw new Error('entity has no swarm_ref attribute — not an agent_memory entity')
  return downloadMemory(ref)
}
