// Claim: both Swarm calls are bounded by an 8s AbortSignal.timeout, so a gateway that accepts
// a connection and then never responds produces a catchable error instead of an open-ended
// hang. /api/query and /api/recent fan out concurrent downloads via Promise.all, so one
// stalled connection would otherwise hang the whole HTTP response.
//
// Deterministic: uses a local server that accepts and never replies, rather than waiting for
// the public gateway to stall. The bare-fetch counterfactual runs concurrently and is still
// pending well past the 8s ceiling — that contrast is the evidence.
//
//   node --env-file=.env scripts/feedback/09-fetch-timeout.mjs

import { createServer } from 'node:http'

const stallServer = createServer(() => {}) // accepts the request, never responds
await new Promise((r) => stallServer.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${stallServer.address().port}`

// swarm.mjs reads SWARM_GATEWAY at module load, so it must be set before the import.
process.env.SWARM_GATEWAY = origin
const { uploadMemory, downloadMemory } = await import('../../src/swarm.mjs')

console.log('CLAIM: uploadMemory/downloadMemory abort at ~8s against a stalling gateway.')
console.log(`stall server: ${origin}\n`)

let unhandled = null
process.on('unhandledRejection', (e) => { unhandled = e })

// Counterfactual: same server, no abort signal. Started now, inspected after the bounded
// calls have both already returned.
const bare = { settled: false }
const bareController = new AbortController()
const bareStart = Date.now()
fetch(`${origin}/bytes/${'0'.repeat(64)}`, { signal: bareController.signal })
  .then(() => { bare.settled = true })
  .catch((e) => { if (e.name !== 'AbortError') bare.settled = true })

async function timed(label, fn) {
  const t0 = Date.now()
  try {
    await fn()
    console.log(`${label}: resolved after ${Date.now() - t0}ms (unexpected)`)
    return null
  } catch (e) {
    const ms = Date.now() - t0
    console.log(`${label}: ${e.name} after ${ms}ms`)
    console.log(`  message: ${JSON.stringify(e.message)}`)
    return { ms, name: e.name }
  }
}

const up = await timed('uploadMemory  ', () => uploadMemory({ hello: 'stall' }))
const down = await timed('downloadMemory', () => downloadMemory('0'.repeat(64)))

// The end-to-end consequence: app.mjs's withContent() wraps this in try/catch per entity, so
// a stalled download degrades one row instead of hanging the response.
const { readMemoryContent } = await import('../../src/memory.mjs')
const t0 = Date.now()
let content
try {
  content = await readMemoryContent({ swarm_ref: '0'.repeat(64) })
} catch (e) {
  content = { error: `content unavailable: ${e.message}` }
}
console.log(`\nwithContent() equivalent returned after ${Date.now() - t0}ms`)
console.log(`  ${JSON.stringify(content)}`)

const bareElapsed = Date.now() - bareStart
console.log(`\ncounterfactual: bare fetch(), same server, no timeout signal`)
console.log(`  still pending after ${bareElapsed}ms: ${!bare.settled}`)

bareController.abort()
stallServer.close()

await new Promise((r) => setTimeout(r, 250))
console.log(`  unhandledRejection fired: ${unhandled ? `yes (${unhandled.message})` : 'no'}`)

const reproduced =
  up?.name === 'TimeoutError' &&
  down?.name === 'TimeoutError' &&
  up.ms < 12000 && down.ms < 12000 &&
  bare.settled === false &&
  unhandled === null

console.log(`\nRESULT: ${reproduced ? 'reproduced' : 'NOT reproduced'}`)
process.exit(reproduced ? 0 : 1)
