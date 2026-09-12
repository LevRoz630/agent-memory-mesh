# Peer-Symmetric Maintenance Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any of the three agents can detect a peer's outage, claim it, fix it, and verify the
fix — replacing the fixed "atlas monitors, nova/sol work" roster with generic peer machinery.

**Architecture:** A `heartbeat` entity type gives each agent a liveness signal using the same
expiring-lease mechanism claims already use. Every agent runs three loops instead of a
role-specific one: renew its own heartbeat, watch its peers' heartbeats and file an incident on a
lapse, and the existing claim/work loop (unchanged). `verify()` takes the verifying agent as a
parameter instead of hardcoding atlas.

**Tech Stack:** Same as the rest of this repo — `@arkiv-network/sdk`, `@ethersphere/bee-js`, no
test framework (narrative, exit-code scripts).

**Spec:** `docs/superpowers/specs/2026-09-13-peer-symmetric-maintenance-design.md`

## ⚠️ Pre-condition: isolation

`src/protocol.mjs` and `src/demo.mjs` — the two files this plan touches most — currently have
uncommitted changes from a separate, concurrently active session (control-room demo work). This
is a real, observed collision risk, not a hypothetical one. **Do not start Task 1 until this is
resolved**: either coordinate a pause with that session, or do this work in a separate branch/
worktree and rebase/merge deliberately rather than editing the same uncommitted files live.

## Global Constraints

- Every entity write goes through `src/memory.mjs`'s `writeMemory`, never `src/arkiv.mjs`'s
  `createMemory` directly — every row must carry a real `swarm_ref`.
- `memory_type` stays whitelisted (`src/arkiv.mjs`'s `MEMORY_TYPES`) — add to it, never bypass it.
- Heartbeat TTL must be short enough to detect an outage within a demo-visible timeframe (a few
  renewal cycles), matching the existing claim lease's renew-at-1/3-of-TTL discipline.
- Run scripts with `node --env-file=.env <script>`.

---

## Task 1: Add the `heartbeat` entity type

**Files:**
- Modify: `src/arkiv.mjs`
- Test: `scripts/verify-heartbeat-schema.mjs` (new)

**Interfaces:**
- Produces: `MEMORY_TYPES` now includes `'heartbeat'`.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-heartbeat-schema.mjs`:

```js
// Live check: heartbeat is accepted as a memory_type, queryable the same way claims are.
//
//   node --env-file=.env scripts/verify-heartbeat-schema.mjs

import { makeClients, createMemory, queryByTagAndType } from '../src/arkiv.mjs'

const { wallet } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY })
const tag = `verify-heartbeat-${Date.now()}`

console.log('heartbeat entity type\n')

const { entityKey } = await createMemory(wallet, {
  agentId: 'atlas', memoryType: 'heartbeat', tag, importance: 1, swarmRef: '0'.repeat(64), ttlBlocks: 8,
})
console.log(`  wrote heartbeat row, entityKey ${entityKey.slice(0, 18)}…`)

const rows = await queryByTagAndType(makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY }).pub, { tag, memoryType: 'heartbeat' })
const found = rows.length === 1 && rows[0].attributes.memory_type === 'heartbeat'
console.log(`  queryByTagAndType finds it: ${found}`)

