# Arkiv feedback — Agent Memory Mesh

Environment: `@arkiv-network/sdk@0.8.1`, `viem@2.56.3`, Node v22.23.2, chain Tiramisu
`7738577` (`0x7614d1`).

Every item below is a reproduced fact, run live against Tiramisu through this repo's own
code — not a developer opinion and not a standalone probe.

Each finding has a runnable script that reproduces it against the live network and prints
the observed values. Run one, or all of them:

```
npm run feedback:repro           # every finding, Arkiv and Swarm
npm run feedback:repro -- 03     # just finding 3
```

Each script exits 0 when its finding reproduced, 1 when it did not.

---

## 1. Read path returns typed wrapper objects; write path takes bare constructors

```js
await wallet.createEntity({ attributes: { agent_id: str('atlas'), importance: u64(7n) }, ... })
;(await pub.getEntity(key)).attributes
// { agent_id: { type: 'str', value: 'atlas' }, importance: { type: 'u64', value: 7n } }
```

Rendering a query result without unwrapping yields `[object Object]` — no error, no type
mismatch.

Entity `0x44ca5eda9b5bdabecca4472dd37deeeebbedcf213cf65cc01d441f48dfabc63c`, tx
`0x613d7c9850e9efd681354c2656b14850d4a945c8716b58cd904ab8f528cfa441`. Unwrapped centrally in
`src/arkiv.mjs` (`unwrapAttributes`).

The shape appears in `getEntity`'s JSDoc example
(`src/clients/decorators/arkivPublic.ts:66`) but not in `createEntity`'s, so the asymmetry is
discoverable only from the read side.

Reproduce: `scripts/feedback/01-attribute-wrapper-shape.mjs`

---

## 2. Attribute-name validation: client permissive, engine strict, message self-contradictory

```js
isValidAttributeName('agentId')  // true
isValidAttributeName('AGENT')    // true
// both rejected on-chain
```

The engine's rejection message lists the character it just rejected as permitted:

```
an attribute name holds "A" (0x41) at byte 0, which is outside the name charset
("A"-"Z", "a"-"z", "0"-"9", ".", "-" and "_", with a letter first)
```

Value constructors validate strictly by contrast, all client-side before any RPC call:
`u64(-3n)`, `u64(2n ** 70n)`, `str('a\nb')`, `str('a'.repeat(129))`. The 128-byte `str`
limit is UTF-8-correct — `'é'.repeat(64)` (128 B) passes, 65 fails.

This schema is snake_case throughout for that reason (`src/arkiv.mjs`).

Reproduce: `scripts/feedback/02-name-vs-value-validation.mjs`

---

## 3. `privateKeyToAccount` needs an explicit nonce manager for concurrent writes

```js
Promise.allSettled(Array.from({ length: 6 }, () => wallet.createEntity(...)))
```

| Account built with | Result |
|---|---|
| `privateKeyToAccount(key)` | 1/6 fulfilled; 5× `EntityMutationError: Transaction failed: Execution error without revert data` |
| `privateKeyToAccount(key, { nonceManager })` | 6/6 fulfilled, 6 distinct entity keys |

The error text names no nonce. Applied in `src/arkiv.mjs` (`makeClients`).

Request: default to a nonce manager in the quickstart's account setup, or state that
concurrent writes from one signer require one.

Reproduce: `scripts/feedback/03-nonce-manager.mjs` (runs both arms, 12 transactions)

---

## 4. `getEntity` returns a byte-identical error for never-created and expired entities

```js
await pub.getEntity('0x' + 'ab'.repeat(32))   // never created
await pub.getEntity(expiredKey)               // created, read, then left to expire
// both: NoEntityFoundError: No live entity with key 0x….
//       It was never created, or it has been deleted or has expired.
```

A malformed key does differ: `InvalidValueError: Invalid key value "0xdead": 2 bytes, not
exactly 32 bytes.`

Expired entity `0x6a9bf0cc…`. Distinguishing "expired" from "unknown key" in a UI requires
caching the expiry height at write time; `src/arkiv.mjs` (`watchMemories`) treats both as
skip.

Reproduce: `scripts/feedback/04-not-found-ambiguity.mjs` (writes a short TTL, waits past it)

---

## 5. `check_schema` recognizes no entity-type heading format

Nine distinct formats in one document, including:

```
## Entity type: agent_memory
## Entities  /  ### agent_memory
```

→ `observed.entityTypeHeadings === 0` in every case. `queryBuilderCalls` moves 0 → 1 when a
query-builder block is added, so other patterns in the same tool do match.

Non-blocking — the tool calls it a design suggestion. Request: name the satisfying pattern in
the response, or widen the recognizer.

---

## 6. Confirmed working

- **Compound queries.** `and(eq, eq, gte)` and `and(eq, startsWith)` both return correct rows
  (`src/arkiv.mjs`, `queryMemories`).
- **`ExpirationTime.fromBlocks(n)`.** Applied expiry is an absolute height resolved at
  inclusion and can exceed the requested count: head 346924 + 5 blocks → applied 346931.
- **Expiry as signal.** Same query across the boundary returns 1 row → 0 rows, with no
  `deleteEntity` call anywhere in the repo (`scripts/demo-expiry.mjs`).
- **`onEntityCreated` carries no attributes or payload.** Keys delivered: `blockNumber`,
  `creationFlags`, `entityKey`, `expiresAt`, `logIndex`, `owner`, `transactionHash`, `type`.
  Attribute-based filtering needs a follow-up `getEntity` (`src/arkiv.mjs`, `watchMemories`).
- **`webSocket()` transport with no `fromBlock`** gives a real subscription; `fromBlock` is
  forwarded to viem (`watchEntityEvents.ts:149`), which then polls. No `poll` flag is exposed.
- **Reconnect after a forced socket close.** Closing the raw socket mid-session fired
  `onError` twice (`The socket has been closed.`); the next write was delivered exactly once,
  no missed and no duplicate event, with no app-side reconnect code.
  Reproduce: `scripts/feedback/05-websocket-reconnect.mjs`

Untested: an outage long enough for the client to miss blocks entirely.

---

## 7. Swarm-side reproductions

Not Arkiv surfaces, listed so the scripts in `scripts/feedback/` are all accounted for.
Detail in `NOTES.md`, Component 2.

- `06-gateway-stores-ciphertext.mjs` — the gateway receives ciphertext only; stored bytes
  exceed plaintext by exactly 28 (12-byte IV + 16-byte GCM authTag).
- `07-encryption-defeats-dedup.mjs` — the raw gateway returns one reference for identical
  bytes; this app's per-call random IV means it never uploads identical bytes twice.
- `08-ref-length-landmine.mjs` — a `Swarm-Encrypt` reference is 128 chars, exactly
  `MAX_STRING_BYTES`; prefixing `0x` makes it 130 and `str()` rejects it.
- `09-fetch-timeout.mjs` — `AbortSignal.timeout` bounds both calls at 8s against a server
  that accepts and never responds; a bare `fetch()` against the same server is still pending
  at 24s.
