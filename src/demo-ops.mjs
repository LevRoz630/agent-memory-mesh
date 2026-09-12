import { writeMemory } from './memory.mjs'
import { writeToLane } from './lane.mjs'
import { queryByTagAndType } from './arkiv.mjs'
import { tryClaim, renewClaim, takeOver, finish as finishWork, LONG_LIVED_BLOCKS } from './protocol.mjs'
import { WORK_STEPS } from './demo.mjs'

function signerFor(ctx, agentId) {
  const signer = ctx.signers.get(agentId)
  if (!signer) throw new Error(`no signer configured for "${agentId}", set ARKIV_PRIVATE_KEY_${agentId.toUpperCase()}`)
  return signer
}

export function createDemoOps(ctx) {
  return {
    async reportIncident(tag, report) {
      const atlas = signerFor(ctx, 'atlas')
      const written = await writeMemory(atlas.wallet, {
        agentId: 'atlas', memoryType: 'event', tag, importance: 9, content: report, ttlBlocks: LONG_LIVED_BLOCKS,
      })
      return { swarmRef: written.swarmRef, entityKey: written.entityKey }
    },

    tryClaim: (agentId, tag) => tryClaim(ctx, agentId, tag),

    renewClaim: (agentId, entityKey, shouldContinue) => renewClaim(ctx, agentId, entityKey, undefined, shouldContinue),

    async readProgress(tag) {
      const lanes = await takeOver(ctx, tag)
      return lanes.reduce((max, lane) => (
        lane.latestContent?.kind === 'progress' ? Math.max(max, lane.latestContent.step + 1) : max
      ), 0)
    },

    // takeOver() finds lanes through `lane` rows on Arkiv, so the row has to exist from the first
    // step, not only at finish, or a successor can't see a dead agent's progress.
    async recordStep(agentId, tag, step, laneIndex) {
      const signer = signerFor(ctx, agentId)
      const privateKeyHex = process.env[`ARKIV_PRIVATE_KEY_${agentId.toUpperCase()}`]
      await writeToLane(privateKeyHex, signer.account.address, tag, laneIndex, { kind: 'progress', step, action: WORK_STEPS[step] })
      if (laneIndex === 0) {
        await writeMemory(signer.wallet, {
          agentId, memoryType: 'lane', tag, importance: 5, content: { note: 'lane provenance marker' }, ttlBlocks: LONG_LIVED_BLOCKS,
        })
      }
    },

    finish: (agentId, tag, entityKey) => finishWork(ctx, agentId, tag, entityKey, { note: `rack R12 recovered by ${agentId}` }),

    async isDone(tag) {
      return (await queryByTagAndType(ctx.pub, { tag, memoryType: 'done', limit: 1 })).length > 0
    },
  }
}
