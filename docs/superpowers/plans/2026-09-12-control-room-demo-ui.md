# Control Room Demo UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser "control room" for a hosting provider where you start a rack failure, cut power to data centers one by one, and watch the incident get claimed, dropped, taken over and resolved on Arkiv, with the encrypted incident report opened from Swarm.

**Architecture:** A demo controller (`src/demo.mjs`) runs Nova and Sol as in-process worker loops inside `server.mjs`, driving the existing claim-takeover protocol through an injected `ops` object, so the loop logic is tested offline against fakes. `src/demo-ops.mjs` binds `ops` to the real Arkiv/Swarm functions. Killing an agent stops its loop and its lease renewal without deleting its claim, so the claim lapses by block height and a surviving agent takes over and resumes from the progress the dead agent left in its Swarm lane. State is pushed to `public/control.html` over the existing `/live` WebSocket.

**Tech Stack:** Node ≥20 ESM, Express, `ws`, `@arkiv-network/sdk`, `@ethersphere/bee-js`, plain HTML/JS (no framework, no build step).

**Spec:** No separate spec file. The design was agreed in chat on 2026-09-12. The story it has to show is slide 3 of `docs/PITCH_DECK_OUTLINE.md`:
1. Atlas (DC-1) sees a rack go dark and files the incident.
2. DC-1 loses power. Atlas dies with it. The incident is still open.
3. Nova (DC-2) claims it and starts recovery.
4. Nova's region fails mid-fix. Its claim expires on its own.
5. Sol (DC-3) takes over, resumes from Nova's progress, and finishes.

## Global Constraints

- One process only. All agents share one Swarm `Stamper` (`src/swarm.mjs` `getSwarm()`); separate processes would reuse postage slots. The demo runs inside `server.mjs`.
- No new npm dependencies.
- Do not edit `README.md`, `public/index.html` or `src/app.mjs`.
- Arkiv attribute names stay snake_case; `memory_type` stays within `event` / `claim` / `lane` / `done` / `verdict`.
- Every value interpolated into HTML goes through `esc()`; every value interpolated into a URL goes through `url()` (same helpers as `public/index.html`).
- Tests follow the repo's pattern: a plain `node` script in `scripts/` that prints `pass`/`FAIL` lines and `RESULT: passed|FAILED`, exiting 0 or 1. Offline tests need no `.env`.
- No comments unless they explain a non-obvious reason.
- Commits use conventional commit format and must NOT contain `Co-Authored-By` or `Claude-Session` lines (project `CLAUDE.md`).
- `package.json` has been edited by others this session. Read it immediately before editing and only add lines.

---

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `src/protocol.mjs` | modify | `renewClaim` stops without a final extension once `shouldContinue()` turns false |
| `src/demo.mjs` | create | Demo controller: run state, worker loops, kill. No I/O of its own; everything goes through `ops` |
| `src/demo-ops.mjs` | create | Real `ops`: binds the controller to Arkiv/Swarm/protocol functions |
| `src/swarm.mjs` | modify | Export `downloadSealed(ref)` (sealed bytes, no decryption) |
| `server.mjs` | modify | Create the demo, add `/api/demo/*` routes, broadcast `{ type: 'demo', state }` |
| `public/control.html` | create | Control room UI |
| `scripts/test-renew-stops.mjs` | create | Offline test for the `renewClaim` change |
| `scripts/test-demo-controller.mjs` | create | Offline test for kill → lapse → takeover → resume |
| `package.json` | modify | Add `verify:renew-stop` and `verify:demo-controller` scripts |

---

### Task 1: `renewClaim` must not extend a dead agent's lease

Today `renewClaim` waits ~4 blocks, then extends, then checks `shouldContinue()`. An agent killed during the wait therefore extends its lease once more, delaying the takeover by a whole lease on camera.

**Files:**
- Modify: `src/protocol.mjs:97-114`
- Create: `scripts/test-renew-stops.mjs`
- Modify: `package.json` (`scripts`)

**Interfaces:**
- Consumes: `renewClaim(ctx, agentId, entityKey, leaseBlocks = 12, shouldContinue = () => true)` (existing signature, unchanged)
- Produces: same signature; guarantees no `extendEntity` call after `shouldContinue()` has returned false

- [ ] **Step 1: Write the failing test**

Create `scripts/test-renew-stops.mjs`:

