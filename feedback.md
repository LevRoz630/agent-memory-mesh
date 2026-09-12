# Arkiv feedback — Agent Memory Mesh

Written live during the build, not reconstructed afterward. Covers only surfaces used:
SDK, MCP/tools. Every finding below is reproducible against this repo's code.

Environment: `@arkiv-network/sdk@0.8.0`, `viem@2.56.3`, Node v22.23.2, chain Tiramisu
`7738577` (`0x7614d1`).

---

## 1. `getEntity`/`select` return attribute values as typed wrapper objects — asymmetric with the write path

**Reporter: agent observation, reproduced.**

Writing an attribute takes a tagged constructor: `str('atlas')`, `u64(7n)`. Reading it back
does **not** hand back the plain value the constructor took — it hands back
`{ type: 'str', value: 'atlas' }` / `{ type: 'u64', value: 7n }`.

```js
const found = await pub.select('*').where(eq('agent_id', str('atlas'))).fetch()
found[0].attributes
// { agent_id: { type: 'str', value: 'atlas' }, importance: { type: 'u64', value: 7n }, ... }
```

**Expected:** either the read path hands back plain values symmetric with what the write
path took, or (if the type tag is intentional, e.g. for disambiguating numeric types) the
docs say so. Neither the SDK's JSDoc on `createEntity`'s `attributes` field nor the
shipped test files we found earlier mention this asymmetry.

**Impact:** first attempt at rendering a query result silently produced `[object Object]`
everywhere a value was expected — no error, no type mismatch, just wrong-looking output
that took a live print-and-inspect to diagnose.

**Workaround:** unwrap once, centrally — `unwrapAttributes()` in `src/arkiv.mjs`.

Reproduce: `node --env-file=.env -e "import('./src/arkiv.mjs').then(...)"`, query any
written entity, inspect `.attributes` before unwrapping.

**Sharper under live stress-testing:** `str`/`u64` *value* constructors validate hard,
client-side, before any RPC call — a negative `u64`, a non-integer numeric, a 129-byte
`str`, a control character in a `str`, all rejected up front with an accurate, actionable
message. Attribute *names* get none of that rigor (camelCase silently passes the client
validator, above, and only fails on-chain). Same SDK, two different validation rigor
levels depending on whether the check is on a name or a value.

---

## 4. No nonce manager on the account returned by `privateKeyToAccount` — concurrent writes from one wallet fail 5/6 of the time

**Reporter: agent observation, reproduced twice (failing, then fixed).**

Firing several `createEntity` calls concurrently from the same wallet — two agents writing
near-simultaneously, or a double-clicked submit button — sends them all with the same
nonce unless the account was built with a nonce manager. Six concurrent `createMemory()`
calls against live Tiramisu: 1 landed, 5 failed with `Execution error without revert
data`, an error message that gives no hint it's a nonce collision.

**Fix confirmed:** `privateKeyToAccount(privateKey, { nonceManager })` (viem's own
`viem/nonce` export) took the identical test to 6/6 fulfilled, 6 distinct entity keys.
Applied in this repo's `src/arkiv.mjs`.

**Suggested fix:** either Arkiv's own account-creation guidance defaults to a nonce
manager, or the docs call out explicitly that concurrent writes from one signer need one —
nothing in the quickstart flags this until a demo silently drops writes.

Reproduce: fire N `wallet.createEntity(...)` calls with `Promise.all` from one account
built without `nonceManager`; watch most of them revert.

---

## 5. `getEntity` throws the identical error for "never existed" and "expired"

**Reporter: agent observation, reproduced.**

```
getEntity(neverExistedKey)      → NoEntityFoundError: No live entity with key 0x...
getEntity(realKeyPastItsExpiry) → NoEntityFoundError: No live entity with key 0x...
```
Same error class, same message shape — confirmed by writing an entity, reading it
successfully pre-expiry, waiting past its recorded `expiresAt` block, and reading again.

