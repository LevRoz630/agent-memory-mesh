# Claim-Takeover Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the three-agent claim-takeover protocol (ARCHITECTURE.md §7) with per-agent envelope
encryption replacing the current shared-key encryption, and a deterministic tie-break so concurrent
claims converge.

**Architecture:** One orchestrator process drives all three agents (atlas, nova, sol) as concurrent
async loops, each signing with its own existing wallet key. `src/swarm.mjs` gains roster-scoped
binary envelope encryption; a new `src/lane.mjs` wraps bee-js's indexed Feed API for per-agent
"lanes"; a new `src/protocol.mjs` implements the claim/renew/takeover/finish/verify state machine
on top of `src/arkiv.mjs`'s existing entity primitives plus two additions (`outcome` attribute,
`queryByTagAndType`).

**Tech Stack:** Node.js (ESM, `.mjs`), `@ethersphere/bee-js` (Feed/chunk/Stamper APIs),
`@ethersphere/core-sdk` (SOC address primitives — `Topic`, `FeedIndex`, `Identifier`, `EthAddress`,
`keccak256`, `makeSOCAddress`), `@arkiv-network/sdk` (entity CRUD + `watchEntityEvents`), Node's
built-in `node:crypto` (AES-256-GCM, ECDH secp256k1, HKDF). No test framework — this repo verifies
behavior with narrative, exit-code scripts (`scripts/feedback/*.mjs` is the existing pattern: log
what's being checked, print outcomes, `process.exit(0 or 1)` on a final boolean).

**Spec:** `docs/superpowers/specs/2026-09-12-claim-takeover-protocol-design.md`

## Global Constraints

- Stamped chunks (content and lane/feed updates alike) are capped at 4096 bytes — enforce this
  explicitly wherever a payload is built, don't rely on the SDK's own `RangeError`.
- Every Swarm write must use the **locally signed envelope** from the shared `Stamper`
  (`SWARM_SIGNER_KEY` / `SWARM_POSTAGE_BATCH_ID`), never a bare postage batch ID — passing a batch
  ID to `uploadPayload` silently takes the gateway-paid path instead.
- Every feed (lane) read or write must pass an **explicit** `{ index }` — never let the SDK infer
  it over the network.
- Attribute names on Arkiv entities stay snake_case; `memory_type` is restricted to
  `event`/`claim`/`lane`/`done`/`verdict`.
- One Node process runs all three agents' loops — do not spawn separate OS processes per agent
  (this is what keeps the Swarm `Stamper`'s in-memory bucket state consistent; see spec §5).
- Run scripts with `node --env-file=.env <script>`, matching every existing script in this repo.

---

## Task 1: Pure envelope-encryption crypto core

**Files:**
- Modify: `src/swarm.mjs` (add new exports, do not yet wire them into `uploadMemory`/`downloadMemory`)
- Test: `scripts/test-envelope-crypto.mjs` (new)

**Interfaces:**
- Produces: `derivePublicKey(privateKeyBuffer: Buffer) -> Buffer` (33-byte compressed secp256k1
  public key), `encryptForRoster(plaintext: Buffer, recipients: Array<{ agentIndex: number,
  publicKey: Buffer }>) -> Buffer` (binary framed blob, see spec §2), `decryptWithKey(blob: Buffer,
  agentIndex: number, privateKeyBuffer: Buffer) -> Buffer` (throws if `agentIndex` has no entry in
  the blob, or if auth fails for any reason).

This task adds pure, env-independent functions only — no network, no `process.env` reads — so it's
testable without a gateway or real keys.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-envelope-crypto.mjs`:

```js
// Pure crypto round-trip for the binary envelope format (spec §2). No network, no env vars.
//
//   node scripts/test-envelope-crypto.mjs

import { randomBytes, createECDH } from 'node:crypto'
import { derivePublicKey, encryptForRoster, decryptWithKey } from '../src/swarm.mjs'

function freshPrivateKey() {
  const ecdh = createECDH('secp256k1')
  ecdh.generateKeys()
  return ecdh.getPrivateKey()
}

console.log('binary envelope encryption round trip\n')

const keys = { atlas: freshPrivateKey(), nova: freshPrivateKey(), sol: freshPrivateKey() }
const AGENT_INDEX = { atlas: 0, nova: 1, sol: 2 }
const plaintext = Buffer.from(JSON.stringify({ note: 'incident-42 diagnosis' }), 'utf8')

const recipients = ['atlas', 'nova'].map((agentId) => ({
  agentIndex: AGENT_INDEX[agentId],
  publicKey: derivePublicKey(keys[agentId]),
}))
const blob = encryptForRoster(plaintext, recipients)
console.log(`  blob size for 2 recipients, ${plaintext.length}-byte plaintext: ${blob.length} bytes`)

let atlasOk = false
try {
  const decrypted = decryptWithKey(blob, AGENT_INDEX.atlas, keys.atlas)
  atlasOk = decrypted.equals(plaintext)
  console.log(`  atlas (on roster) decrypts correctly: ${atlasOk}`)
} catch (e) {
  console.log(`  atlas (on roster) FAILED to decrypt: ${e.message}`)
}

let novaOk = false
try {
  const decrypted = decryptWithKey(blob, AGENT_INDEX.nova, keys.nova)
  novaOk = decrypted.equals(plaintext)
  console.log(`  nova (on roster) decrypts correctly: ${novaOk}`)
} catch (e) {
  console.log(`  nova (on roster) FAILED to decrypt: ${e.message}`)
}

let solRejected = false
try {
  decryptWithKey(blob, AGENT_INDEX.sol, keys.sol)
  console.log('  sol (NOT on roster) decrypted — THIS IS WRONG')
} catch (e) {
  solRejected = true
  console.log(`  sol (not on roster) correctly rejected: ${e.message}`)
}

let wrongKeyRejected = false
try {
  decryptWithKey(blob, AGENT_INDEX.atlas, keys.nova)
  console.log('  atlas slot decrypted with nova\'s key — THIS IS WRONG')
} catch (e) {
  wrongKeyRejected = true
  console.log(`  atlas slot with nova's key correctly rejected: ${e.message}`)
}

const reproduced = atlasOk && novaOk && solRejected && wrongKeyRejected && blob.length < 300
console.log(`\nRESULT: ${reproduced ? 'passed' : 'FAILED'}`)
process.exit(reproduced ? 0 : 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-envelope-crypto.mjs`
Expected: FAIL — `derivePublicKey is not a function` (or similar), since `src/swarm.mjs` doesn't
export these yet.

- [ ] **Step 3: Implement the crypto core in `src/swarm.mjs`**

Add these imports at the top (alongside the existing `node:crypto` import — extend it):

```js
import { createCipheriv, createDecipheriv, randomBytes, createECDH, hkdfSync } from 'node:crypto'
```

Add these functions (place after the existing `MAX_BLOB_BYTES` constant, before the old
`getKey`/`encrypt`/`decrypt` — those three get deleted in Task 2, once nothing references them):

```js
// One shared ephemeral keypair per memory, wrapped per recipient — cheaper than a fresh
// ephemeral key per recipient, and standard multi-recipient ECIES practice.
const WRAP_KEY_LEN = 32
const EPHEMERAL_PUBKEY_LEN = 33 // compressed secp256k1 point
const WRAP_IV_LEN = 12
const WRAP_TAG_LEN = 16
const WRAP_ENTRY_LEN = 1 + WRAP_IV_LEN + WRAP_TAG_LEN + WRAP_KEY_LEN // agentIndex + iv + tag + key

export function derivePublicKey(privateKeyBuffer) {
  const ecdh = createECDH('secp256k1')
  ecdh.setPrivateKey(privateKeyBuffer)
  return ecdh.getPublicKey(null, 'compressed')
}

// Raw ECDH output is not a key — HKDF is what makes this ECIES rather than "computeSecret and
// hope". `info` binds the derived key to which agent slot it's wrapping, so two recipients never
// derive the same wrap key even if (hypothetically) they shared a public key.
function deriveWrapKey(sharedSecret, agentIndex) {
  return Buffer.from(hkdfSync('sha256', sharedSecret, Buffer.alloc(0), Buffer.from([agentIndex]), WRAP_KEY_LEN))
}

export function encryptForRoster(plaintext, recipients) {
  const contentKey = randomBytes(32)
  const contentIv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', contentKey, contentIv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const contentTag = cipher.getAuthTag()

  const ephemeral = createECDH('secp256k1')
  ephemeral.generateKeys()
  const ephemeralPub = ephemeral.getPublicKey(null, 'compressed')

  const wrappedEntries = recipients.map(({ agentIndex, publicKey }) => {
    const shared = ephemeral.computeSecret(publicKey)
    const wrapKey = deriveWrapKey(shared, agentIndex)
    const wrapIv = randomBytes(WRAP_IV_LEN)
    const wrapCipher = createCipheriv('aes-256-gcm', wrapKey, wrapIv)
    const wrappedKey = Buffer.concat([wrapCipher.update(contentKey), wrapCipher.final()])
    const wrapTag = wrapCipher.getAuthTag()
    return Buffer.concat([Buffer.from([agentIndex]), wrapIv, wrapTag, wrappedKey])
  })

  return Buffer.concat([
    Buffer.from([recipients.length]),
    ephemeralPub,
    ...wrappedEntries,
    contentIv,
    contentTag,
    ciphertext,
  ])
}

export function decryptWithKey(blob, agentIndex, privateKeyBuffer) {
  let offset = 0
  const nRecipients = blob[offset]; offset += 1
  const ephemeralPub = blob.subarray(offset, offset + EPHEMERAL_PUBKEY_LEN); offset += EPHEMERAL_PUBKEY_LEN

  let match = null
  for (let i = 0; i < nRecipients; i++) {
    const entry = blob.subarray(offset, offset + WRAP_ENTRY_LEN)
    offset += WRAP_ENTRY_LEN
    if (entry[0] === agentIndex) match = entry
  }
  if (!match) throw new Error(`agent index ${agentIndex} is not on this memory's roster`)

  const wrapIv = match.subarray(1, 1 + WRAP_IV_LEN)
  const wrapTag = match.subarray(1 + WRAP_IV_LEN, 1 + WRAP_IV_LEN + WRAP_TAG_LEN)
  const wrappedKey = match.subarray(1 + WRAP_IV_LEN + WRAP_TAG_LEN)

  const contentIv = blob.subarray(offset, offset + 12); offset += 12
  const contentTag = blob.subarray(offset, offset + 16); offset += 16
  const ciphertext = blob.subarray(offset)

  const ecdh = createECDH('secp256k1')
  ecdh.setPrivateKey(privateKeyBuffer)
  const shared = ecdh.computeSecret(ephemeralPub)
  const wrapKey = deriveWrapKey(shared, agentIndex)

  const wrapDecipher = createDecipheriv('aes-256-gcm', wrapKey, wrapIv)
  wrapDecipher.setAuthTag(wrapTag)
  const contentKey = Buffer.concat([wrapDecipher.update(wrappedKey), wrapDecipher.final()])

  const decipher = createDecipheriv('aes-256-gcm', contentKey, contentIv)
  decipher.setAuthTag(contentTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-envelope-crypto.mjs`
Expected: PASS — all four checks true, blob under 300 bytes for 2 recipients.

- [ ] **Step 5: Commit**

```bash
git add src/swarm.mjs scripts/test-envelope-crypto.mjs
git commit -m "feat: add binary roster-scoped envelope encryption (ECIES over secp256k1)"
```

---

## Task 2: Wire roster encryption into upload/download, remove the global key

**Files:**
- Modify: `src/swarm.mjs`
- Modify: `src/memory.mjs`
- Test: `scripts/verify-envelope-live.mjs` (new)

**Interfaces:**
- Consumes: `derivePublicKey`, `encryptForRoster`, `decryptWithKey` from Task 1.
- Consumes: `AGENT_IDS` from `src/arkiv.mjs` (already exported: `['atlas', 'nova', 'sol']`).
- Produces: `getSwarm() -> { bee, stamper }` (was module-private, now exported for `src/lane.mjs`
  in Task 4). `uploadMemory(content: object, roster?: string[] = AGENT_IDS) -> Promise<string>`
  (hex chunk address — same return shape as before). `downloadMemory(ref: string) ->
  Promise<object>` (same signature as before — no identity parameter; tries every agent key this
  process has configured, per spec §2's B4 resolution).
- Produces (for `src/memory.mjs`): `writeMemory(wallet, { agentId, memoryType, tag, importance,
  content, ttlBlocks, roster? }) -> Promise<{...}>` — `roster` is optional, defaults to all three
  agents inside `uploadMemory`.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-envelope-live.mjs`:

```js
// Live round trip: upload a memory sealed to a 2-agent roster, confirm the third agent's
// configured key cannot decrypt it, confirm a roster member can. Requires SWARM_SIGNER_KEY,
// SWARM_POSTAGE_BATCH_ID, and ARKIV_PRIVATE_KEY_ATLAS/NOVA/SOL in the environment.
//
//   node --env-file=.env scripts/verify-envelope-live.mjs

import { uploadMemory, downloadMemory } from '../src/swarm.mjs'

console.log('live envelope round trip against the Swarm gateway\n')

const content = { note: 'envelope-live-check', ts: Date.now() }
const ref = await uploadMemory(content, ['atlas', 'nova'])
console.log(`  uploaded, sealed to [atlas, nova]: ${ref}`)

const readBack = await downloadMemory(ref)
const matches = readBack.note === content.note && readBack.ts === content.ts
console.log(`  read back matches: ${matches}`)

console.log(`\nRESULT: ${matches ? 'passed' : 'FAILED'}`)
process.exit(matches ? 0 : 1)
```

(`sol` is deliberately excluded from the roster but the process still holds `sol`'s key —
`downloadMemory` succeeding here demonstrates only that *some* configured key worked, which for a
2-of-3 roster is expected to be `atlas` or `nova`. The exclusion property itself is already proven
by Task 1's pure test; this script's job is proving the live upload/download path uses the new
format at all.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env scripts/verify-envelope-live.mjs`
Expected: FAIL — `uploadMemory` still uses the old single-argument, single-key `encrypt`, so either
it throws (arity mismatch is silently ignored in JS, so more likely) it succeeds but via the *old*
code path, meaning this test doesn't actually exercise the new format yet. Confirm by temporarily
adding `console.log(blob.length)` — expect the old fixed-overhead-free format, not the new
roster-framed one. The real signal here is Step 4's post-implementation run; this step exists to
confirm the old implementation is still in place before you change it.

- [ ] **Step 3: Replace the old encryption plumbing**

In `src/swarm.mjs`:
1. Delete `getKey`, `encrypt`, `decrypt` (the old `MEMORY_ENC_KEY`-based functions) entirely.
2. Add:

```js
function agentPrivateKeyBuffer(agentId) {
  const hex = process.env[`ARKIV_PRIVATE_KEY_${agentId.toUpperCase()}`]
  if (!hex) return null
  return Buffer.from(hex.replace(/^0x/, ''), 'hex')
}

function decryptForAnyAgent(blob) {
  for (const agentId of AGENT_IDS) {
    const priv = agentPrivateKeyBuffer(agentId)
    if (!priv) continue
    try {
      return decryptWithKey(blob, AGENT_IDS.indexOf(agentId), priv)
    } catch {
      continue // wrong slot for this agent, or auth failure — try the next configured key
    }
  }
  throw new Error('no configured agent key could decrypt this memory')
}
```

3. Add the import: `import { AGENT_IDS } from './arkiv.mjs'` (top of file — no circularity:
   `arkiv.mjs` does not import `swarm.mjs`).
4. Change `getSwarm` from a bare function declaration to `export function getSwarm() { ... }`
   (same body, just exported).
5. Replace `uploadMemory` and `downloadMemory`:

```js
export async function uploadMemory(content, roster = AGENT_IDS) {
  const { bee, stamper } = getSwarm()
  const recipients = roster.map((agentId) => {
    const priv = agentPrivateKeyBuffer(agentId)
    if (!priv) throw new Error(`no key configured for roster agent "${agentId}" — set ARKIV_PRIVATE_KEY_${agentId.toUpperCase()}`)
    return { agentIndex: AGENT_IDS.indexOf(agentId), publicKey: derivePublicKey(priv) }
  })
  const blob = encryptForRoster(Buffer.from(JSON.stringify(content), 'utf8'), recipients)
  if (blob.length > MAX_BLOB_BYTES) {
    throw new Error(`encrypted content is ${blob.length} bytes; one stamped chunk holds ${MAX_BLOB_BYTES}`)
  }
  const chunk = bee.makeContentAddressedChunk(blob)
  const envelope = stamper.stamp(chunk.address.toUint8Array())
  await bee.chunk.upload(envelope, chunk, undefined, { timeout: FETCH_TIMEOUT_MS })
  return chunk.address.toHex()
}

export async function downloadMemory(ref) {
  const { bee } = getSwarm()
  const chunk = await bee.chunk.download(ref, undefined, { timeout: FETCH_TIMEOUT_MS })
  const plaintext = decryptForAnyAgent(Buffer.from(chunk).subarray(8))
  return JSON.parse(plaintext.toString('utf8'))
}
```

6. Delete the `MEMORY_ENC_KEY` env var requirement comment at the top of the file (the block
   comment starting "Rotating MEMORY_ENC_KEY...") since it no longer exists — replace with a note
   that keys come from each agent's own `ARKIV_PRIVATE_KEY_<AGENT>`, reusing their Arkiv signing
   identity as their Swarm decryption identity too.

In `src/memory.mjs`, update `writeMemory` to accept and forward an optional roster:

```js
export async function writeMemory(wallet, { agentId, memoryType, tag, importance, content, ttlBlocks, roster }) {
  const swarmRef = await uploadMemory(content, roster)
  const { entityKey, txHash, appliedTtlBlocks, appliedExpiresAt } = await createMemory(wallet, {
    agentId, memoryType, tag, importance, swarmRef, ttlBlocks,
  })
  return { entityKey, txHash, swarmRef, appliedTtlBlocks, appliedExpiresAt }
}
```

(`readMemoryContent` needs no change — it already just forwards to `downloadMemory(ref)`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env scripts/verify-envelope-live.mjs`
Expected: PASS.

Also re-run Task 1's test to confirm nothing regressed: `node scripts/test-envelope-crypto.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/swarm.mjs src/memory.mjs scripts/verify-envelope-live.mjs
git commit -m "feat: replace shared MEMORY_ENC_KEY with per-agent roster encryption"
```

---

## Task 3: Arkiv schema and query additions

**Files:**
- Modify: `src/arkiv.mjs`

**Interfaces:**
- Consumes: existing `ATTR`, `str`, `u64`, `and`, `eq`, `runQuery` (all already in this file).
- Produces: `createMemory(wallet, { agentId, memoryType, tag, importance, swarmRef, ttlBlocks,
  outcome? }) -> Promise<{ entityKey, txHash, appliedTtlBlocks, appliedExpiresAt }>` — same shape
  as before, `outcome` is new and optional. Throws `Invalid memory_type "<value>" — must be one of:
  event, claim, lane, done, verdict` for anything outside the whitelist.
- Produces: `queryByTagAndType(pub, { tag, memoryType, limit? = 20 }) ->
  Promise<Array<entity>>` (same entity shape as `queryByTag`/`queryMemories`).
- Produces: `watchMemories(wsClient, pub, { onMemory, onEvent, onError, onExpired, onExtended })` —
  two new optional callbacks alongside the three existing ones.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-schema-additions.mjs`:

```js
// Live check: outcome round-trips on a verdict row, memory_type whitelist rejects garbage,
// queryByTagAndType filters on both tag and type together.
//
//   node --env-file=.env scripts/verify-schema-additions.mjs

import { ExpirationTime } from '@arkiv-network/sdk'
import { makeClients, createMemory, queryByTagAndType } from '../src/arkiv.mjs'

const { pub, wallet, wsClient } = makeClients({
  privateKey: process.env.ARKIV_PRIVATE_KEY,
  httpUrl: process.env.ARKIV_HTTP_URL,
  wsUrl: process.env.ARKIV_WS_URL,
})
wsClient.transport?.destroy?.() // this script never watches; avoid an idle open socket

const tag = `verify-schema-${Date.now()}`

console.log('schema additions\n')

const { entityKey } = await createMemory(wallet, {
  agentId: 'atlas', memoryType: 'verdict', tag, importance: 5,
  swarmRef: '0'.repeat(64), ttlBlocks: 20, outcome: 'fixed',
})
console.log(`  wrote verdict row with outcome, entityKey ${entityKey.slice(0, 18)}…`)

const rows = await queryByTagAndType(pub, { tag, memoryType: 'verdict' })
const outcomeRoundTrips = rows.length === 1 && rows[0].attributes.outcome === 'fixed'
console.log(`  queryByTagAndType found it with outcome intact: ${outcomeRoundTrips}`)

const noMatch = await queryByTagAndType(pub, { tag, memoryType: 'claim' })
const typeFilters = noMatch.length === 0
console.log(`  queryByTagAndType('claim') on a verdict-only tag returns nothing: ${typeFilters}`)

let whitelistRejects = false
try {
  await createMemory(wallet, {
    agentId: 'atlas', memoryType: 'bogus', tag, importance: 1, swarmRef: '0'.repeat(64), ttlBlocks: 20,
  })
} catch (e) {
  whitelistRejects = /memory_type/.test(e.message)
  console.log(`  memory_type "bogus" rejected client-side: ${whitelistRejects} (${e.message})`)
}

const reproduced = outcomeRoundTrips && typeFilters && whitelistRejects
console.log(`\nRESULT: ${reproduced ? 'passed' : 'FAILED'}`)
process.exit(reproduced ? 0 : 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env scripts/verify-schema-additions.mjs`
Expected: FAIL — `queryByTagAndType is not a function`, and `createMemory` silently accepts
`outcome` today only if you also change its call signature (it currently ignores unknown
destructured fields), so the whitelist check will also fail to throw.

- [ ] **Step 3: Implement in `src/arkiv.mjs`**

Add to `ATTR`:

```js
const ATTR = {
  app: 'app',
  agentId: 'agent_id',
  memoryType: 'memory_type',
  tag: 'tag',
  importance: 'importance',
  swarmRef: 'swarm_ref',
  outcome: 'outcome',
}
```

Add the whitelist constant (near `AGENT_IDS`):

```js
export const MEMORY_TYPES = ['event', 'claim', 'lane', 'done', 'verdict']
```

Update `createMemory`:

```js
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
  const { entityKey, txHash, expiresAt } = await wallet.createEntity({
    expires: ExpirationTime.fromBlocks(ttlBlocks),
    payload: stringToPayload(''),
    contentType: 'application/octet-stream',
    attributes,
  })
  return { entityKey, txHash, appliedTtlBlocks: ttlBlocks, appliedExpiresAt: expiresAt }
}
```

Add the new query, next to `queryByTag`:

```js
export async function queryByTagAndType(pub, { tag, memoryType, limit = 20 }) {
  return runQuery(pub, and(eq(ATTR.app, str(APP)), eq(ATTR.tag, str(tag)), eq(ATTR.memoryType, str(memoryType))), limit)
}
```

Extend `watchMemories` to wire the two additional event types the SDK already emits
(`onExpiryExtended`, `onEntityDeleted` — confirmed present on `watchEntityEvents`):

```js
export function watchMemories(wsClient, pub, { onMemory, onEvent, onError, onExpired, onExtended }) {
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
    onExpiryExtended: ({ entityKey, owner, expiresAt }) => {
      onEvent?.({ phase: 'extended', entityKey, owner })
      onExtended?.({ entityKey, owner, expiresAt })
    },
    onEntityDeleted: ({ entityKey }) => {
      onEvent?.({ phase: 'deleted', entityKey })
      onExpired?.({ entityKey })
    },
    onError,
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env scripts/verify-schema-additions.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/arkiv.mjs scripts/verify-schema-additions.mjs
git commit -m "feat: add outcome attribute, memory_type whitelist, queryByTagAndType"
```

---

## Task 4: Lane writes and reads (`src/lane.mjs`)

**Files:**
- Create: `src/lane.mjs`
- Test: `scripts/verify-lane.mjs` (new)

**Interfaces:**
- Consumes: `getSwarm` from `src/swarm.mjs` (Task 2).
- Produces: `writeToLane(agentPrivateKeyHex: string, ownerAddressHex: string, tag: string, index:
  number, content: { kind: 'diagnosis'|'fix'|'verification', [key: string]: any }) ->
  Promise<string>` (hex SOC address written to). `readLane(ownerAddressHex: string, tag: string,
  index: number) -> Promise<object | null>` (`null` on a clean 404 — an unwritten index).

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-lane.mjs`:

```js
// Live round trip for lane (feed) writes: stamp our own address with the shared batch, write at
// an explicit index, read it back with no key at all, and confirm an unwritten index reads as a
// clean null rather than an error. This is the mechanism ARCHITECTURE.md §7 depends on but had no
// reproducer for.
//
//   node --env-file=.env scripts/verify-lane.mjs

import { privateKeyToAccount } from 'viem/accounts'
import { writeToLane, readLane } from '../src/lane.mjs'

const agentKey = process.env.ARKIV_PRIVATE_KEY_NOVA
const account = privateKeyToAccount(agentKey)
const tag = `verify-lane-${Date.now()}`

console.log('lane round trip\n')
console.log(`  owner: ${account.address}, tag: ${tag}`)

const unwritten = await readLane(account.address, tag, 0)
console.log(`  index 0 before any write: ${unwritten === null ? 'null (clean)' : JSON.stringify(unwritten)}`)

const address = await writeToLane(agentKey, account.address, tag, 0, { kind: 'diagnosis', note: 'root cause: stale cache' })
console.log(`  wrote index 0 at SOC address ${address}`)

const readBack = await readLane(account.address, tag, 0)
const matches = readBack?.kind === 'diagnosis' && readBack?.note === 'root cause: stale cache'
console.log(`  read back matches: ${matches}`)

const stillUnwritten = await readLane(account.address, tag, 1)
console.log(`  index 1 (never written) still reads null: ${stillUnwritten === null}`)

const reproduced = unwritten === null && matches && stillUnwritten === null
console.log(`\nRESULT: ${reproduced ? 'passed' : 'FAILED'}`)
process.exit(reproduced ? 0 : 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env scripts/verify-lane.mjs`
Expected: FAIL — `Cannot find module '../src/lane.mjs'`.

- [ ] **Step 3: Implement `src/lane.mjs`**

```js
// Per-agent "lanes" on Swarm: an indexed feed at address hash(owner, topic, index), where
// topic = hash('agent-memory-mesh/' + tag). Anyone holding a wallet address and the tag can
// compute the address and read it — no key needed for reading, only for writing at that owner's
// slot. See ARCHITECTURE.md §7 "The Swarm side: one lane per agent".
//
// bee-js's package.json `exports` only allows importing its top-level entry point, and the plain
// (non-rolling) Feed API there (`bee.feed.makeWriter/.makeReader`) computes the feed's SOC address
// internally and only accepts a bare postage batch ID — which spends the gateway's postage, not
// ours (see src/swarm.mjs's Stamper comment). So the SOC address is computed here, independently,
// with @ethersphere/core-sdk's own primitives (a direct dependency, not a restricted subpath),
// and stamped with the same Stamper src/swarm.mjs already holds before handing bee.feed the
// resulting envelope in place of a batch ID.

import { Topic, FeedIndex, Identifier, EthAddress, Bytes, keccak256, makeSOCAddress } from '@ethersphere/core-sdk'
import { getSwarm } from './swarm.mjs'

const MAX_LANE_PAYLOAD_BYTES = 4096

function socAddressFor(ownerHex, topic, index) {
  const idx = FeedIndex.fromBigInt(BigInt(index))
  const identifierBytes = keccak256(Bytes.concat(topic.toUint8Array(), idx.toUint8Array()))
  const identifier = new Identifier(identifierBytes)
  const owner = new EthAddress(ownerHex)
  return makeSOCAddress(identifier, owner)
}

export async function writeToLane(agentPrivateKeyHex, ownerAddressHex, tag, index, content) {
  const { bee, stamper } = getSwarm()
  const topic = Topic.fromString('agent-memory-mesh/' + tag)
  const address = socAddressFor(ownerAddressHex, topic, index)
  const payload = Buffer.from(JSON.stringify(content), 'utf8')
  if (payload.length > MAX_LANE_PAYLOAD_BYTES) {
    throw new Error(`lane payload is ${payload.length} bytes; one stamped chunk holds ${MAX_LANE_PAYLOAD_BYTES}`)
  }
  const envelope = stamper.stamp(address.toUint8Array())
  const writer = bee.feed.makeWriter(topic, agentPrivateKeyHex)
  await writer.uploadPayload(envelope, payload, { index })
  return address.toHex()
}

export async function readLane(ownerAddressHex, tag, index) {
  const { bee } = getSwarm()
  const topic = Topic.fromString('agent-memory-mesh/' + tag)
  const reader = bee.feed.makeReader(topic, ownerAddressHex)
  try {
    const { payload } = await reader.downloadPayload({ index })
    return JSON.parse(Buffer.from(payload.toUint8Array()).toString('utf8'))
  } catch (e) {
    if (e?.status === 404) return null
    throw e
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env scripts/verify-lane.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lane.mjs scripts/verify-lane.mjs
git commit -m "feat: add per-agent lane writes/reads over Swarm's indexed Feed API"
```

---

## Task 5: Protocol state machine (`src/protocol.mjs`)

**Files:**
- Create: `src/protocol.mjs`
- Test: `scripts/verify-tie-break.mjs` (new)

**Interfaces:**
- Consumes: `queryByTagAndType`, `extendMemory`, `deleteMemory`, `AGENT_IDS` from `src/arkiv.mjs`;
  `writeMemory` from `src/memory.mjs`; `writeToLane`, `readLane` from `src/lane.mjs`.
- Produces: `tryClaim(ctx, agentId, tag) -> Promise<{ held: boolean, entityKey?: string }>` where
  `ctx = { pub, signers }` (`signers` is the `Map` from `makeAgentSigners`, `pub` is a public
  client from `makeClients`). `renewClaim(ctx, agentId, entityKey, leaseBlocks) -> Promise<void>`
  (loops internally until told to stop — see Step 3 for the stop mechanism). `takeOver(ctx, tag) ->
  Promise<Array<{ ownerAddress: string, latestIndex: number, latestContent: object }>>`.
  `finish(ctx, agentId, tag, entityKey, fixContent) -> Promise<void>`. `verify(ctx, tag) ->
  Promise<{ outcome: 'fixed' | 'reopened' }>`.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-tie-break.mjs`:

```js
// Two agents race to claim the same fresh tag at (as close to) the same instant. Exactly one
// should end up holding the claim after the tie-break settles; the loser's claim entity should be
// gone.
//
//   node --env-file=.env scripts/verify-tie-break.mjs

import { makeClients, makeAgentSigners, queryByTagAndType } from '../src/arkiv.mjs'
import { tryClaim } from '../src/protocol.mjs'

const httpUrl = process.env.ARKIV_HTTP_URL
const wsUrl = process.env.ARKIV_WS_URL
const { pub } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY, httpUrl, wsUrl })
const signers = makeAgentSigners({ httpUrl })
const ctx = { pub, signers }

const tag = `verify-tie-break-${Date.now()}`
console.log('deterministic tie-break\n')
console.log(`  tag: ${tag}`)

const [novaResult, solResult] = await Promise.all([
  tryClaim(ctx, 'nova', tag),
  tryClaim(ctx, 'sol', tag),
])
console.log(`  nova: ${JSON.stringify(novaResult)}`)
console.log(`  sol:  ${JSON.stringify(solResult)}`)

const exactlyOneHeld = novaResult.held !== solResult.held
console.log(`  exactly one holder: ${exactlyOneHeld}`)

const finalRows = await queryByTagAndType(pub, { tag, memoryType: 'claim' })
const oneRowRemains = finalRows.length === 1
console.log(`  exactly one claim row remains on-chain: ${oneRowRemains} (found ${finalRows.length})`)

const reproduced = exactlyOneHeld && oneRowRemains
console.log(`\nRESULT: ${reproduced ? 'passed' : 'FAILED'}`)
process.exit(reproduced ? 0 : 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env scripts/verify-tie-break.mjs`
Expected: FAIL — `Cannot find module '../src/protocol.mjs'`.

- [ ] **Step 3: Implement `src/protocol.mjs`**

```js
// The claim-takeover protocol state machine (ARCHITECTURE.md §7). Every write goes through
// src/memory.mjs's writeMemory, never src/arkiv.mjs's createMemory directly — that guarantees
// every entity this protocol writes has a real swarm_ref, never a placeholder.

import { queryByTagAndType, extendMemory, deleteMemory, AGENT_IDS } from './arkiv.mjs'
import { writeMemory } from './memory.mjs'
import { writeToLane, readLane } from './lane.mjs'

const CLAIM_LEASE_BLOCKS = 12 // long enough to fit a one-block settle window ahead of the first
                               // renewal at ~1/3 lease; see spec's B7 resolution
const LONG_LIVED_BLOCKS = 600 // matches event/lane/done/verdict TTL elsewhere in the protocol

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForBlock(pub, targetBlock) {
  while ((await pub.getBlockNumber()) < targetBlock) {
    await sleep(500)
  }
}

async function currentBlock(pub) {
  return pub.getBlockNumber()
}

// Cheapest-to-honor first: a closed incident should never be reopened by a worker, and finished
// work should never be redone.
async function incidentIsSpokenFor(ctx, tag) {
  const { pub } = ctx
  const verdicts = await queryByTagAndType(pub, { tag, memoryType: 'verdict', limit: 1 })
  if (verdicts.length > 0) return true
  const dones = await queryByTagAndType(pub, { tag, memoryType: 'done', limit: 1 })
  if (dones.length > 0) return true
  const claims = await queryByTagAndType(pub, { tag, memoryType: 'claim', limit: 1 })
  return claims.length > 0
}

export async function tryClaim(ctx, agentId, tag) {
  const { pub, signers } = ctx
  const signer = signers.get(agentId)
  if (!signer) throw new Error(`no signer configured for agentId "${agentId}"`)

  if (await incidentIsSpokenFor(ctx, tag)) return { held: false }

  const written = await writeMemory(signer.wallet, {
    agentId, memoryType: 'claim', tag, importance: 5, content: {}, ttlBlocks: CLAIM_LEASE_BLOCKS,
  })

  // Settle window: without waiting for both writers' claims to be visible, each can see only its
  // own row and both conclude they won. Wait one block past this tx's own block.
  const txBlock = (await pub.getTransactionReceipt({ hash: written.txHash })).blockNumber
  await waitForBlock(pub, txBlock + 1n)

  const rivals = await queryByTagAndType(pub, { tag, memoryType: 'claim' })
  if (rivals.length === 0) {
    // Another agent's claim already lapsed or was deleted between our write and our re-query —
    // extremely unlikely at a 12-block lease, but re-check rather than assume we still hold it.
    return { held: false }
  }
  const sorted = [...rivals].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const winner = sorted[0]
  if (winner.key !== written.entityKey) {
    await deleteMemory(signer.wallet, { entityKey: written.entityKey })
    await sleep(200 + Math.floor(Math.random() * 300))
    return tryClaim(ctx, agentId, tag)
  }
  return { held: true, entityKey: written.entityKey }
}

export async function renewClaim(ctx, agentId, entityKey, leaseBlocks = CLAIM_LEASE_BLOCKS, shouldContinue = () => true) {
  const { pub, signers } = ctx
  const signer = signers.get(agentId)
  const renewEveryBlocks = Math.max(1, Math.floor(leaseBlocks / 3))
  while (shouldContinue()) {
    const start = await currentBlock(pub)
    await waitForBlock(pub, start + BigInt(renewEveryBlocks))
    try {
      await extendMemory(signer.wallet, { entityKey, ttlBlocks: leaseBlocks })
    } catch (e) {
      // The engine rejects an extension that would not move the expiry later — that happens when
      // this renewal landed extremely close behind a previous one. Treat it as a no-op, not a
      // dropped lease.
      if (!/expiry/i.test(e.message)) throw e
    }
  }
}

export async function takeOver(ctx, tag) {
  const { pub } = ctx
  const lanes = await queryByTagAndType(pub, { tag, memoryType: 'lane' })
  const results = []
  for (const laneRow of lanes) {
    const ownerAddress = laneRow.owner
    let index = 0
    let latestContent = null
    let latestIndex = -1
    // Walk from index 0 until a clean 404 — matches the discovery method ARCHITECTURE.md §7
    // specifies; small counts expected at demo scale.
    while (true) {
      const content = await readLane(ownerAddress, tag, index)
      if (content === null) break
      latestContent = content
      latestIndex = index
      index += 1
    }
    if (latestContent) results.push({ ownerAddress, latestIndex, latestContent })
  }
  return results
}

export async function finish(ctx, agentId, tag, entityKey, fixContent) {
  const { signers } = ctx
  const signer = signers.get(agentId)
  await writeToLane(signer.account.getHdKey?.() ?? process.env[`ARKIV_PRIVATE_KEY_${agentId.toUpperCase()}`], signer.account.address, tag, 0, { kind: 'fix', ...fixContent })
  await writeMemory(signer.wallet, {
    agentId, memoryType: 'lane', tag, importance: 5, content: { note: 'lane provenance marker' }, ttlBlocks: LONG_LIVED_BLOCKS,
  })
  await writeMemory(signer.wallet, {
    agentId, memoryType: 'done', tag, importance: 5, content: { note: 'work complete' }, ttlBlocks: LONG_LIVED_BLOCKS,
  })
  await deleteMemory(signer.wallet, { entityKey })
}

export async function verify(ctx, tag) {
  const { pub, signers } = ctx
  const atlasSigner = signers.get('atlas')
  let doneRows = []
  while (doneRows.length === 0) {
    doneRows = await queryByTagAndType(pub, { tag, memoryType: 'done', limit: 1 })
    if (doneRows.length === 0) await sleep(2000)
  }
  const doneRow = doneRows[0]
  const lanes = await takeOver(ctx, tag)
  const finisherLane = lanes.find((l) => l.ownerAddress.toLowerCase() === doneRow.owner.toLowerCase())
  const outcome = finisherLane?.latestContent?.kind === 'fix' ? 'fixed' : 'reopened'
  await writeMemory(atlasSigner.wallet, {
    agentId: 'atlas', memoryType: 'verdict', tag, importance: 5,
    content: { reasoning: `checked ${doneRow.owner}'s lane, found a ${finisherLane?.latestContent?.kind ?? 'missing'} entry` },
    ttlBlocks: LONG_LIVED_BLOCKS, roster: AGENT_IDS, outcome,
  })
  return { outcome }
}
```

A note on `finish`'s first line: `signers.get(agentId).account` is a viem account built by
`privateKeyToAccount`, which does not expose the raw private key (by design). `writeToLane` needs
the raw hex key to construct a bee-js `PrivateKey` internally. Rather than trying to extract it
from the viem account, read it directly from the same env var `makeAgentSigners` itself reads —
replace that first line with:

```js
const agentPrivateKeyHex = process.env[`ARKIV_PRIVATE_KEY_${agentId.toUpperCase()}`]
await writeToLane(agentPrivateKeyHex, signer.account.address, tag, 0, { kind: 'fix', ...fixContent })
```

(Delete the `signer.account.getHdKey?.() ?? ...` line above and use this instead — it's simpler
and doesn't depend on a viem method that doesn't exist for this purpose.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env scripts/verify-tie-break.mjs`
Expected: PASS — exactly one of nova/sol holds the claim, exactly one claim row remains on-chain.

Note: this test can occasionally take a few seconds per run (block-time bound: the settle wait is
one Tiramisu block, ~2s, per attempt). That's expected, not a bug.

- [ ] **Step 5: Commit**

```bash
git add src/protocol.mjs scripts/verify-tie-break.mjs
git commit -m "feat: implement the claim-takeover protocol state machine"
```

---

## Task 6: Orchestrator — run all three agents in one process

**Files:**
- Create: `scripts/orchestrator.mjs`

**Interfaces:**
- Consumes: `tryClaim`, `renewClaim`, `takeOver`, `finish`, `verify` from `src/protocol.mjs`;
  `makeClients`, `makeAgentSigners` from `src/arkiv.mjs`; `writeMemory` from `src/memory.mjs`.
- Produces: a runnable script, no exported functions (this is the demo entry point, not a library).

This task has no unit test — it's the integration point, exercised by running it and observing the
log output and/or querying the running `server.mjs`/`api/index.mjs` for the rows it produces. Keep
it in one process deliberately (Global Constraints) so the shared `Stamper` in `src/swarm.mjs`
never sees its bucket counters split across processes.

- [ ] **Step 1: Write the script**

```js
// Runs atlas, nova, and sol as concurrent loops in one process, so they share one Swarm Stamper
// (see Global Constraints in the implementation plan — splitting them into separate OS processes
// would let each start every postage bucket at slot 0 on the same shared batch).
//
//   node --env-file=.env scripts/orchestrator.mjs <tag>
//
// Example: node --env-file=.env scripts/orchestrator.mjs incident-42

import { makeClients, makeAgentSigners } from '../src/arkiv.mjs'
import { writeMemory } from '../src/memory.mjs'
import { writeToLane } from '../src/lane.mjs'
import { tryClaim, renewClaim, takeOver, finish, verify } from '../src/protocol.mjs'

const httpUrl = process.env.ARKIV_HTTP_URL
const wsUrl = process.env.ARKIV_WS_URL
const { pub } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY, httpUrl, wsUrl })
const signers = makeAgentSigners({ httpUrl })
const ctx = { pub, signers }

const tag = process.argv[2] ?? `incident-${Date.now()}`
const log = (agent, msg) => console.log(`[${agent}] ${msg}`)

async function atlasReports() {
  const atlas = signers.get('atlas')
  const agentPrivateKeyHex = process.env.ARKIV_PRIVATE_KEY_ATLAS
  await writeToLane(agentPrivateKeyHex, atlas.account.address, tag, 0, { kind: 'diagnosis', note: 'incident detected' })
  await writeMemory(atlas.wallet, {
    agentId: 'atlas', memoryType: 'event', tag, importance: 8,
    content: { note: 'incident detected' }, ttlBlocks: 600,
  })
  log('atlas', `reported ${tag}`)
}

async function workerLoop(agentId) {
  const claimed = await tryClaim(ctx, agentId, tag)
  if (!claimed.held) {
    log(agentId, 'lost the race or incident already spoken for — exiting')
    return
  }
  log(agentId, `holds the claim (${claimed.entityKey.slice(0, 18)}…)`)
  let renewing = true
  const renewalPromise = renewClaim(ctx, agentId, claimed.entityKey, undefined, () => renewing)

  // Simulated work: a real worker would diagnose and fix here. This orchestrator just
  // demonstrates the mechanism, so it pauses briefly then finishes.
  await new Promise((resolve) => setTimeout(resolve, 5000))

  renewing = false
  await renewalPromise
  await finish(ctx, agentId, tag, claimed.entityKey, { note: `fixed by ${agentId}` })
  log(agentId, 'finished')
}

async function atlasVerifies() {
  const result = await verify(ctx, tag)
  log('atlas', `verdict: ${result.outcome}`)
}

await atlasReports()
await Promise.race([workerLoop('nova'), workerLoop('sol')])
await atlasVerifies()
```

- [ ] **Step 2: Run it against Tiramisu**

Run: `node --env-file=.env scripts/orchestrator.mjs`
Expected: log lines showing atlas reporting, one of nova/sol claiming and finishing, atlas
verifying with `outcome: fixed`. Cross-check with `queryByTagAndType`-style querying (or the
running `server.mjs` UI) that the tag now has `event`, `lane`, `done`, and `verdict` rows and no
lingering `claim` row.

- [ ] **Step 3: Commit**

```bash
git add scripts/orchestrator.mjs
git commit -m "feat: add single-process orchestrator running the full claim-takeover demo"
```

---

## Task 7: Correct ARCHITECTURE.md's access-control claim

**Files:**
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Fix the overstated roster claim**

In §7's "Discovery: two questions, two systems" subsection, find:

> The roster in the incident's envelope bounds this a second time: it is the set of wallets that
> can decrypt the report at all, so it is also the largest set that could ever have worked it.

Replace with:

> The roster in the incident's envelope bounds this a second time — in principle: each memory is
> sealed to a roster of agent public keys (§2's envelope encryption), so it is *shaped* like a
> bound on who could ever decrypt it. In this deployment that bound is not actually enforced,
> because one process holds all three agents' private keys and does both the sealing and the
> opening — any party with server access can decrypt everything regardless of roster. What's real
> today is a demonstrated per-agent sealing mechanism; what would make the bound real is splitting
> the agents into separate processes with separate key custody, which is future work.

Also update the encryption description wherever §4 or §2 describes the old single-key scheme (the
"Rotating MEMORY_ENC_KEY" language) to describe the new roster-scoped binary envelope instead —
match whatever wording Task 2 leaves in `src/swarm.mjs`'s own top-of-file comment, so the doc and
the code comment agree.

- [ ] **Step 2: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: correct the roster/access-control claim in §7 to match what's actually enforced"
```

---

## Self-Review Notes (for whoever executes this plan)

- **Spec coverage:** §1 (lane writes) → Task 4. §2 (envelope encryption) → Tasks 1–2. §3 (schema/
  queries) → Task 3. §4 (protocol state machine) → Task 5. §5 (live view) → folded into Task 3's
  `watchMemories` extension. Honesty note → Task 7. Orchestrator → Task 6. Testing section's
  `scripts/verify-lane.mjs` and a tie-break script → Tasks 4 and 5 respectively.
- **Known follow-up, not in this plan:** wiring the extended `watchMemories` callbacks
  (`onExpired`, `onExtended`) into `server.mjs`'s `/live` broadcast so the browser UI actually
  shows a lease being renewed and then lapsing — Task 3 only adds the callbacks to the function
  signature. If the demo needs this visible in the browser (not just in orchestrator logs), that's
  a small follow-up task against `server.mjs:39-65`, deliberately left out of this plan since it's
  UI wiring rather than protocol correctness.
- **Known deferred (per spec):** multi-chunk splitting for >4KB memories, real per-process key
  custody, `Stamper.fromState` persistence, lane content ordering beyond the `lane` row TTL proxy.