```js
// renewClaim must not extend a lease once shouldContinue() has gone false during its wait.
// No network, no env vars.
//
//   node scripts/test-renew-stops.mjs

import { renewClaim } from '../src/protocol.mjs'

let block = 100n
const pub = { getBlockNumber: async () => block++ }
let extendCalls = 0
const wallet = {
  extendEntity: async () => {
    extendCalls += 1
    return { txHash: '0x0', expiresAt: 0n }
  },
}
const signers = new Map([['nova', { wallet }]])

let alive = true
setTimeout(() => { alive = false }, 100)
await renewClaim({ pub, signers }, 'nova', '0xabc', 12, () => alive)

const ok = extendCalls === 0
console.log(`  ${ok ? 'pass' : 'FAIL'}: no extension after shouldContinue() went false (extendEntity calls: ${extendCalls})`)
console.log(`\nRESULT: ${ok ? 'passed' : 'FAILED'}`)
process.exit(ok ? 0 : 1)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/test-renew-stops.mjs`
Expected: `FAIL: ... (extendEntity calls: 1)` and `RESULT: FAILED`, exit code 1. Takes ~1.5 s (three 500 ms polls in `waitForBlock`).

- [ ] **Step 3: Implement**

In `src/protocol.mjs`, inside `renewClaim`'s `while` loop, add the check between the wait and the extension:

```js
  while (shouldContinue()) {
    const start = await currentBlock(pub)
    await waitForBlock(pub, start + BigInt(renewEveryBlocks))
    if (!shouldContinue()) break
    try {
      await extendMemory(signer.wallet, { entityKey, ttlBlocks: leaseBlocks })
    } catch (e) {
```

(Everything else in the function stays as it is.)

- [ ] **Step 4: Run it to verify it passes**

Run: `node scripts/test-renew-stops.mjs`
Expected: `pass: ...(extendEntity calls: 0)`, `RESULT: passed`, exit 0.

- [ ] **Step 5: Add the npm script**

Read `package.json`, then add inside `"scripts"` (after `"verify:crypto"`):

```json
    "verify:renew-stop": "node scripts/test-renew-stops.mjs",
```

Run: `npm run verify:renew-stop` → `RESULT: passed`.

- [ ] **Step 6: Commit**

```bash
git add src/protocol.mjs scripts/test-renew-stops.mjs package.json
git commit -m "fix: stop claim renewal without a final extension once the worker is gone"
```

---

### Task 2: Demo controller with kill, lapse, takeover and resume

**Files:**
- Create: `src/demo.mjs`
- Create: `scripts/test-demo-controller.mjs`
- Modify: `package.json` (`scripts`)

**Interfaces:**
- Consumes: nothing from other tasks. All I/O goes through the injected `ops`:
  - `ops.reportIncident(tag: string, report: object) → Promise<{ swarmRef: string, entityKey: string }>`
  - `ops.tryClaim(agentId: string, tag: string) → Promise<{ held: boolean, entityKey?: string }>`
  - `ops.renewClaim(agentId: string, entityKey: string, shouldContinue: () => boolean) → Promise<void>`
  - `ops.readProgress(tag: string) → Promise<number>` (number of work steps already completed by anyone)
  - `ops.recordStep(agentId: string, tag: string, step: number, laneIndex: number) → Promise<void>`
  - `ops.finish(agentId: string, tag: string, entityKey: string) → Promise<void>`
  - `ops.isDone(tag: string) → Promise<boolean>`
- Produces (used by Tasks 3 and 4):
  - `createDemo({ ops, onUpdate?: (state) => void, timings?: { stepMs?, retryMs?, startDelayMs? } }) → { start(): Promise<State>, kill(agentId): State, getState(): State }`
  - `DATA_CENTERS = { atlas: 'DC-1 Frankfurt', nova: 'DC-2 Amsterdam', sol: 'DC-3 Milan' }`
  - `WORK_STEPS: string[]` (3 entries)
  - `INCIDENT_REPORT: object`
  - `State = { tag: string|null, phase: 'idle'|'running'|'resolved'|'failed', report: { swarmRef, entityKey }|null, stepsDone: number, agents: { [id]: { dc: string, alive: boolean, status: 'idle'|'watching'|'claiming'|'waiting'|'working'|'done'|'dead'|'error' } }, timeline: Array<{ at: number, agentId: string, text: string }> }`

Behaviour that matters:
- `start()` replaces the current run. Loops from an older run check `run === state` and exit, so you can restart for a retake at any time.
- `kill(id)` sets `alive = false` and `status = 'dead'`. The dead agent's claim is **not** deleted; it lapses on its own. That lapse is what the demo is showing.
- A worker that wins the claim reads progress first and continues from there, so steps are never redone.
- Atlas only files the report; Nova and Sol are the workers. Sol starts later than Nova so Nova reliably claims first on camera.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-demo-controller.mjs`:

```js
// The demo controller against fake ops: kill the claim holder mid-work, the survivor must wait for
// the lease to lapse, take over, and resume from the dead agent's progress. No network, no env vars.
//
//   node scripts/test-demo-controller.mjs

