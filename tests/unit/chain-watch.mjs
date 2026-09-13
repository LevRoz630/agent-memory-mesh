// The control room's chain view: roster filtering, lease tracking and expiry from block heads. No network.
//
//   node tests/unit/chain-watch.mjs

import { createChainWatch } from '../../src/chain-watch.mjs'
import { ROSTER } from '../../src/roster.mjs'

let failed = false
function check(name, ok) {
  console.log(`  ${ok ? 'pass' : 'FAIL'}: ${name}`)
  if (!ok) failed = true
}

const STRANGER = '0x000000000000000000000000000000000000dEaD'
const entities = {
  '0xhb': { app: 'hydra', memory_type: 'heartbeat', tag: 'agent-atlas' },
  '0xclaim': { app: 'hydra', memory_type: 'claim', tag: 'incident-1' },
  '0xother': { app: 'someone-else', memory_type: 'claim', tag: 'x' },
}
const reads = []
let subscriptions = 0
let emitEvent, emitHead, failStream
const client = {
  async getEntity(key) {
    reads.push(key)
    return { attributes: Object.fromEntries(Object.entries(entities[key]).map(([k, v]) => [k, { type: 'str', value: v }])) }
  },
  watchEntityEvents({ onEvent, onError }) {
    subscriptions++
    emitEvent = onEvent
    failStream = onError
    return () => {}
  },
  watchBlockNumber({ onBlockNumber }) {
    emitHead = onBlockNumber
    return () => {}
  },
}

let state = null
const watch = createChainWatch({ client, onUpdate: (s) => (state = s) })
const settle = () => new Promise((r) => setTimeout(r, 0))
const atlas = ROSTER.atlas.address.toLowerCase()

await emitEvent({ type: 'EntityCreated', entityKey: '0xhb', owner: STRANGER, expiresAt: 108n, blockNumber: 100n })
check('a stranger\'s event is dropped without reading the entity', reads.length === 0 && state === null)

await emitEvent({ type: 'EntityCreated', entityKey: '0xother', owner: atlas, expiresAt: 108n, blockNumber: 100n })
check('a roster wallet\'s row from another app is dropped', state === null)

await emitEvent({ type: 'EntityCreated', entityKey: '0xhb', owner: atlas, expiresAt: 108n, blockNumber: 100n })
check('a roster heartbeat sets the agent\'s lease', state.heartbeats.atlas === '108')
check('its creation is in the feed', state.feed[0].kind === 'created' && state.feed[0].memoryType === 'heartbeat')

await emitEvent({ type: 'ExpiryExtended', entityKey: '0xhb', owner: atlas, expiresAt: 110n, blockNumber: 102n })
check('a renewal moves the lease without another read', state.heartbeats.atlas === '110' && reads.filter((k) => k === '0xhb').length === 1)
check('heartbeat renewals stay out of the feed', state.feed.length === 1)

await emitEvent({ type: 'EntityCreated', entityKey: '0xclaim', owner: atlas, expiresAt: 112n, blockNumber: 102n })
await emitEvent({ type: 'EntityDeleted', entityKey: '0xclaim', owner: atlas, blockNumber: 103n })
check('a deleted claim is in the feed', state.feed[0].kind === 'deleted' && state.feed[0].tag === 'incident-1')

emitHead(110n)
check('a row is still live at its expiry block', state.heartbeats.atlas === '110')
emitHead(111n)
check('a row past its expiry block drops out on its own', state.heartbeats.atlas === undefined)
check('the lapse is in the feed', state.feed[0].kind === 'expired' && state.feed[0].agentId === 'atlas')

failStream(new Error('socket closed'))
await new Promise((r) => setTimeout(r, 3200))
check('a stream error resubscribes', subscriptions === 2)

watch.close()
await settle()
console.log(`\nRESULT: ${failed ? 'FAILED' : 'passed'}`)
process.exit(failed ? 1 : 0)
