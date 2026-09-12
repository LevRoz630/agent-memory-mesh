// Arkiv index for agent_memory entities. Content itself lives on Swarm (src/swarm.mjs); this
// file only touches the pointer and metadata.
//
// Verified against @arkiv-network/sdk's shipped source, not just its docs:
//   - watchEntityEvents' onEntityCreated carries only { entityKey, owner, expiresAt } plus
//     block context
//   - ExpirationTime.fromBlocks(n) takes a plain positive integer, exact, no rounding.
//   - createEntity's returned expiresAt is a LOWER BOUND for from*() duration helpers — the
//     engine resolves it against whatever block the tx actually lands in, so requested and
//     applied can differ. Record both.
//
// Attribute names are snake_case ONLY — the engine's charset is lowercase, digits, _, -, .
// agentId/memoryType/swarmRef would be silently accepted by the SDK's client-side validator
// and rejected on-chain.

import { createPublicClient, createWalletClient, ExpirationTime, str, u64, stringToPayload } from '@arkiv-network/sdk'
import { tiramisu } from '@arkiv-network/sdk/chains'
import { and, eq, gte, startsWith } from '@arkiv-network/sdk/query'
import { http, webSocket } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { nonceManager } from 'viem/nonce'

const ATTR = {
  app: 'app',
  agentId: 'agent_id',
  memoryType: 'memory_type',
  tag: 'tag',
  importance: 'importance',
  swarmRef: 'swarm_ref',
}

// Written on every entity so the index can be selected as a whole — Arkiv rejects a
// predicate-free query, and an OR across known agent ids does not survive a third agent.
const APP = 'agent-memory-mesh'

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
      [ATTR.app]: str(APP),
      [ATTR.agentId]: str(agentId),
      [ATTR.memoryType]: str(memoryType),
      [ATTR.tag]: str(tag),
      [ATTR.importance]: u64(BigInt(importance)),
      [ATTR.swarmRef]: str(swarmRef),
    },
  })
  return { entityKey, txHash, appliedTtlBlocks: ttlBlocks, appliedExpiresAt: expiresAt }
}

// Both of these are gated on ownership by the engine — a non-owner is rejected with
// "entity <key> is owned by <addr>, not <addr>". With one wallet per agent that means no agent
// can renew or release another's claim, so lapsing is the only way an abandoned claim frees up.
export async function extendMemory(wallet, { entityKey, ttlBlocks }) {
  const { txHash, expiresAt } = await wallet.extendEntity({
    entityKey,
    expires: ExpirationTime.fromBlocks(ttlBlocks),
  })
  return { entityKey, txHash, appliedTtlBlocks: ttlBlocks, appliedExpiresAt: expiresAt }
}

export async function deleteMemory(wallet, { entityKey }) {
  const { txHash } = await wallet.deleteEntity({ entityKey })
  return { entityKey, txHash }
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

// Arkiv rejects a query with no predicate, and `app` is the one attribute every participant
// writes — so this selects the whole index without enumerating who is on it.
export async function queryRecent(pub, { limit = 20 } = {}) {
  return runQuery(pub, eq(ATTR.app, str(APP)), limit)
}

// "Is anyone on this?" has to be answerable regardless of who wrote the claim, so it cannot go
// through queryMemories, which is scoped to a single agent_id.
export async function queryByTag(pub, { tag, limit = 20 }) {
  return runQuery(pub, and(eq(ATTR.app, str(APP)), eq(ATTR.tag, str(tag))), limit)
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
        if (raw[ATTR.app]?.value !== APP) {
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
