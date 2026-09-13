// feedback.md finding 5: watchEntityEvents only subscribes over a websocket transport with no
// fromBlock. Over the http() transport its own docs example uses, or over a websocket with fromBlock,
// it polls eth_getLogs, and nothing tells the caller which one they got. No transactions.
//
//   node --env-file=.env arkiv-feedback/repro/05-watch-silently-polls.mjs

import { createPublicClient } from '@arkiv-network/sdk'
import { tiramisu } from '@arkiv-network/sdk/chains'
import { http, webSocket } from 'viem'

const WATCH_MS = 10000

// Records every JSON-RPC request and every subscription the watcher makes through the transport.
function recording(transport, calls) {
  return (opts) => {
    const t = transport(opts)
    const out = { ...t, request: (args, o) => (calls.push(args.method), t.request(args, o)) }
    if (t.value?.subscribe) {
      out.value = { ...t.value, subscribe: (args) => (calls.push(`eth_subscribe(${args.params[0]})`), t.value.subscribe(args)) }
    }
    return out
  }
}

async function watch(label, transport, options) {
  const calls = []
  const client = createPublicClient({ chain: tiramisu, transport: recording(transport, calls) })
  let events = 0
  const unwatch = client.watchEntityEvents({ ...options, onEvent: () => events++, onError: () => {} })
  await new Promise((r) => setTimeout(r, WATCH_MS))
  unwatch()
  const counts = calls.reduce((m, c) => ({ ...m, [c]: (m[c] ?? 0) + 1 }), {})
  const polled = calls.some((c) => c === 'eth_getLogs' || c === 'eth_getFilterChanges')
  const subscribed = calls.some((c) => c.startsWith('eth_subscribe'))
  console.log(`${label}`)
  console.log(`  ${events} events in ${WATCH_MS / 1000}s, calls: ${JSON.stringify(counts)}`)
  console.log(`  ${subscribed ? 'subscribed' : 'did not subscribe'}, ${polled ? 'polled' : 'did not poll'}\n`)
  return { polled, subscribed }
}

console.log('finding 5: watchEntityEvents picks polling or a subscription silently\n')

const httpArm = await watch('http() — the transport in watchEntityEvents\' JSDoc example', http(process.env.ARKIV_HTTP_URL), {})
const wsArm = await watch('webSocket()', webSocket(process.env.ARKIV_WS_URL), {})
const head = await createPublicClient({ chain: tiramisu, transport: http(process.env.ARKIV_HTTP_URL) }).getBlockNumber()
const wsFromBlock = await watch(`webSocket() with fromBlock ${head - 5n}`, webSocket(process.env.ARKIV_WS_URL), { fromBlock: head - 5n })

const reproduced = httpArm.polled && !httpArm.subscribed && wsArm.subscribed && !wsArm.polled && wsFromBlock.polled
console.log(`RESULT: ${reproduced ? 'reproduced' : 'NOT reproduced'}`)
process.exit(reproduced ? 0 : 1)