import { createDemo, WORK_STEPS } from '../src/demo.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeOps({ leaseMs }) {
  const log = []
  const steps = []
  let claim = null
  let done = false
  return {
    log,
    steps,
    async reportIncident(tag) {
      log.push(['report', tag])
      return { swarmRef: 'ab'.repeat(32), entityKey: '0x' + '1'.repeat(64) }
    },
    async tryClaim(agentId) {
      await sleep(5)
      if (done) return { held: false }
      if (claim && claim.expiresAt > Date.now()) return { held: false }
      claim = { agentId, expiresAt: Date.now() + leaseMs }
      log.push(['claim', agentId, Date.now()])
      return { held: true, entityKey: `claim-${agentId}` }
    },
    async renewClaim(agentId, _entityKey, shouldContinue) {
      while (shouldContinue()) {
        await sleep(leaseMs / 3)
        if (!shouldContinue()) return
        if (claim?.agentId === agentId) claim.expiresAt = Date.now() + leaseMs
      }
    },
    async readProgress() {
      return steps.length
    },
    async recordStep(agentId, _tag, step) {
      steps.push({ agentId, step })
    },
    async finish(agentId) {
      done = true
      claim = null
      log.push(['finish', agentId])
    },
    async isDone() {
      return done
    },
  }
}

