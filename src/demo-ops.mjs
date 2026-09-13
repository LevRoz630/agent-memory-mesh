import { writeMemory } from './memory.mjs'
import { writeToLane, nextFreeLaneIndex } from './lane.mjs'
import { queryByTagAndType, queryByTagPrefixAndType, AGENT_IDS } from './arkiv.mjs'
import {
  tryClaim, renewClaim, takeOver, finish as finishWork, startHeartbeat, watchForPeerOutages, publishProfile,
  verify as verifyWork, outageTagPrefix, LONG_LIVED_BLOCKS,
} from './protocol.mjs'
import { uploadPublicFile, downloadSealed, openForAnyAgent } from './swarm.mjs'
import { renderReceipt } from './receipt.mjs'
import { rackTag } from './agent.mjs'

const INFRA_TIMEOUT_MS = 5000

function signerFor(ctx, agentId) {
  const signer = ctx.signers.get(agentId)
  if (!signer) throw new Error(`no signer configured for "${agentId}", set ARKIV_PRIVATE_KEY_${agentId.toUpperCase()}`)
  return signer
}

async function infra(ctx, path, body) {
  const res = await fetch(`${ctx.infraUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-hydra-infra-token': process.env.HYDRA_INFRA_TOKEN ?? '', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(INFRA_TIMEOUT_MS),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`power controller: ${data.error ?? res.status}`)
  return data
}

const asIncident = (row) => ({ tag: row.attributes.tag, entityKey: row.key, swarmRef: row.attributes.swarm_ref })

export function createDemoOps(ctx) {
  return {
    async reportIncident(agentId, tag, report) {
      const written = await writeMemory(signerFor(ctx, agentId).wallet, {
        agentId, memoryType: 'event', tag, importance: 9, content: report, ttlBlocks: LONG_LIVED_BLOCKS,
      })
      return { swarmRef: written.swarmRef, entityKey: written.entityKey }
    },

    async listIncidents(runId) {
      const rack = await queryByTagAndType(ctx.pub, { tag: rackTag(runId), memoryType: 'event', limit: 1 })
      const outages = await Promise.all(AGENT_IDS.map((peerId) => (
        queryByTagPrefixAndType(ctx.pub, { tagPrefix: outageTagPrefix(peerId, runId), memoryType: 'event' })
      )))
      const rows = [...rack, ...outages.flat()].map(asIncident)
      return rows.filter((row, i) => rows.findIndex((r) => r.tag === row.tag) === i)
    },

    tryClaim: (agentId, tag) => tryClaim(ctx, agentId, tag),

    startHeartbeat: (agentId, shouldContinue) => startHeartbeat(ctx, agentId, shouldContinue),

    publishProfile: (agentId, profile) => publishProfile(ctx, agentId, profile),

    watchForPeerOutages: (agentId, scope, onOutage) => watchForPeerOutages(ctx, agentId, scope, onOutage),

    verify: (agentId, tag, probe) => verifyWork(ctx, agentId, tag, probe),

    renewClaim: (agentId, entityKey, shouldContinue) => renewClaim(ctx, agentId, entityKey, undefined, shouldContinue),

    async readProgress(tag) {
      const lanes = await takeOver(ctx, tag)
      return lanes.reduce((max, lane) => (
        lane.latestContent?.kind === 'progress' ? Math.max(max, lane.latestContent.step + 1) : max
      ), 0)
    },

    nextLaneIndex: (agentId, tag) => nextFreeLaneIndex(signerFor(ctx, agentId).account.address, tag),

    async recordStep(agentId, tag, step, laneIndex, action) {
      const signer = signerFor(ctx, agentId)
      const privateKeyHex = process.env[`ARKIV_PRIVATE_KEY_${agentId.toUpperCase()}`]
      await writeToLane(privateKeyHex, signer.account.address, tag, laneIndex, { kind: 'progress', step, action })
    },

    finish: (agentId, tag, entityKey) => finishWork(ctx, agentId, tag, entityKey, { note: `${tag} resolved by ${agentId}` }),

    async isDone(tag) {
      return (await queryByTagAndType(ctx.pub, { tag, memoryType: 'done', limit: 1 })).length > 0
    },

    publishReceipt: (state) => uploadPublicFile('receipt.svg', 'image/svg+xml', Buffer.from(renderReceipt(state), 'utf8')),

    infraStatus: () => infra(ctx, '/status'),

    setDcPower: (dcId, power) => infra(ctx, `/dc/${encodeURIComponent(dcId)}/power`, { power }),

    powerCycleRack: (rackId) => infra(ctx, `/rack/${encodeURIComponent(rackId)}/power-cycle`, {}),

    async decrypt(ref) {
      const sealed = await downloadSealed(ref)
      return { bytes: sealed.length, report: JSON.parse(openForAnyAgent(sealed).toString('utf8')) }
    },
  }
}
