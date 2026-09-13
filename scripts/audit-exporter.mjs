// Continuous audit export: there is no bulk-list/export API anywhere in Swarm or Arkiv (checked
// against bee-js's chunk/SOC/feed/manifest surface and Arkiv's query API; both are strictly
// retrieve-by-known-reference), and Arkiv rows expire in ~20 minutes for event/lane/done/verdict,
// ~24 seconds for claim. So "exporting the logs" can't be a script you run later against
// something that's still there. It has to watch continuously and copy each row out before it
// ages off both systems. See docs/ARCHITECTURE.md §6.
//
// Deliberately minimal privilege: this process takes only AUDITOR_PRIVATE_KEY and a Swarm gateway
// URL. It never touches ARKIV_PRIVATE_KEY_ATLAS/NOVA/SOL, SWARM_SIGNER_KEY, or
// SWARM_POSTAGE_BATCH_ID, so it can read and decrypt but can't write to Arkiv or spend the
// postage batch. Run it as a genuinely separate process from the agents, ideally on a separate
// machine, or the "separate observer" is cosmetic rather than real (see docs/pitch/PITCH.md's honesty note
// and this repo's own precedent for that distinction elsewhere in the encryption design).
//
//   node --env-file=.env.auditor scripts/audit-exporter.mjs [output-file]
//   (or: AUDITOR_PRIVATE_KEY=<hex> node scripts/audit-exporter.mjs [output-file])
//
// Appends one JSON line per event to output-file (default: audit-log.jsonl). Safe to stop and
// restart. Arkiv's own EntityCreated/ExpiryExtended/EntityDeleted events are the source of
// truth; this script has no state of its own beyond the append-only log.

import { appendFileSync } from 'node:fs'
import { createPublicClient } from '@arkiv-network/sdk'
import { tiramisu } from '@arkiv-network/sdk/chains'
import { http, webSocket } from 'viem'
import { Bee } from '@ethersphere/bee-js'
import { watchMemories } from '../src/arkiv.mjs'
import { openForAuditor } from '../src/swarm.mjs'

const auditorKeyHex = process.env.AUDITOR_PRIVATE_KEY
if (!auditorKeyHex) {
  console.error('set AUDITOR_PRIVATE_KEY — this process needs only that, nothing else')
  process.exit(1)
}
const auditorPrivateKey = Buffer.from(auditorKeyHex.replace(/^0x/, ''), 'hex')

const gateway = process.env.SWARM_GATEWAY ?? 'https://api.gateway.ethswarm.org'
const bee = new Bee(gateway) // read-only: no Stamper, no signer — downloads need neither
const outputFile = process.argv[2] ?? 'audit-log.jsonl'

const pub = createPublicClient({ chain: tiramisu, transport: http(process.env.ARKIV_HTTP_URL, { cacheTime: 0 }) })
const wsClient = createPublicClient({ chain: tiramisu, transport: webSocket(process.env.ARKIV_WS_URL) })

function append(record) {
  appendFileSync(outputFile, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n')
}

async function exportMemory({ entityKey, owner, expiresAt, attributes }) {
  let content = null
  let decryptError = null
  try {
    const chunk = await bee.chunk.download(attributes.swarm_ref, undefined, { timeout: 8000 })
    const plaintext = openForAuditor(Buffer.from(chunk).subarray(8), auditorPrivateKey)
    content = JSON.parse(plaintext.toString('utf8'))
  } catch (e) {
    // Not on the auditor's roster (a memory sealed before AUDITOR_PUBLIC_KEY was configured, or
    // written by code that doesn't seal to the auditor), or the Swarm chunk already expired.
    // Recorded instead of dropped: a gap in the audit trail should be visible, not silent.
    decryptError = e.message
  }
  append({
    event: 'created', entityKey, owner, expiresAt: String(expiresAt),
    attributes, content, decryptError,
  })
  console.log(`[export] ${attributes.memory_type}/${attributes.tag} (${entityKey.slice(0, 18)}…) ${decryptError ? `— undecryptable: ${decryptError}` : '— exported'}`)
}

// viem's websocket transport reconnects the socket but not the subscription behind it (server.mjs
// re-arms for the same reason), and a watch that stays dropped is a silent gap in the audit trail.
let unwatch = null
function startWatch() {
  unwatch = watchMemories(wsClient, pub, {
    onMemory: (m) => { exportMemory(m).catch((e) => console.error('[export] failed:', e.message)) },
    // A row deleted before it could be read back (a claim that lost the tie-break) never reaches
    // onMemory. It is recorded here instead of vanishing.
    onEvent: ({ phase, entityKey, owner }) => {
      if (phase === 'error') append({ event: 'created-unreadable', entityKey, owner })
    },
    onExtended: ({ entityKey, owner, expiresAt }) => {
      append({ event: 'extended', entityKey, owner, expiresAt: String(expiresAt) })
    },
    onDeleted: ({ entityKey }) => {
      append({ event: 'deleted', entityKey })
    },
    onError: (err) => {
      console.error('[export] watch error:', err.message)
      append({ event: 'watch-error', message: err.message })
      try { unwatch?.() } catch {}
      setTimeout(startWatch, 3000)
    },
  })
}
startWatch()

console.log(`[export] watching, appending to ${outputFile} (auditor decrypt key configured, no write credentials held)`)
