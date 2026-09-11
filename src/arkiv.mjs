// Arkiv index for Agent Memory Mesh: the agent_memory entity type. Content lives on Swarm
// (src/swarm.mjs) — this file only ever touches the pointer + metadata.
//
// Verified against @arkiv-network/sdk's shipped source (node_modules/@arkiv-network/sdk/src),
// not just its docs, before writing this — the shipped tests/source were the most reliable
// reference in pre-flight and that held here too:
//   - watchEntityEvents' onEntityCreated carries only { entityKey, owner, expiresAt } plus
//     block context — never attributes or payload. Confirmed straight from
//     src/actions/public/watchEntityEvents.ts and src/types/events.ts.
//   - ExpirationTime.fromBlocks(n) takes a plain positive integer, exact, no rounding.
//   - createEntity's returned expiresAt is a LOWER BOUND for from*() duration helpers — the
//     engine resolves it against whatever block the tx actually lands in, so requested and
//     applied can differ. Record both.
//
// Attribute names are snake_case ONLY — the engine's charset is lowercase, digits, _, -, .
// (verified in pre-flight: smoke/attr-charset.mjs). agentId/memoryType/swarmRef would be
// silently accepted by the SDK's client-side validator and rejected on-chain.

import { createPublicClient, createWalletClient, ExpirationTime, str, u64, stringToPayload } from '@arkiv-network/sdk'
import { tiramisu } from '@arkiv-network/sdk/chains'
import { and, eq, gte, startsWith } from '@arkiv-network/sdk/query'
import { http, webSocket } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const ATTR = {
  agentId: 'agent_id',
  memoryType: 'memory_type',
  tag: 'tag',
  importance: 'importance',
  swarmRef: 'swarm_ref',
}

export function makeClients({ privateKey, httpUrl, wsUrl }) {
  const account = privateKeyToAccount(privateKey)
  const pub = createPublicClient({ chain: tiramisu, transport: http(httpUrl, { cacheTime: 0 }) })
  const wallet = createWalletClient({ account, chain: tiramisu, transport: http(httpUrl, { cacheTime: 0 }) })
  // A SEPARATE websocket client for watchEntityEvents — sharing the HTTP client's transport
  // would not open a real subscription. wsUrl only needed by callers that watch.
  const wsClient = wsUrl
    ? createPublicClient({ chain: tiramisu, transport: webSocket(wsUrl) })
    : null
  return { account, pub, wallet, wsClient }
}

/**
 * Writes one agent_memory entity. `ttlBlocks` is required and explicit — this schema has no
 * "just use the default" case, since expiry IS the mechanic (Mission 02).
 *
 * Returns both the requested lifetime (in blocks) and the applied expiry (the real block
 * height from the receipt) — they can differ, per ExpirationTime.fromBlocks' own docs.
 */
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

/**
 * Compound query: agent_id = X AND memory_type = Y [AND importance >= minImportance]
 * [AND tag STARTSWITH tagPrefix]. This is the query-depth demo — real filters, not an id
 * lookup.
 */
export async function queryMemories(pub, { agentId, memoryType, minImportance, tagPrefix, limit = 50 }) {
  const clauses = [eq(ATTR.agentId, str(agentId))]
  if (memoryType) clauses.push(eq(ATTR.memoryType, str(memoryType)))
  if (minImportance !== undefined) clauses.push(gte(ATTR.importance, u64(BigInt(minImportance))))
  if (tagPrefix) clauses.push(startsWith(ATTR.tag, str(tagPrefix)))

  const pred = clauses.length === 1 ? clauses[0] : and(...clauses)
  const result = await pub.select('*').where(pred).limit(limit).fetch()
  return Array.isArray(result) ? result : (result?.entities ?? [])
}

/**
 * The Mission 03 leg. Fires onMemory(fullEntity) only for entities this app's schema cares
 * about — every EntityCreated event is filtered by attempting the read, and a read that
 * fails (wrong type, expired between event and read, not one of ours) is silently skipped
 * rather than surfaced as an error. An irrelevant chain event must NOT reach onMemory; that
 * silence is the thing to demo, not a bug to fix.
 *
 * wsClient MUST be a webSocket()-transport client, and this call passes no fromBlock — both
 * required for a real subscription rather than HTTP polling (verified in pre-flight,
 * evidence/ws-proxy.mjs).
 */
export function watchMemories(wsClient, pub, onMemory, onError) {
  return wsClient.watchEntityEvents({
    onEntityCreated: async ({ entityKey, owner }) => {
      // The event carries no attributes — this bounded follow-up read is what actually
      // fetches them. `owner` above is the only pre-read filter available; real
      // attribute-based filtering happens after this read, on the fetched entity.
      try {
        const entity = await pub.getEntity(entityKey)
        const a = entity.attributes ?? {}
        if (!(ATTR.agentId in a)) return // not an agent_memory entity — irrelevant, skip silently
        onMemory({ entityKey, owner, attributes: a })
      } catch {
        // Expired/deleted between the event firing and this read, or a transient RPC error.
        // Not fatal to the watcher — skip this one entity and keep watching.
      }
    },
    onError,
    // no fromBlock — see module docstring
  })
}