**Impact:** low here — `watchMemories`'s catch block already treats every `getEntity`
failure the same way, which happens to be correct for this app. But a UI that wanted to
show "this memory just expired" as a message distinct from "bad key" can't build that off
the SDK error alone; it would need to have cached the expiry height itself beforehand. A
malformed key (wrong byte length) does fail differently and clearly
(`InvalidValueError: ... not exactly 32 bytes`), so structurally-invalid is at least
distinguishable from structurally-valid-but-absent — just not "never existed" from
"expired."

---

## 2. The `arkiv-ethrome` MCP's `check_schema` entity-type heading pattern is unrecognized across every reasonable format tried

**Reporter: agent observation, reproduced.**

`check_schema` flags "No entity type heading was recognized" as a (non-blocking) warning.
Tried, in separate submissions, all rejected:

- `## Entity type: agent_memory`
- `## Entities` / `### agent_memory` with an inline `Type: agent_memory. Purpose: ...` line
- A markdown table under an `## Entities` heading

All three are reasonable, readable ways to state "this is an entity type and its purpose,"
and none tripped the recognizer. Other checks in the same tool do work — adding a
real query-builder code block moved `queryBuilderCalls` from 0 to 1 immediately, so the
checker is doing real pattern matching, just not on a documented (or guessable) pattern for
this one gate.

**Impact:** low — the tool itself says this is "a design suggestion, not an event
threshold," so no submission is blocked by it. But three failed attempts is real
wasted time for something whose intended format isn't discoverable from the tool's own
feedback.

**Suggested fix:** either document the exact expected heading pattern in the tool's
response (it already says what's missing, could also say what would satisfy it), or widen
the recognizer.

Reproduce: call `check_schema` with any of the three formats above; `entityTypeHeadings`
stays `0` in the `observed` block every time.

---

## 6. Confirmed correct, re-verified live in this session, not just in isolated smoke tests

These held up under actual product use, not just a standalone probe:

- **Attribute charset is real and strictly enforced.** Every attribute in this schema
  (`agent_id`, `memory_type`, `tag`, `importance`, `swarm_ref`) is snake_case by design,
  specifically because camelCase is silently accepted by the client and rejected on-chain
  (documented in this repo's `NOTES.md` before a single write was attempted, and every
  write since has gone through clean).
- **Compound queries work as documented.** `and(eq(...), eq(...), gte(...))` and
  `and(eq(...), startsWith(...))` both return correct live results against real written
  entities — not a synthetic probe, actual product queries.
- **`ExpirationTime.fromBlocks(n)` behaves exactly as its own JSDoc says**: exact, no
  rounding, and the receipt's `expiresAt` is confirmed to be a resolved absolute block
  height that can differ from the requested count (see `scripts/demo-expiry.mjs` and its
  recorded requested-vs-applied output).
- **Expiry-as-signal is real, watched live through this app**, not just polled once:
  the same compound query, run before and after the expiry boundary, returns a different
  row count with no `deleteEntity` call anywhere in the codebase. `scripts/demo-expiry.mjs`
  is the reproduction.
- **`watchEntityEvents` requires the `webSocket()` transport and no `fromBlock`**;
  confirmed by building the actual live feature on it (`src/arkiv.mjs`'s `watchMemories`,
  wired into `server.mjs`) rather than a standalone test — a real websocket push updates a
  real browser-facing feed with no polling loop anywhere in the server.
- **`onEntityCreated` carries no attributes or payload**, only `entityKey`/`owner`/
  `expiresAt` — confirmed against the SDK's own shipped source
  (`node_modules/@arkiv-network/sdk/src/actions/public/watchEntityEvents.ts`) before
  writing code against it, which avoided building the wrong thing rather than discovering
  it live.
- **The websocket transport recovers from a forced connection drop with zero app-side
  reconnect code.** Killed the underlying raw socket mid-session (not a clean unsubscribe)
  while a watcher was live; `onError` fired as expected, and a memory written immediately
  after arrived normally with no duplicate delivery and no missed event — viem's default
  reconnect handled it. Still untested: an outage long enough that the client misses blocks
  entirely; that gap stays honestly described as untested, not assumed fine.
