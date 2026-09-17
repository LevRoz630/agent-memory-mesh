// The control room's own view of the chain: an Arkiv log subscription and a block-head subscription,
// both over a websocket. It holds no keys and reads nothing from the agents, so what it shows is what
// Tiramisu says, not what an agent reported about itself.

import { ROSTER } from './roster.mjs'
import { unwrapAttributes } from './arkiv.mjs'

const AGENT_BY_ADDRESS = new Map(Object.entries(ROSTER).map(([id, { address }]) => [address.toLowerCase(), id]))
const FEED_LENGTH = 30
// A healthy stream sees a head every ~2s, so this long without one means the subscription went quiet.
const STALL_MS = 15000
const RETRY_MS = 3000

export function createChainWatch({ client, onUpdate = () => {} }) {
  let head = null
  const rows = new Map()
  const feed = []
  let stop = null
  let stallTimer = null

  function getState() {
    const latest = {}
    for (const r of rows.values()) {
      if (r.memoryType === 'heartbeat' && !(latest[r.agentId] >= r.expiresAt)) latest[r.agentId] = r.expiresAt
    }
    const heartbeats = Object.fromEntries(Object.entries(latest).map(([id, at]) => [id, String(at)]))
    return { head: head === null ? null : String(head), heartbeats, feed: structuredClone(feed) }
  }
  const emit = () => onUpdate(getState())

  function note(kind, row, blockNumber) {
    feed.unshift({ kind, block: String(blockNumber), agentId: row.agentId, memoryType: row.memoryType, tag: row.tag, entityKey: row.entityKey, expiresAt: row.expiresAt === undefined ? null : String(row.expiresAt) })
    feed.length = Math.min(feed.length, FEED_LENGTH)
  }

  // Events carry no attributes, so a row's role is read once, the first time its key is seen.
  async function describe(entityKey, agentId, expiresAt) {
    if (rows.has(entityKey)) return rows.get(entityKey)
    const { attributes } = await client.getEntity(entityKey)
    const a = unwrapAttributes(attributes)
    if (a.app !== 'hydra') return null
    const row = { entityKey, agentId, memoryType: a.memory_type, tag: a.tag, expiresAt }
    rows.set(entityKey, row)
    return row
  }

  async function onEvent(event) {
    const agentId = AGENT_BY_ADDRESS.get(String(event.owner).toLowerCase())
    if (!agentId) return
    try {
      if (event.type === 'EntityDeleted') {
        const row = rows.get(event.entityKey)
        if (!row) return
        rows.delete(event.entityKey)
        note('deleted', row, event.blockNumber)
      } else if (event.type === 'EntityCreated' || event.type === 'ExpiryExtended') {
        const row = await describe(event.entityKey, agentId, event.expiresAt)
        if (!row) return
        row.expiresAt = event.expiresAt
        // A heartbeat renews every two blocks; the lease bars show those, the feed would drown in them.
        if (event.type === 'EntityCreated') note('created', row, event.blockNumber)
        else if (row.memoryType !== 'heartbeat') note('extended', row, event.blockNumber)
      } else {
        return
      }
      emit()
    } catch (e) {
      console.error(`chain watch: could not read ${event.entityKey}: ${e.message}`)
    }
  }

  function onHead(blockNumber) {
    head = blockNumber
    for (const [key, row] of rows) {
      if (row.expiresAt >= head) continue
      rows.delete(key)
      note('expired', row, head)
    }
    armStallTimer()
    emit()
  }

  function armStallTimer() {
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => restart(`no block head for ${STALL_MS / 1000}s`), STALL_MS)
  }

  // viem reconnects a dropped socket but does not restore the subscriptions behind it.
  function restart(reason) {
    console.error(`chain watch: ${reason}, resubscribing`)
    stop?.()
    stop = null
    clearTimeout(stallTimer)
    stallTimer = setTimeout(start, RETRY_MS)
  }

  function start() {
    const onError = (e) => restart(e.message.split('\n')[0])
    // No fromBlock: passing one makes viem poll eth_getLogs even over a websocket.
    const unwatchEvents = client.watchEntityEvents({ onEvent, onError })
    const unwatchHeads = client.watchBlockNumber({ onBlockNumber: onHead, onError })
    stop = () => {
      unwatchEvents()
      unwatchHeads()
    }
    armStallTimer()
  }

  start()
  return {
    getState,
    close() {
      clearTimeout(stallTimer)
      stop?.()
    },
  }
}