async function waitFor(cond, what, timeoutMs = 3000) {
  const started = Date.now()
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

const results = []
const check = (name, ok) => {
  results.push(Boolean(ok))
  console.log(`  ${ok ? 'pass' : 'FAIL'}: ${name}`)
}

console.log('demo controller: kill, lapse, takeover, resume\n')

const ops = fakeOps({ leaseMs: 150 })
const demo = createDemo({ ops, timings: { stepMs: 60, retryMs: 20, startDelayMs: { nova: 0, sol: 40 } } })

await demo.start()
check('report filed at start', ops.log.some((l) => l[0] === 'report'))
check('run is running', demo.getState().phase === 'running')

await waitFor(() => demo.getState().agents.nova.status === 'working', 'nova to start working')
demo.kill('atlas')
check('atlas marked dead', demo.getState().agents.atlas.status === 'dead')

await waitFor(() => ops.steps.length >= 1, 'nova to complete a step')
demo.kill('nova')
const killedAt = Date.now()
const novaSteps = ops.steps.filter((s) => s.agentId === 'nova').length

await waitFor(() => demo.getState().phase === 'resolved', 'the incident to resolve', 5000)
const state = demo.getState()
const solClaim = ops.log.find((l) => l[0] === 'claim' && l[1] === 'sol')

check('sol finished the incident', state.agents.sol.status === 'done')
check('sol claimed only after nova went down', solClaim && solClaim[2] >= killedAt)
check('dead nova never finished', !ops.log.some((l) => l[0] === 'finish' && l[1] === 'nova'))
check('every step done exactly once, in order', JSON.stringify(ops.steps.map((s) => s.step)) === JSON.stringify(WORK_STEPS.map((_, i) => i)))
check('sol resumed where nova stopped', ops.steps.find((s) => s.agentId === 'sol')?.step === novaSteps)
check('timeline records the resume', state.timeline.some((e) => e.agentId === 'sol' && e.text.includes('resuming')))
check('killing an unknown agent throws', (() => { try { demo.kill('mallory'); return false } catch { return true } })())

const passed = results.every(Boolean)
console.log(`\nRESULT: ${passed ? 'passed' : 'FAILED'}`)
process.exit(passed ? 0 : 1)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/test-demo-controller.mjs`
Expected: crash with `ERR_MODULE_NOT_FOUND` for `src/demo.mjs`, non-zero exit.

- [ ] **Step 3: Implement `src/demo.mjs`**

```js
export const DATA_CENTERS = { atlas: 'DC-1 Frankfurt', nova: 'DC-2 Amsterdam', sol: 'DC-3 Milan' }

export const WORK_STEPS = ['diagnose rack R12', 'power-cycle rack R12 via IPMI', 'confirm servers back online']

export const INCIDENT_REPORT = {
  rack: 'R12',
  dataCenter: DATA_CENTERS.atlas,
  symptom: 'all 8 servers unreachable, top-of-rack switch silent',
  outOfBand: { ipmiHost: '10.12.0.1', user: 'ops-recovery' },
  affectedCustomers: ['acme-shop', 'nordic-cdn', 'lumen-games'],
}

// Sol starts late so Nova reliably holds the first claim on camera.
const DEFAULT_TIMINGS = { stepMs: 6000, retryMs: 3000, startDelayMs: { nova: 0, sol: 20000 } }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function freshAgents() {
  return Object.fromEntries(Object.entries(DATA_CENTERS).map(([id, dc]) => [id, { dc, alive: true, status: 'idle' }]))
}

export function createDemo({ ops, onUpdate = () => {}, timings = {} }) {
  const t = { ...DEFAULT_TIMINGS, ...timings }
  let state = { tag: null, phase: 'idle', report: null, stepsDone: 0, agents: freshAgents(), timeline: [] }

  function getState() {
    return structuredClone(state)
  }

  // A run that has been replaced by a newer start() keeps mutating its own object but never emits.
  function emit(run) {
    if (run === state) onUpdate(getState())
  }

  function event(run, agentId, text) {
    run.timeline.push({ at: Date.now(), agentId, text })
    emit(run)
  }

  function setStatus(run, agentId, status) {
    run.agents[agentId].status = status
    emit(run)
  }

  async function worker(run, agentId) {
    const agent = run.agents[agentId]
    const live = () => agent.alive && run === state
    await sleep(t.startDelayMs[agentId] ?? 0)
    while (live()) {
      if (await ops.isDone(run.tag)) {
        if (live()) setStatus(run, agentId, 'idle')
        return
      }
      if (!live()) return
      setStatus(run, agentId, 'claiming')
      const claim = await ops.tryClaim(agentId, run.tag)
      if (!live()) return
      if (!claim.held) {
        setStatus(run, agentId, 'waiting')
        await sleep(t.retryMs)
        continue
      }
      event(run, agentId, 'claimed the incident on Arkiv')
      setStatus(run, agentId, 'working')
      let working = true
      const renewal = ops.renewClaim(agentId, claim.entityKey, () => working && live())
        .catch((e) => event(run, agentId, `lease renewal failed: ${e.message}`))
      let step = await ops.readProgress(run.tag)
      if (step > 0) event(run, agentId, `found ${step}/${WORK_STEPS.length} steps already done on Swarm, resuming`)
      let laneIndex = 0
      while (step < WORK_STEPS.length) {
        await sleep(t.stepMs)
        if (!live()) return
        await ops.recordStep(agentId, run.tag, step, laneIndex)
        laneIndex += 1
        step += 1
        run.stepsDone = step
        event(run, agentId, `step ${step}/${WORK_STEPS.length}: ${WORK_STEPS[step - 1]}`)
      }
      working = false
      await renewal
      if (!live()) return
      await ops.finish(agentId, run.tag, claim.entityKey)
      run.phase = 'resolved'
      setStatus(run, agentId, 'done')
      event(run, agentId, 'incident resolved')
      return
    }
  }

  async function start() {
    const run = { tag: `incident-${Date.now()}`, phase: 'running', report: null, stepsDone: 0, agents: freshAgents(), timeline: [] }
    state = run
    setStatus(run, 'atlas', 'watching')
    event(run, 'atlas', `rack R12 in ${DATA_CENTERS.atlas} stopped responding`)
    try {
      run.report = await ops.reportIncident(run.tag, INCIDENT_REPORT)
    } catch (e) {
      run.phase = 'failed'
      event(run, 'atlas', `failed to file the incident: ${e.message}`)
      throw e
    }
    event(run, 'atlas', 'filed the incident: index on Arkiv, encrypted report on Swarm')
    for (const id of ['nova', 'sol']) {
      worker(run, id).catch((e) => {
        run.agents[id].status = 'error'
        event(run, id, `error: ${e.message}`)
      })
    }
    return getState()
  }

  function kill(agentId) {
    const agent = state.agents[agentId]
    if (!agent) throw new Error(`unknown agent "${agentId}"`)
    if (!agent.alive) return getState()
    agent.alive = false
    agent.status = 'dead'
    event(state, agentId, `${agent.dc} lost power, ${agentId} is down`)
    return getState()
  }

  return { start, kill, getState }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node scripts/test-demo-controller.mjs`
Expected: every line `pass`, `RESULT: passed`, exit 0. If "sol claimed only after nova went down" fails, check that the dead worker's `renewClaim` `shouldContinue` includes `live()`.

- [ ] **Step 5: Add the npm script**

Read `package.json`, then add inside `"scripts"`:

```json
    "verify:demo-controller": "node scripts/test-demo-controller.mjs",
```

Run: `npm run verify:demo-controller` → `RESULT: passed`.

- [ ] **Step 6: Commit**

```bash
git add src/demo.mjs scripts/test-demo-controller.mjs package.json
git commit -m "feat: add demo controller that kills agents and hands the incident to survivors"
```

---

### Task 3: Real ops, sealed Swarm download, and `/api/demo/*` routes

**Files:**
- Modify: `src/swarm.mjs:192-197`
- Create: `src/demo-ops.mjs`
- Modify: `server.mjs`

**Interfaces:**
- Consumes: `createDemo`, `WORK_STEPS` from `src/demo.mjs` (Task 2); `tryClaim`, `renewClaim`, `takeOver`, `finish` from `src/protocol.mjs`; `writeMemory` from `src/memory.mjs`; `writeToLane` from `src/lane.mjs`; `queryByTagAndType`, `AGENT_IDS` from `src/arkiv.mjs`; `decryptWithKey` from `src/swarm.mjs`
- Produces (used by Task 4):
  - `downloadSealed(ref: string) → Promise<Buffer>` in `src/swarm.mjs`
  - `createDemoOps({ pub, signers }) → ops` in `src/demo-ops.mjs`
  - HTTP:
    - `GET /api/demo/state` → `State`
    - `POST /api/demo/start` → `{ state: State }` (resolves after the report is filed, ~5–15 s)
    - `POST /api/demo/kill/:agentId` → `{ state: State }`, 400 on unknown agent
    - `GET /api/demo/report?as=<atlas|nova|sol|outsider>` → `{ ok: true, as, bytes, report }` or `{ ok: false, as: 'outsider', bytes, ciphertextPreview, error }`; 404 before any incident
  - WebSocket `/live` message: `{ type: 'demo', state: State }` on every state change

- [ ] **Step 1: Split the sealed download out of `downloadMemory`**

In `src/swarm.mjs`, replace `downloadMemory` with:

```js
export async function downloadSealed(ref) {
  const { bee } = getSwarm()
  const chunk = await bee.chunk.download(ref, undefined, { timeout: FETCH_TIMEOUT_MS })
  return Buffer.from(chunk).subarray(8)
}

export async function downloadMemory(ref) {
  const plaintext = openForAnyAgent(await downloadSealed(ref))
  return JSON.parse(plaintext.toString('utf8'))
}
```

Run: `npm run verify:crypto` → still `RESULT: passed` (checks the module still loads and the envelope code is unchanged).

- [ ] **Step 2: Create `src/demo-ops.mjs`**

```js
import { writeMemory } from './memory.mjs'
import { writeToLane } from './lane.mjs'
import { queryByTagAndType } from './arkiv.mjs'
import { tryClaim, renewClaim, takeOver, finish as finishWork } from './protocol.mjs'
import { WORK_STEPS } from './demo.mjs'

const LONG_LIVED_BLOCKS = 600

function signerFor(ctx, agentId) {
  const signer = ctx.signers.get(agentId)
  if (!signer) throw new Error(`no signer configured for "${agentId}", set ARKIV_PRIVATE_KEY_${agentId.toUpperCase()}`)
  return signer
}

export function createDemoOps(ctx) {
  return {
    async reportIncident(tag, report) {
      const atlas = signerFor(ctx, 'atlas')
      const written = await writeMemory(atlas.wallet, {
        agentId: 'atlas', memoryType: 'event', tag, importance: 9, content: report, ttlBlocks: LONG_LIVED_BLOCKS,
      })
      return { swarmRef: written.swarmRef, entityKey: written.entityKey }
    },

    tryClaim: (agentId, tag) => tryClaim(ctx, agentId, tag),

    renewClaim: (agentId, entityKey, shouldContinue) => renewClaim(ctx, agentId, entityKey, undefined, shouldContinue),

    async readProgress(tag) {
      const lanes = await takeOver(ctx, tag)
      return lanes.reduce((max, lane) => (
        lane.latestContent?.kind === 'progress' ? Math.max(max, lane.latestContent.step + 1) : max
      ), 0)
    },

    // takeOver() finds lanes through `lane` rows on Arkiv, so the row has to exist from the first
    // step, not only at finish, or a successor can't see a dead agent's progress.
    async recordStep(agentId, tag, step, laneIndex) {
      const signer = signerFor(ctx, agentId)
      const privateKeyHex = process.env[`ARKIV_PRIVATE_KEY_${agentId.toUpperCase()}`]
      await writeToLane(privateKeyHex, signer.account.address, tag, laneIndex, { kind: 'progress', step, action: WORK_STEPS[step] })
      if (laneIndex === 0) {
        await writeMemory(signer.wallet, {
          agentId, memoryType: 'lane', tag, importance: 5, content: { note: 'lane provenance marker' }, ttlBlocks: LONG_LIVED_BLOCKS,
        })
      }
    },

    finish: (agentId, tag, entityKey) => finishWork(ctx, agentId, tag, entityKey, { note: `rack R12 recovered by ${agentId}` }),

    async isDone(tag) {
      return (await queryByTagAndType(ctx.pub, { tag, memoryType: 'done', limit: 1 })).length > 0
    },
  }
}
```

- [ ] **Step 3: Wire the demo into `server.mjs`**

Change the imports at the top of `server.mjs` to:

```js
import { createServer } from 'node:http'
import { createECDH } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { createApp, serializeAttrs } from './src/app.mjs'
import { makeClients, makeAgentSigners, watchMemories, AGENT_IDS } from './src/arkiv.mjs'
import { readMemoryContent } from './src/memory.mjs'
import { downloadSealed, decryptWithKey } from './src/swarm.mjs'
import { createDemo } from './src/demo.mjs'
import { createDemoOps } from './src/demo-ops.mjs'
```

Then insert this block directly after the `broadcast` function (before the `let unwatch = null` line):

```js
const demo = createDemo({
  ops: createDemoOps({ pub, signers }),
  onUpdate: (state) => broadcast({ type: 'demo', state }),
})

app.get('/api/demo/state', (_req, res) => res.json(demo.getState()))

app.post('/api/demo/start', async (_req, res) => {
  try {
    res.json({ state: await demo.start() })
  } catch (e) {
    console.error('demo start failed:', e)
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/demo/kill/:agentId', (req, res) => {
  try {
    res.json({ state: demo.kill(req.params.agentId) })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.get('/api/demo/report', async (req, res) => {
  try {
    const { report } = demo.getState()
    if (!report) return res.status(404).json({ error: 'no incident filed yet' })
    const sealed = await downloadSealed(report.swarmRef)
    const as = String(req.query.as ?? '')
    if (AGENT_IDS.includes(as)) {
      const keyHex = process.env[`ARKIV_PRIVATE_KEY_${as.toUpperCase()}`]
      if (!keyHex) return res.status(400).json({ error: `no key configured for "${as}"` })
      const plaintext = decryptWithKey(sealed, AGENT_IDS.indexOf(as), Buffer.from(keyHex.replace(/^0x/, ''), 'hex'))
      return res.json({ ok: true, as, bytes: sealed.length, report: JSON.parse(plaintext.toString('utf8')) })
    }
    const outsider = createECDH('secp256k1')
    outsider.generateKeys()
    try {
      decryptWithKey(sealed, 0, outsider.getPrivateKey())
      res.status(500).json({ error: 'an outsider key decrypted the report, roster encryption is broken' })
    } catch {
      res.json({
        ok: false, as: 'outsider', bytes: sealed.length,
        ciphertextPreview: sealed.subarray(0, 48).toString('hex'),
        error: "Not on this incident's roster: cannot decrypt.",
      })
    }
  } catch (e) {
    console.error('demo report failed:', e)
    res.status(500).json({ error: e.message })
  }
})
```

- [ ] **Step 4: Verify against the live network**

Run the server in the background: `npm start`
Then:

```bash
curl -s localhost:3000/api/demo/state
curl -s -X POST localhost:3000/api/demo/kill/mallory
curl -s localhost:3000/api/demo/report
curl -s -X POST localhost:3000/api/demo/start
```

Expected, in order:
1. JSON with `"phase":"idle"` and three agents.
2. `{"error":"unknown agent \"mallory\""}` (HTTP 400).
3. `{"error":"no incident filed yet"}` (HTTP 404).
4. After ~5–15 s, `{"state":{...,"phase":"running","report":{"swarmRef":"<64 hex>","entityKey":"0x..."}}}`.

Then:

```bash
curl -s "localhost:3000/api/demo/report?as=sol"
curl -s "localhost:3000/api/demo/report?as=outsider"
```

Expected: the first returns `"ok":true` with the `INCIDENT_REPORT` object; the second returns `"ok":false` with `ciphertextPreview` hex.

Wait ~60 s, then `curl -s localhost:3000/api/demo/state`: `nova` should be `working` or `done`, with timeline entries `claimed the incident on Arkiv` and `step 1/3: ...`. Stop the server.

If `start` fails with a signer error, the `.env` is missing `ARKIV_PRIVATE_KEY_ATLAS/NOVA/SOL`. Stop and report it; don't work around it.

- [ ] **Step 5: Commit**

```bash
git add src/swarm.mjs src/demo-ops.mjs server.mjs
git commit -m "feat: run the control-room demo in the server with kill, state and report routes"
```

---

### Task 4: Control room page

**Files:**
- Create: `public/control.html`

**Interfaces:**
- Consumes: the HTTP routes and `/live` `{ type: 'demo', state }` message from Task 3; `GET /api/head` (existing)
- Produces: the page served at `http://localhost:3000/control.html`

- [ ] **Step 1: Create `public/control.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Hydra · Control Room</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; --swarm: #e67e22; --arkiv: #16a085; --ok: #2ecc71; --bad: #e74c3c; --muted: #888; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; line-height: 1.4; }
  header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; flex-wrap: wrap; }
  h1 { font-size: 1.4rem; margin: 0; }
  #head { font-size: 0.85rem; color: var(--muted); font-variant-numeric: tabular-nums; }
  .sub { color: var(--muted); font-size: 0.9rem; margin-bottom: 1rem; }
  button { font: inherit; font-weight: 600; padding: 0.45rem 1rem; border-radius: 6px; border: 1px solid #8886; cursor: pointer; }
  button:disabled { opacity: 0.4; cursor: default; }
  .dcs { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; margin: 1rem 0; }
  .dc { border: 1px solid #8884; border-radius: 8px; padding: 1rem; }
  .dc.down { opacity: 0.45; }
  .dc h2 { font-size: 1rem; margin: 0 0 0.5rem; }
  .rack { display: flex; gap: 4px; margin: 0.5rem 0; }
  .rack span { width: 18px; height: 18px; border-radius: 3px; background: var(--ok); }
  .rack span.failed { background: var(--bad); }
  .dc.down .rack span { background: var(--muted); }
  .agent { font-size: 0.9rem; margin-bottom: 0.6rem; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 0.35rem; background: var(--muted); }
  .dot.live { background: var(--ok); }
  .dot.busy { background: var(--swarm); }
  .dot.dead { background: var(--bad); }
  fieldset { border: 1px solid #8884; border-radius: 8px; padding: 1rem; margin-bottom: 1.2rem; }
  legend { font-weight: 600; padding: 0 0.4rem; }
  .tag { font-size: 0.65rem; font-weight: 700; padding: 0.1rem 0.4rem; border-radius: 4px; color: #fff; }
  .tag.swarm { background: var(--swarm); }
  .tag.arkiv { background: var(--arkiv); }
  #timeline { list-style: none; padding: 0; margin: 0; font-size: 0.9rem; }
  #timeline li { padding: 0.3rem 0; border-bottom: 1px dashed #8883; }
  #timeline time { color: var(--muted); font-variant-numeric: tabular-nums; margin-right: 0.5rem; }
  .mono { font-family: ui-monospace, monospace; font-size: 0.8em; word-break: break-all; }
  .denied { color: var(--bad); font-weight: 600; }
  pre { background: #8881; padding: 0.6rem; border-radius: 6px; overflow-x: auto; font-size: 0.8rem; white-space: pre-wrap; word-break: break-all; }
  a { color: inherit; }
</style>
</head>
<body>

<header>
  <h1>Hydra · Control Room</h1>
  <div id="head">Tiramisu block: —</div>
</header>
<div class="sub">Incident coordination on Arkiv &middot; incident reports encrypted on Swarm</div>

<button id="startBtn">Simulate rack failure in DC-1</button>
<span id="phase" class="mono"></span>

<div class="dcs" id="dcs"></div>

<fieldset>
  <legend>Incident timeline <span class="tag arkiv">ARKIV</span></legend>
  <ul id="timeline"></ul>
</fieldset>

<fieldset>
  <legend>Incident report <span class="tag swarm">SWARM</span></legend>
  <div id="reportRef" class="mono">No incident filed yet.</div>
  <div style="margin-top: 0.6rem">
    <button id="openSol" disabled>Open as Sol (on the roster)</button>
    <button id="openOutsider" disabled>Open as an outsider</button>
  </div>
  <div id="reportOut"></div>
</fieldset>

<script>
const $ = (id) => document.getElementById(id)
const EXPLORER = 'https://tiramisu.explorer.arkiv.network'
const SWARM_GATEWAY = 'https://api.gateway.ethswarm.org'
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const url = (s) => esc(encodeURIComponent(String(s ?? '')))
const AGENTS = ['atlas', 'nova', 'sol']
const FAILED_SLOT = 4

let state = null

function dotClass(status) {
  if (status === 'dead' || status === 'error') return 'dead'
  if (status === 'working' || status === 'claiming') return 'busy'
  if (status === 'idle') return ''
  return 'live'
}

function render() {
  if (!state) return
  $('phase').textContent = state.tag ? ` ${state.tag} · ${state.phase}` : ''

  $('dcs').innerHTML = AGENTS.map((id) => {
    const a = state.agents[id]
    const rackFailed = id === 'atlas' && state.phase === 'running'
    const slots = Array.from({ length: 8 }, (_, i) => `<span class="${rackFailed && i === FAILED_SLOT ? 'failed' : ''}"></span>`).join('')
    const canKill = a.alive && state.phase === 'running'
    return `<div class="dc${a.alive ? '' : ' down'}">
      <h2>${esc(a.dc)}</h2>
      <div class="rack">${slots}</div>
      <div class="agent"><span class="dot ${dotClass(a.status)}"></span><b>${esc(id)}</b> · ${esc(a.status)}</div>
      <button data-kill="${esc(id)}" ${canKill ? '' : 'disabled'}>Cut power</button>
    </div>`
  }).join('')

  $('timeline').innerHTML = state.timeline.map((e) =>
    `<li><time>${esc(new Date(e.at).toLocaleTimeString())}</time><b>${esc(e.agentId)}</b> ${esc(e.text)}</li>`
  ).join('')

  if (state.report) {
    $('reportRef').innerHTML =
      `Swarm ref <a target="_blank" href="${SWARM_GATEWAY}/chunks/${url(state.report.swarmRef)}">${esc(state.report.swarmRef)}</a><br>` +
      `Arkiv entity <a target="_blank" href="${EXPLORER}/entity/${url(state.report.entityKey)}">${esc(state.report.entityKey)}</a>`
    $('openSol').disabled = false
    $('openOutsider').disabled = false
  } else {
    $('reportRef').textContent = 'No incident filed yet.'
    $('openSol').disabled = true
    $('openOutsider').disabled = true
  }
}

async function post(path) {
  const res = await fetch(path, { method: 'POST' })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || res.statusText)
  state = data.state
  render()
}

$('startBtn').onclick = async () => {
  $('startBtn').disabled = true
  $('reportOut').textContent = ''
  try {
    await post('/api/demo/start')
  } catch (e) {
    alert(`start failed: ${e.message}`)
  } finally {
    $('startBtn').disabled = false
  }
}

$('dcs').onclick = async (ev) => {
  const id = ev.target.dataset?.kill
  if (!id) return
  try {
    await post(`/api/demo/kill/${encodeURIComponent(id)}`)
  } catch (e) {
    alert(`cut power failed: ${e.message}`)
  }
}

async function openReport(as) {
  $('reportOut').textContent = 'downloading from Swarm…'
  try {
    const res = await fetch(`/api/demo/report?as=${encodeURIComponent(as)}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || res.statusText)
    if (data.ok) {
      $('reportOut').innerHTML = `<p>Decrypted with <b>${esc(data.as)}</b>'s key (${esc(data.bytes)} bytes from Swarm):</p><pre>${esc(JSON.stringify(data.report, null, 2))}</pre>`
    } else {
      $('reportOut').innerHTML = `<p class="denied">${esc(data.error)}</p><p>What the gateway or anyone else sees (${esc(data.bytes)} bytes):</p><pre>${esc(data.ciphertextPreview)}…</pre>`
    }
  } catch (e) {
    $('reportOut').textContent = `FAILED: ${e.message}`
  }
}
$('openSol').onclick = () => openReport('sol')
$('openOutsider').onclick = () => openReport('outsider')

async function loadState() {
  try {
    state = await (await fetch('/api/demo/state')).json()
    render()
  } catch {}
}

async function pollHead() {
  try {
    const res = await fetch('/api/head')
    if (!res.ok) throw new Error(`/api/head → ${res.status}`)
    const { head } = await res.json()
    $('head').textContent = `Tiramisu block: ${head}`
  } catch (e) {
    $('head').textContent = `Tiramisu block: unreachable (${e.message})`
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/live`)
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.type !== 'demo') return
    state = msg.state
    render()
  }
  ws.onclose = () => setTimeout(() => { loadState(); connect() }, 2000)
}

loadState()
pollHead()
setInterval(pollHead, 2000)
connect()
</script>
</body>
</html>
```

- [ ] **Step 2: Walk through the full demo in a browser**

Run `npm start`, open `http://localhost:3000/control.html`, and do exactly the video script. Note the wall-clock time of each transition.

1. Click **Simulate rack failure in DC-1**. Expected: DC-1 rack shows one red slot; timeline shows Atlas "stopped responding" then "filed the incident"; the Swarm ref and Arkiv entity links appear.
2. Click **Cut power** on DC-1. Expected: DC-1 card greys out, Atlas `dead`.
3. Wait for Nova `working` and a `step 1/3` line. Click **Cut power** on DC-2. Expected: DC-2 greys out; Sol shows `waiting`.
4. Wait. Expected: Sol `claiming` → timeline "claimed the incident on Arkiv" → "found 1/3 steps already done on Swarm, resuming" → `step 2/3`, `step 3/3` → "incident resolved"; phase `resolved`; the DC-1 rack slot turns green.
5. Click **Open as Sol**. Expected: the incident report JSON (rack R12, IPMI host, affected customers).
6. Click **Open as an outsider**. Expected: red "Not on this incident's roster: cannot decrypt." and a hex preview.
7. Click the Arkiv entity link and the Swarm ref link. Both should open.
8. Click **Simulate rack failure in DC-1** again. Expected: a fresh run with all three agents back alive (retake path).

Also check at ~400 px browser width that the three cards stack and nothing scrolls sideways.

- [ ] **Step 3: Tune timing only if needed**

If step 4 (Nova killed → Sol claims) takes over 60 s, lower `CLAIM_LEASE_BLOCKS` in `src/protocol.mjs` from 12 to 8 and rerun `npm run verify:renew-stop`, `npm run verify:demo-controller` and the walk-through. If Sol ever claims before Nova in step 3, raise `startDelayMs.sol` in `src/demo.mjs`. Change nothing if the walk-through was fine.

- [ ] **Step 4: Commit**

```bash
git add public/control.html src/protocol.mjs src/demo.mjs
git commit -m "feat: add control room page for the data-center takeover demo"
```

(Only include `src/protocol.mjs` / `src/demo.mjs` if Step 3 changed them.)

---

## Video script (for recording, not a task)

1. Open `/control.html`. "Three data centers, one watchdog agent each."
2. Simulate the rack failure. "Atlas files it: searchable index on Arkiv, encrypted details on Swarm."
3. Cut DC-1. "Atlas is gone; the incident isn't, because it never lived in DC-1."
4. Nova claims and completes step 1. Cut DC-2. "Nothing deletes Nova's claim. It just expires."
5. Sol takes over and resumes at step 2. "It doesn't redo step 1: it read Nova's progress from Swarm."
6. Open as Sol vs. outsider. "Same bytes on Swarm. Only agents on the roster can read them."
