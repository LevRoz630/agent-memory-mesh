// Arkiv index for agent_memory entities. Content itself lives on Swarm (src/swarm.mjs); this
// file only touches the pointer and metadata.
//
// Verified against @arkiv-network/sdk's shipped source, not just its docs:
//   - ExpirationTime.fromBlocks(n) takes a plain positive integer, exact, no rounding.
//   - createEntity's returned expiresAt is a LOWER BOUND for from*() duration helpers. The
//     engine resolves it against whatever block the tx actually lands in, so requested and
//     applied can differ. Record both.
//
// Attribute names are snake_case only: the engine's charset is lowercase, digits, _, -, .
// agentId/memoryType/swarmRef would pass the SDK's client-side validator and then get
// rejected on-chain.

import { createPublicClient, createWalletClient, ExpirationTime, str, u64, stringToPayload } from '@arkiv-network/sdk'
import { tiramisu } from '@arkiv-network/sdk/chains'
import { and, eq, startsWith } from '@arkiv-network/sdk/query'
import { http, webSocket } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { nonceManager } from 'viem/nonce'
import { isRosterAddress } from './roster.mjs'

const ATTR = {
  app: 'app',
  agentId: 'agent_id',
  memoryType: 'memory_type',
  tag: 'tag',
  importance: 'importance',
  swarmRef: 'swarm_ref',
  outcome: 'outcome',
}

// Written on every entity so the index can be selected as a whole. Arkiv rejects a
// predicate-free query, and an OR across known agent ids doesn't survive a third agent.
const APP = 'hydra'

export const AGENT_IDS = ['atlas', 'nova', 'sol']

const MEMORY_TYPES = ['event', 'claim', 'lane', 'done', 'verdict', 'heartbeat']

// One signer per agent, so `owner` on an entity is whichever agent wrote it, not whichever
// key the server happened to hold. Each account carries its own nonce sequence. An agent
// with no key configured is left out instead of silently falling back to another agent's
// signer: writing as the wrong identity is worse than refusing the write.
export function makeAgentSigners({ httpUrl } = {}) {
  const signers = new Map()
  for (const agentId of AGENT_IDS) {
    const privateKey = process.env[`ARKIV_PRIVATE_KEY_${agentId.toUpperCase()}`]
    if (!privateKey) continue
    const account = privateKeyToAccount(privateKey, { nonceManager })
    const wallet = createWalletClient({ account, chain: tiramisu, transport: http(httpUrl, { cacheTime: 0 }) })
    signers.set(agentId, { account, wallet })
  }
  return signers
}

// Reads need a client, not an identity.
export function makePublicClient({ httpUrl } = {}) {
  return createPublicClient({ chain: tiramisu, transport: http(httpUrl, { cacheTime: 0 }) })
}

// Subscriptions need a websocket transport: over http(), watchEntityEvents quietly polls eth_getLogs.
export function makeStreamClient({ wsUrl } = {}) {
  return createPublicClient({ chain: tiramisu, transport: webSocket(wsUrl) })
}

export function makeClients({ privateKey, httpUrl }) {
  // Without nonceManager, concurrent createEntity calls from this wallet race on the same
  // nonce and only one lands (1/6 vs 6/6 live).
  const account = privateKeyToAccount(privateKey, { nonceManager })
  const pub = createPublicClient({ chain: tiramisu, transport: http(httpUrl, { cacheTime: 0 }) })
  const wallet = createWalletClient({ account, chain: tiramisu, transport: http(httpUrl, { cacheTime: 0 }) })
  return { account, pub, wallet }
}

// viem's nonce manager hands a nonce out before the SDK estimates gas and never takes it back when the
// estimate fails, e.g. renewing a claim that just lapsed. Every later transaction from that wallet then
// waits behind the gap, heartbeats included, until something reuses the lost nonce. Forgetting the
// cached nonce makes the next write do that.
async function mutate(wallet, send) {
  try {
    return await send()
  } catch (e) {
    if (!e.txHash) wallet.account?.nonceManager?.reset({ address: wallet.account.address, chainId: wallet.chain.id })
    throw e
  }
}

// The applied expiry is resolved against whatever block the tx lands in, so it can sit past
// what ttlBlocks asked for. Both are returned.
export async function createMemory(wallet, { agentId, memoryType, tag, importance, swarmRef, ttlBlocks, outcome }) {
  if (!MEMORY_TYPES.includes(memoryType)) {
    throw new Error(`Invalid memory_type "${memoryType}" — must be one of: ${MEMORY_TYPES.join(', ')}`)
  }
  const attributes = {
    [ATTR.app]: str(APP),
    [ATTR.agentId]: str(agentId),
    [ATTR.memoryType]: str(memoryType),
    [ATTR.tag]: str(tag),
    [ATTR.importance]: u64(BigInt(importance)),
    [ATTR.swarmRef]: str(swarmRef),
  }
  if (outcome !== undefined) attributes[ATTR.outcome] = str(outcome)
  const { entityKey, txHash, expiresAt } = await mutate(wallet, () => wallet.createEntity({
    expires: ExpirationTime.fromBlocks(ttlBlocks),
    payload: stringToPayload(''),
    contentType: 'application/octet-stream',
    attributes,
  }))
  return { entityKey, txHash, appliedExpiresAt: expiresAt }
}

// The engine gates both of these on ownership: a non-owner is rejected with "entity <key> is
// owned by <addr>, not <addr>". With one wallet per agent that means no agent can renew or
// release another's claim, so lapsing is the only way an abandoned claim frees up.
export async function extendMemory(wallet, { entityKey, ttlBlocks }) {
  await mutate(wallet, () => wallet.extendEntity({ entityKey, expires: ExpirationTime.fromBlocks(ttlBlocks) }))
}

export async function deleteMemory(wallet, { entityKey }) {
  await mutate(wallet, () => wallet.deleteEntity({ entityKey }))
}

// Reads hand back typed wrappers ({ type: 'str', value: 'atlas' }), asymmetric with the
// str()/u64() write path.
export function unwrapAttributes(attrs) {
  return Object.fromEntries(Object.entries(attrs ?? {}).map(([k, v]) => [k, v?.value ?? v]))
}

// select('*') silently omits `owner` on the live Tiramisu node, so this lists fields explicitly.
async function runQuery(pub, pred, limit) {
  const result = await pub.select({ key: true, owner: true, expiresAt: true, attributes: true }).where(pred).limit(limit).fetch()
  const entities = Array.isArray(result) ? result : (result?.entities ?? [])
  // Arkiv is permissionless and `app` is only a label: any wallet can write a hydra-shaped row. Only
  // the roster's own wallets are believed, or a stranger could fake a heartbeat, a claim or a `done`.
  return entities.filter((e) => isRosterAddress(e.owner)).map((e) => ({ ...e, attributes: unwrapAttributes(e.attributes) }))
}

export async function queryByTagAndType(pub, { tag, memoryType, limit = 20 }) {
  return runQuery(pub, and(eq(ATTR.app, str(APP)), eq(ATTR.tag, str(tag)), eq(ATTR.memoryType, str(memoryType))), limit)
}

export async function queryByTagPrefixAndType(pub, { tagPrefix, memoryType, limit = 50 }) {
  return runQuery(pub, and(eq(ATTR.app, str(APP)), startsWith(ATTR.tag, str(tagPrefix)), eq(ATTR.memoryType, str(memoryType))), limit)
}
