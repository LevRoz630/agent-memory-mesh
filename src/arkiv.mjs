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

import { createPublicClient, createWalletClient, ExpirationTime, addr, str, u64, stringToPayload } from '@arkiv-network/sdk'
import { tiramisu } from '@arkiv-network/sdk/chains'
import { and, eq, or, startsWith } from '@arkiv-network/sdk/query'
import { http, webSocket } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ROSTER, isRosterAddress } from './roster.mjs'

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
// key the server happened to hold. Each wallet counts its own nonces (see mutate). An agent
// with no key configured is left out instead of silently falling back to another agent's
// signer: writing as the wrong identity is worse than refusing the write.
export function makeAgentSigners({ httpUrl } = {}) {
  const signers = new Map()
  for (const agentId of AGENT_IDS) {
    const privateKey = process.env[`ARKIV_PRIVATE_KEY_${agentId.toUpperCase()}`]
    if (!privateKey) continue
    const account = privateKeyToAccount(privateKey)
    signers.set(agentId, { account, wallet: makeWallet(account, httpUrl) })
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
  const account = privateKeyToAccount(privateKey)
  const pub = createPublicClient({ chain: tiramisu, transport: http(httpUrl, { cacheTime: 0 }) })
  return { account, pub, wallet: makeWallet(account, httpUrl) }
}

// The transport reports each broadcast to the wallet's send queue, which is how mutate knows a nonce
// has been spent.
function makeWallet(account, httpUrl) {
  const sender = { tail: Promise.resolve(), nextNonce: null, onBroadcast: null }
  const base = http(httpUrl, { cacheTime: 0 })
  const transport = (options) => {
    const t = base(options)
    return {
      ...t,
      async request(args, requestOptions) {
        const result = await t.request(args, requestOptions)
        if (args.method === 'eth_sendRawTransaction') sender.onBroadcast?.()
        return result
      },
    }
  }
  return Object.assign(createWalletClient({ account, chain: tiramisu, transport }), { sender })
}

// A wallet's writes are prepared and broadcast one at a time, with nonces counted here. Concurrent
// writes can't share a nonce (1 of 6 lands, finding 3), and viem's nonceManager, the usual fix, spends
// a nonce before the SDK estimates gas and never gives it back when the estimate fails, e.g. renewing a
// claim that just lapsed. Every later write from that wallet, heartbeats included, then waits behind
// the gap (finding 6). Here a write that never reached the node leaves its nonce for the next one. The
// queue moves on at the broadcast, so receipts are still awaited concurrently.
async function mutate(wallet, send) {
  const { sender } = wallet
  const turn = sender.tail
  let release
  sender.tail = new Promise((resolve) => { release = resolve })
  await turn
  let broadcast = false
  try {
    sender.nextNonce ??= await wallet.getTransactionCount({ address: wallet.account.address, blockTag: 'pending' })
    const nonce = sender.nextNonce
    sender.onBroadcast = () => {
      broadcast = true
      sender.nextNonce = nonce + 1
      sender.onBroadcast = null
      release()
    }
    return await send({ nonce })
  } catch (e) {
    // A rejected broadcast may still have reached the node, so recount from the chain next time.
    if (!broadcast) sender.nextNonce = null
    throw e
  } finally {
    if (!broadcast) {
      sender.onBroadcast = null
      release()
    }
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
  const { entityKey, txHash, expiresAt } = await mutate(wallet, (txParams) => wallet.createEntity({
    expires: ExpirationTime.fromBlocks(ttlBlocks),
    payload: stringToPayload(''),
    contentType: 'application/octet-stream',
    attributes,
  }, txParams))
  return { entityKey, txHash, appliedExpiresAt: expiresAt }
}

// The engine gates both of these on ownership: a non-owner is rejected with "entity <key> is
// owned by <addr>, not <addr>". With one wallet per agent that means no agent can renew or
// release another's claim, so lapsing is the only way an abandoned claim frees up.
export async function extendMemory(wallet, { entityKey, ttlBlocks }) {
  await mutate(wallet, (txParams) => wallet.extendEntity({ entityKey, expires: ExpirationTime.fromBlocks(ttlBlocks) }, txParams))
}

export async function deleteMemory(wallet, { entityKey }) {
  await mutate(wallet, (txParams) => wallet.deleteEntity({ entityKey }, txParams))
}

// Reads hand back typed wrappers ({ type: 'str', value: 'atlas' }), asymmetric with the
// str()/u64() write path.
export function unwrapAttributes(attrs) {
  return Object.fromEntries(Object.entries(attrs ?? {}).map(([k, v]) => [k, v?.value ?? v]))
}

// Arkiv is permissionless and `app` is only a label: any wallet can write a hydra-shaped row. Only the
// roster's own wallets are believed, or a stranger could fake a heartbeat, a claim or a `done`. The
// owners go into the query itself: filtered only after a limited fetch, a stranger's rows could fill
// the page and hide the roster's (one fake heartbeat is enough against `limit: 1`).
const ROSTER_OWNED = or(...Object.values(ROSTER).map(({ address }) => eq('$owner', addr(address))))

// select('*') silently omits `owner` on the live Tiramisu node, so this lists fields explicitly.
async function runQuery(pub, pred, limit) {
  const result = await pub.select({ key: true, owner: true, expiresAt: true, attributes: true }).where(and(pred, ROSTER_OWNED)).limit(limit).fetch()
  const entities = Array.isArray(result) ? result : (result?.entities ?? [])
  return entities.filter((e) => isRosterAddress(e.owner)).map((e) => ({ ...e, attributes: unwrapAttributes(e.attributes) }))
}

export async function queryByTagAndType(pub, { tag, memoryType, limit = 20 }) {
  return runQuery(pub, and(eq(ATTR.app, str(APP)), eq(ATTR.tag, str(tag)), eq(ATTR.memoryType, str(memoryType))), limit)
}

export async function queryByTagPrefixAndType(pub, { tagPrefix, memoryType, limit = 50 }) {
  return runQuery(pub, and(eq(ATTR.app, str(APP)), startsWith(ATTR.tag, str(tagPrefix)), eq(ATTR.memoryType, str(memoryType))), limit)
}
