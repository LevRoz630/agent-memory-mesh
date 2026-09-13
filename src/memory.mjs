import { uploadMemory } from './swarm.mjs'
import { createMemory } from './arkiv.mjs'

export async function writeMemory(wallet, { agentId, memoryType, tag, importance, content, ttlBlocks, outcome }) {
  const swarmRef = await uploadMemory(content)
  const { entityKey, txHash, appliedExpiresAt } = await createMemory(wallet, {
    agentId, memoryType, tag, importance, swarmRef, ttlBlocks, outcome,
  })
  return { entityKey, txHash, swarmRef, appliedExpiresAt }
}
