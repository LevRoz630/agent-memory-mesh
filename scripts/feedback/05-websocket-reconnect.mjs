// feedback.md finding 6, last bullet: forcibly closing the raw websocket mid-session fires
// onError, and the next write is still delivered exactly once — with no app-side reconnect
// code anywhere in this repo. Uses src/arkiv.mjs's watchMemories, the same watcher server.mjs
// runs.
//
//   node --env-file=.env scripts/feedback/05-websocket-reconnect.mjs

import { makeClients, createMemory, watchMemories } from '../../src/arkiv.mjs'

const SETTLE_MS = 4000
const DELIVERY_MS = 15000
const RECONNECT_MS = 8000

const { pub, wallet, wsClient, account } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY })
const agentId = `repro05-${Date.now().toString(36)}`

const delivered = []
const errors = []
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const write = (tag) =>
  createMemory(wallet, {
    agentId,
    memoryType: 'event',
    tag,
    importance: 5,
    swarmRef: 'feedbackrepro',
    ttlBlocks: 200,
  })

console.log('finding 6: websocket recovers from a forced socket close with no app-side reconnect code')
console.log(`wallet: ${account.address}\n`)

const unwatch = watchMemories(wsClient, pub, {
  onMemory: ({ entityKey }) => delivered.push(entityKey),
  onError: (e) => errors.push(String(e?.message ?? e).split('\n')[0]),
})
await wait(SETTLE_MS)

const first = await write('pre-drop')
console.log(`write 1 (socket healthy): ${first.entityKey}`)
await wait(DELIVERY_MS)
const firstDelivered = delivered.includes(first.entityKey)
console.log(`  delivered: ${firstDelivered}\n`)

const socket = await wsClient.transport.getSocket()
socket.close()
console.log('forced socket.close()')
await wait(RECONNECT_MS)
console.log(`  onError fired ${errors.length} time(s): ${JSON.stringify([...new Set(errors)])}\n`)

const second = await write('post-drop')
console.log(`write 2 (after forced drop): ${second.entityKey}`)
await wait(DELIVERY_MS)

const secondCount = delivered.filter((k) => k === second.entityKey).length
console.log(`  delivered: ${secondCount > 0}`)
console.log(`  delivery count: ${secondCount}`)
console.log(`\nwrite 1 still counted exactly once: ${delivered.filter((k) => k === first.entityKey).length === 1}`)
console.log(`total events delivered to onMemory: ${delivered.length}`)

unwatch()

const reproduced = firstDelivered && errors.length > 0 && secondCount === 1
console.log(`\nRESULT: ${reproduced ? 'reproduced' : 'NOT reproduced'}`)
process.exit(reproduced ? 0 : 1)