console.log(`\nRESULT: ${found ? 'passed' : 'FAILED'}`)
process.exit(found ? 0 : 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env scripts/verify-heartbeat-schema.mjs`
Expected: FAIL — `Invalid memory_type "heartbeat" — must be one of: event, claim, lane, done, verdict`.

- [ ] **Step 3: Implement**

In `src/arkiv.mjs`, change:

```js
export const MEMORY_TYPES = ['event', 'claim', 'lane', 'done', 'verdict']
```

to:

```js
export const MEMORY_TYPES = ['event', 'claim', 'lane', 'done', 'verdict', 'heartbeat']
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env scripts/verify-heartbeat-schema.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/arkiv.mjs scripts/verify-heartbeat-schema.mjs
git commit -m "feat: add heartbeat as a whitelisted memory_type"
```

---

## Task 2: Heartbeat renewal

**Files:**
- Modify: `src/protocol.mjs`
- Test: `scripts/verify-heartbeat-lapse.mjs` (new)

**Interfaces:**
- Consumes: `writeMemory` from `src/memory.mjs`, `extendMemory`, `queryByTagAndType` from
  `src/arkiv.mjs` (all already imported in this file).
- Produces: `startHeartbeat(ctx, agentId, shouldContinue) -> Promise<void>` — writes an initial
  `heartbeat` row on `tag: 'agent-<agentId>'`, then renews it on the same cadence `renewClaim`
  uses, until `shouldContinue()` returns false. Unlike a claim, nothing deletes a heartbeat row on
  stopping — it simply stops being renewed and lapses on its own, which IS the "agent is down"
  signal.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-heartbeat-lapse.mjs`:

```js
// Live check: a heartbeat renews while its loop runs, and lapses cleanly once stopped.
//
//   node --env-file=.env scripts/verify-heartbeat-lapse.mjs

import { makeClients, makeAgentSigners, queryByTagAndType } from '../src/arkiv.mjs'
import { startHeartbeat, HEARTBEAT_LEASE_BLOCKS } from '../src/protocol.mjs'

const httpUrl = process.env.ARKIV_HTTP_URL
const { pub } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY, httpUrl })
const signers = makeAgentSigners({ httpUrl })
const ctx = { pub, signers }

console.log('heartbeat renewal and lapse\n')

let running = true
const hb = startHeartbeat(ctx, 'nova', () => running)

// Let it write and renew at least once.
await new Promise((r) => setTimeout(r, 8000))
const tag = 'agent-nova'
const alive = await queryByTagAndType(pub, { tag, memoryType: 'heartbeat', limit: 1 })
console.log(`  heartbeat visible while running: ${alive.length === 1}`)

running = false
await hb

// Wait past the lease so it lapses.
await new Promise((r) => setTimeout(r, (HEARTBEAT_LEASE_BLOCKS + 2) * 2000))
const gone = await queryByTagAndType(pub, { tag, memoryType: 'heartbeat', limit: 1 })
console.log(`  heartbeat lapsed after stopping: ${gone.length === 0}`)

const reproduced = alive.length === 1 && gone.length === 0
console.log(`\nRESULT: ${reproduced ? 'passed' : 'FAILED'}`)
process.exit(reproduced ? 0 : 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env scripts/verify-heartbeat-lapse.mjs`
Expected: FAIL — `startHeartbeat is not a function`.

- [ ] **Step 3: Implement in `src/protocol.mjs`**

```js
export const HEARTBEAT_LEASE_BLOCKS = 8

export async function startHeartbeat(ctx, agentId, shouldContinue = () => true) {
  const { pub, signers } = ctx
  const signer = signers.get(agentId)
  if (!signer) throw new Error(`no signer configured for agentId "${agentId}"`)
  const tag = `agent-${agentId}`
  await writeMemory(signer.wallet, {
    agentId, memoryType: 'heartbeat', tag, importance: 1, content: {}, ttlBlocks: HEARTBEAT_LEASE_BLOCKS,
  })
  const renewEveryBlocks = Math.max(1, Math.floor(HEARTBEAT_LEASE_BLOCKS / 3))
  while (shouldContinue()) {
    const start = await currentBlock(pub)
    await waitForBlock(pub, start + BigInt(renewEveryBlocks))
    if (!shouldContinue()) break
    const rows = await queryByTagAndType(pub, { tag, memoryType: 'heartbeat', limit: 1 })
    if (rows.length === 0) return // agent was already considered down elsewhere; stop renewing
    try {
      await extendMemory(signer.wallet, { entityKey: rows[0].key, ttlBlocks: HEARTBEAT_LEASE_BLOCKS })
    } catch (e) {
      if (!/expiry/i.test(e.message)) throw e
    }
  }
}
```

Place this after `renewClaim` — it's structurally similar but intentionally not a generalization
of it (a heartbeat has no `entityKey` handed to it by a caller the way a claim does; it looks its
own row up by tag).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env scripts/verify-heartbeat-lapse.mjs`
Expected: PASS. This test takes about 30-40 seconds (real block waits) — that's expected.

- [ ] **Step 5: Commit**

```bash
git add src/protocol.mjs scripts/verify-heartbeat-lapse.mjs
git commit -m "feat: add heartbeat renewal as a peer liveness signal"
```

---

## Task 3: Peer-outage detection

**Files:**
- Modify: `src/protocol.mjs`
- Test: `scripts/verify-peer-outage-detection.mjs` (new)

**Interfaces:**
- Consumes: `startHeartbeat`, `HEARTBEAT_LEASE_BLOCKS` from Task 2; `AGENT_IDS` from
  `src/arkiv.mjs`; `writeMemory` from `src/memory.mjs`.
- Produces: `watchForPeerOutages(ctx, watchingAgentId, onOutageDetected) -> () => void` — starts a
  polling loop, returns a stop function. `onOutageDetected(peerId, outageTag)` is called at most
  once per outage (guarded by the same `and(app, tag, memory_type)` existence check every other
  incident uses).

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-peer-outage-detection.mjs`:

```js
// Live check: nova's heartbeat lapses, sol's watch loop detects it and files exactly one
// outage incident — not zero, not a duplicate.
//
//   node --env-file=.env scripts/verify-peer-outage-detection.mjs

import { makeClients, makeAgentSigners, queryByTagAndType } from '../src/arkiv.mjs'
import { startHeartbeat, watchForPeerOutages } from '../src/protocol.mjs'

const httpUrl = process.env.ARKIV_HTTP_URL
const { pub } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY, httpUrl })
const signers = makeAgentSigners({ httpUrl })
const ctx = { pub, signers }

console.log('peer outage detection\n')

// Nova beats briefly, then stops — simulating a crash, not a graceful shutdown.
let novaRunning = true
const novaHb = startHeartbeat(ctx, 'nova', () => novaRunning)
await new Promise((r) => setTimeout(r, 3000))
novaRunning = false
await novaHb
console.log('  nova heartbeat stopped (simulated crash)')

const detected = []
const stopWatch = watchForPeerOutages(ctx, 'sol', (peerId, tag) => detected.push({ peerId, tag }))

// Wait past nova's lease plus enough polling cycles for sol to notice.
await new Promise((r) => setTimeout(r, 30000))
stopWatch()

const novaDetected = detected.filter((d) => d.peerId === 'nova')
console.log(`  sol detected nova's outage: ${novaDetected.length >= 1} (${novaDetected.length} time(s))`)

const rows = await queryByTagAndType(pub, { tag: 'outage-nova', memoryType: 'event' })
console.log(`  exactly one outage incident on-chain: ${rows.length === 1} (found ${rows.length})`)

const reproduced = novaDetected.length >= 1 && rows.length === 1
console.log(`\nRESULT: ${reproduced ? 'passed' : 'FAILED'}`)
process.exit(reproduced ? 0 : 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env scripts/verify-peer-outage-detection.mjs`
Expected: FAIL — `watchForPeerOutages is not a function`.

- [ ] **Step 3: Implement in `src/protocol.mjs`**

```js
const PEER_WATCH_POLL_MS = 4000

export function watchForPeerOutages(ctx, watchingAgentId, onOutageDetected) {
  const { pub, signers } = ctx
  let stopped = false
  const loop = async () => {
    while (!stopped) {
      for (const peerId of AGENT_IDS) {
        if (peerId === watchingAgentId) continue
        const peerTag = `agent-${peerId}`
        const heartbeats = await queryByTagAndType(pub, { tag: peerTag, memoryType: 'heartbeat', limit: 1 })
        if (heartbeats.length > 0) continue // peer is alive

        const outageTag = `outage-${peerId}`
        const existing = await queryByTagAndType(pub, { tag: outageTag, memoryType: 'event', limit: 1 })
        if (existing.length > 0) continue // already filed, by us or another watcher

        const signer = signers.get(watchingAgentId)
        await writeMemory(signer.wallet, {
          agentId: watchingAgentId, memoryType: 'event', tag: outageTag, importance: 8,
          content: { note: `${peerId} heartbeat lapsed` }, ttlBlocks: LONG_LIVED_BLOCKS,
        })
        onOutageDetected?.(peerId, outageTag)
      }
      await sleep(PEER_WATCH_POLL_MS)
    }
  }
  loop().catch((e) => console.error(`watchForPeerOutages(${watchingAgentId}) failed:`, e.message))
  return () => { stopped = true }
}
```

Note the race this doesn't fully close: two watchers can both pass the `existing.length > 0`
check in the same polling tick and both file. This is the same class of race `tryClaim`'s tie-
break already handles downstream — a duplicate `event` row for the same outage tag doesn't cause
double-fixing, since `tryClaim`'s own `incidentIsSpokenFor` check still only allows one `claim` to
win. Two `event` rows for one outage is cosmetic duplication, not a correctness bug; not worth a
second confirmation round the way the claim tie-break needed one.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env scripts/verify-peer-outage-detection.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocol.mjs scripts/verify-peer-outage-detection.mjs
git commit -m "feat: detect a lapsed peer heartbeat and file the outage as an incident"
```

---

## Task 4: Generalize `verify()` to take the verifying agent as a parameter

**Files:**
- Modify: `src/protocol.mjs`
- Modify: `scripts/orchestrator.mjs`

**Interfaces:**
- Produces: `verify(ctx, verifierAgentId, tag) -> Promise<{ outcome }>` (was `verify(ctx, tag)`).

**⚠️ Before starting this task**, re-read the current `src/protocol.mjs` in full — Task 1-3 of
this plan added code above `verify()`, and a concurrent session may have touched this same
function in the meantime (see the pre-condition at the top of this plan). Apply this change
against whatever `verify()` actually looks like at execution time, not the snippet below verbatim
if it has drifted.

- [ ] **Step 1: Update the signature**

In `src/protocol.mjs`, change:

```js
export async function verify(ctx, tag) {
  const { pub, signers } = ctx
  const atlasSigner = signers.get('atlas')
  if (!atlasSigner) throw new Error('no signer configured for agentId "atlas"')
```

to:

```js
export async function verify(ctx, verifierAgentId, tag) {
  const { pub, signers } = ctx
  const verifierSigner = signers.get(verifierAgentId)
  if (!verifierSigner) throw new Error(`no signer configured for agentId "${verifierAgentId}"`)
```

And later in the same function, replace every remaining `atlasSigner` with `verifierSigner`, and
`agentId: 'atlas'` in the `writeMemory` call with `agentId: verifierAgentId`.

- [ ] **Step 2: Update the one existing caller**

In `scripts/orchestrator.mjs`, change:

```js
const result = await verify(ctx, tag)
```

to:

```js
const result = await verify(ctx, 'atlas', tag)
```

(The orchestrator's own scenario is unchanged — atlas still verifies there. Only `demo.mjs`, in
Task 5, uses the new flexibility.)

- [ ] **Step 3: Run the orchestrator to confirm no regression**

Run: `node --env-file=.env scripts/orchestrator.mjs`
Expected: same behavior as before — atlas reports, a worker claims/finishes, atlas verifies with
`outcome: fixed`.

- [ ] **Step 4: Commit**

```bash
git add src/protocol.mjs scripts/orchestrator.mjs
git commit -m "refactor: verify() takes the verifying agent as a parameter instead of hardcoding atlas"
```

---

## Task 5: Wire peer symmetry into the demo controller

**Files:**
- Modify: `src/demo.mjs`

**⚠️ This file is under active concurrent development** (the control-room demo UI). Re-read it in
full immediately before starting — its `worker()`/`start()`/`kill()` shape may have changed since
this plan was written. The task below describes the transformation to make, not a verbatim diff.

**Interfaces:**
- Consumes: `startHeartbeat`, `watchForPeerOutages` (Task 2-3), `verify(ctx, verifierAgentId, tag)`
  (Task 4), plus the existing `tryClaim`/`renewClaim`/`finish` this file already calls.

- [ ] **Step 1: Replace the fixed roster with symmetric loops**

Current shape (as of this plan's writing): `start()` writes one hardcoded incident as atlas, then
spawns `worker(run, id)` only for `['nova', 'sol']`; `kill(agentId)` just flips a flag.

New shape: every agent in `AGENT_IDS` gets, for the lifetime of a demo run:
1. A heartbeat loop (`startHeartbeat`), stopped when that agent is killed.
2. A peer-watch loop (`watchForPeerOutages`) whose `onOutageDetected` callback kicks off that
   agent's existing worker loop against the outage's tag (`tryClaim` → work steps → `finish`),
   exactly the same work loop already written for nova/sol, just no longer restricted to them.
3. When an incident resolves (`finish` completes), whichever agent's watch loop next polls and
   sees the `done` row calls `verify(ctx, itsOwnAgentId, tag)`.

`kill(agentId)` now means: stop that agent's heartbeat loop (it goes silent, detectable by peers)
and stop its own peer-watch/work loops (a dead agent doesn't keep working). It does NOT need to
directly write anything about itself being down — that's the whole point: the *other* agents
notice and file it.

- [ ] **Step 2: Preserve the demo's narrative controls**

The existing DC framing, "bring DC back online once resolved," and any password-gating or
kill-button restrictions already built are UI/demo-scenario concerns layered on top of this
generic machinery — keep them, wiring them to the new symmetric loops rather than removing them.
If a specific agent's kill button was intentionally restricted before (e.g. "can't kill DC-3, the
survivor, on camera"), that restriction can stay; it constrains which demo *buttons* exist, not
which agents the protocol treats specially.

- [ ] **Step 3: Manual verification**

Run the demo (however this session's control-room server currently starts it), kill nova mid-run,
and confirm: nova's heartbeat lapses, another agent's watch loop detects it, files the outage,
someone claims and fixes it, and a verdict gets written by whichever agent's watch loop noticed
`done` first. Then repeat killing atlas, to confirm the previously-special agent is now just
another peer that can also go down and be recovered the same way.

- [ ] **Step 4: Commit**

```bash
git add src/demo.mjs
git commit -m "feat: make the demo controller peer-symmetric — any agent can detect, fix, or verify"
```

---

## Self-Review Notes

- **Spec coverage:** heartbeat type → Task 1. Renewal → Task 2. Detection → Task 3. Verify
  generalization → Task 4. Demo integration → Task 5. "Explicitly out of scope" items (real
  health checks, Byzantine faults) have no task — correctly absent.
- **Known risk carried into execution:** Tasks 4 and 5 both touch files with a live, uncommitted,
  concurrent editor. Both tasks explicitly instruct re-reading the file fresh before editing
  rather than trusting this plan's snippets verbatim — this is a plan-level mitigation, not a
  guarantee; the pre-condition at the top is the real fix.
