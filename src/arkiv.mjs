// Arkiv index for agent_memory entities. Content itself lives on Swarm (src/swarm.mjs); this
// file only touches the pointer and metadata.
//
// Attribute names must be snake_case: the SDK's client-side validator accepts agentId, the
// engine's charset rejects it on-chain.

import { createPublicClient, createWalletClient, ExpirationTime, str, u64, stringToPayload } from '@arkiv-network/sdk'
import { tiramisu } from '@arkiv-network/sdk/chains'
import { and, eq, gte, or, startsWith } from '@arkiv-network/sdk/query'
import { http, webSocket } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { nonceManager } from 'viem/nonce'

const ATTR = {
  agentId: 'agent_id',
  memoryType: 'memory_type',
  tag: 'tag',
  importance: 'importance',
  swarmRef: 'swarm_ref',
}

export function makeClients({ privateKey, httpUrl, wsUrl }) {
  // Without nonceManager, concurrent createEntity calls from this wallet race on the same
  // nonce and only one lands (1/6 vs 6/6 live).
  const account = privateKeyToAccount(privateKey, { nonceManager })
  const pub = createPublicClient({ chain: tiramisu, transport: http(httpUrl, { cacheTime: 0 }) })
  const wallet = createWalletClient({ account, chain: tiramisu, transport: http(httpUrl, { cacheTime: 0 }) })
  // watchEntityEvents needs its own websocket-transport client; the HTTP client's transport
  // would not open a real subscription.
  const wsClient = createPublicClient({ chain: tiramisu, transport: webSocket(wsUrl) })
  return { account, pub, wallet, wsClient }
}

// The applied expiry is resolved against whatever block the tx lands in, so it can sit past
// what ttlBlocks asked for. Both are returned.
export async function createMemory(wallet, { agentId, memoryType, tag, importance, swarmRef, ttlBlocks }) {
  const { entityKey, txHash, expiresAt } = await wallet.createEntity({
    expires: ExpirationTime.fromBlocks(ttlBlocks),
    payload: stringToPayload(''),
    contentType: 'application/octet-stream',
    attributes: {
      [ATTR.agentId]: str(agentId),
      [ATTR.memoryType]: str(memoryType),
      [ATTR.tag]: str(tag),
      [ATTR.importance]: u64(BigInt(importance)),
      [ATTR.swarmRef]: str(swarmRef),
    },
  })
  return { entityKey, txHash, requestedTtlBlocks: ttlBlocks, appliedExpiresAt: expiresAt }
}

// Reads hand back typed wrappers ({ type: 'str', value: 'atlas' }), asymmetric with the
// str()/u64() write path.
export function unwrapAttributes(attrs) {
  return Object.fromEntries(Object.entries(attrs ?? {}).map(([k, v]) => [k, v?.value ?? v]))
}

// An explicit field list rather than select('*'), which silently omits `owner` on the live
// Tiramisu node.
async function runQuery(pub, pred, limit) {
  const result = await pub.select({ key: true, owner: true, expiresAt: true, attributes: true }).where(pred).limit(limit).fetch()
  const entities = Array.isArray(result) ? result : (result?.entities ?? [])
  return entities.map((e) => ({ ...e, attributes: unwrapAttributes(e.attributes) }))
}

export async function queryMemories(pub, { agentId, memoryType, minImportance, tagPrefix, limit = 50 }) {
  const clauses = [eq(ATTR.agentId, str(agentId))]
  if (memoryType) clauses.push(eq(ATTR.memoryType, str(memoryType)))
  if (minImportance !== undefined) clauses.push(gte(ATTR.importance, u64(BigInt(minImportance))))
  if (tagPrefix) clauses.push(startsWith(ATTR.tag, str(tagPrefix)))
  const pred = clauses.length === 1 ? clauses[0] : and(...clauses)
  return runQuery(pub, pred, limit)
}

// Arkiv rejects a query with no predicate, so "recent" is an OR across known agent ids rather
// than an unfiltered scan.
export async function queryRecent(pub, { agentIds = ['atlas', 'nova'], limit = 20 } = {}) {
  const pred = agentIds.length === 1
    ? eq(ATTR.agentId, str(agentIds[0]))
    : or(...agentIds.map((id) => eq(ATTR.agentId, str(id))))
  return runQuery(pub, pred, limit)
}

// An EntityCreated event carries only { entityKey, owner, expiresAt }, so each one has to be
// read back to tell whether it is ours; a failed read (wrong type, already expired) is skipped
// silently rather than surfaced, so unrelated chain events never reach onMemory.
//
// wsClient must use a webSocket() transport and no fromBlock may be passed, or this degrades
// to HTTP polling.
export function watchMemories(wsClient, pub, { onMemory, onEvent, onError }) {
  return wsClient.watchEntityEvents({
    onEntityCreated: async ({ entityKey, owner, expiresAt }) => {
      onEvent?.({ phase: 'event', entityKey, owner })
      try {
        const entity = await pub.getEntity(entityKey)
        const raw = entity.attributes ?? {}
        if (!(ATTR.agentId in raw)) {
          onEvent?.({ phase: 'ignored', entityKey })
          return
        }
        onEvent?.({ phase: 'resolved', entityKey, owner })
        onMemory({ entityKey, owner, expiresAt, attributes: unwrapAttributes(raw) })
      } catch {
        onEvent?.({ phase: 'error', entityKey })
      }
    },
    onError,
  })
}
