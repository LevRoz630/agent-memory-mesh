# Arkiv feedback — Hydra

Environment: `@arkiv-network/sdk@0.8.1`, `viem@2.56.3`, Node v22.23.2, chain Tiramisu
`7738577` (`0x7614d1`).

Every item below is a reproduced fact, run live against Tiramisu through this repo's own
code.

Each finding has a runnable script that reproduces it against the live network and prints
the observed values. Run one, or all of them:

```
npm run feedback:repro           # every finding
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

Rendering a query result without unwrapping yields `[object Object]` 

Entity `0x44ca5eda9b5bdabecca4472dd37deeeebbedcf213cf65cc01d441f48dfabc63c`, tx
`0x613d7c9850e9efd681354c2656b14850d4a945c8716b58cd904ab8f528cfa441`. Unwrapped centrally in
`src/arkiv.mjs` (`unwrapAttributes`).

The shape appears in `getEntity`'s JSDoc example
(`src/clients/decorators/arkivPublic.ts:66`) but not in `createEntity`'s, so the asymmetry is
discoverable only from the read side.

Reproduce: `arkiv-feedback/repro/01-attribute-wrapper-shape.mjs`

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

Reproduce: `arkiv-feedback/repro/02-name-vs-value-validation.mjs`

---

## 3. `privateKeyToAccount` needs an explicit nonce manager for concurrent writes

```js
Promise.allSettled(Array.from({ length: 6 }, () => wallet.createEntity(...)))
```

| Account built with                             | Result                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `privateKeyToAccount(key)`                   | 1/6 fulfilled; 5×`EntityMutationError: Transaction failed: Execution error without revert data` |
| `privateKeyToAccount(key, { nonceManager })` | 6/6 fulfilled, 6 distinct entity keys                                                              |

The error text names no nonce. Applied in `src/arkiv.mjs` (`makeClients`).

Request: default to a nonce manager in the quickstart's account setup, or state that
concurrent writes from one signer require one.

Reproduce: `arkiv-feedback/repro/03-nonce-manager.mjs` (runs both arms, 12 transactions)

---

## 4. `getEntity` returns a byte-identical error for never-created and expired entities

```js
await pub.getEntity('0x' + 'ab'.repeat(32))   // never created
await pub.getEntity(expiredKey)               // created, read, then left to expire
// both: NoEntityFoundError: No live entity with key 0x….
//       It was never created, or it has been deleted or has expired.
```

A malformed key does differ: `InvalidValueError: Invalid key value "0xdead": 2 bytes, not exactly 32 bytes.`

Expired entity `0x6a9bf0cc…`. Distinguishing "expired" from "unknown key" in a UI requires
caching the expiry height at write time.

Reproduce: `arkiv-feedback/repro/04-not-found-ambiguity.mjs` (writes a short TTL, waits past it)

---

## 5. `watchEntityEvents` silently polls unless it gets a websocket and no `fromBlock`

The same call either subscribes or polls, decided by viem's `watchEvent` from the transport and
options, and the watcher gives no sign which one it chose. Ten seconds of each, counting the
requests the transport sees:

| Client / options                                   | Calls in 10 s                                              |
| -------------------------------------------------- | ---------------------------------------------------------- |
| `http()` (the transport in the JSDoc example)      | `eth_newFilter` 1, `eth_blockNumber` 3, `eth_getLogs` 2     |
| `webSocket()`                                      | `eth_subscribe(logs)` 1, nothing else                      |
| `webSocket()` with `fromBlock: head - 5n`          | `eth_newFilter` 1, `eth_blockNumber` 3, `eth_getLogs` 3     |

The docs point the wrong way: `pollingInterval` is documented as "How often to poll … Defaults to
half a block" with no mention that it's ignored over a websocket, and `fromBlock` ("Replay from this
block before following the head") doesn't say it turns following the head into polling too. An app
built to react "from the stream without polling" can pass review while it polls.

Request: say in the JSDoc which transports subscribe, use `webSocket()` in the example, and note that
`fromBlock` forces polling (or replay with `eth_getLogs` and then subscribe).

Hydra's control room subscribes over `webSocket()` without `fromBlock` (`src/arkiv.mjs`
`makeStreamClient`, `src/chain-watch.mjs`).

Reproduce: `arkiv-feedback/repro/05-watch-silently-polls.mjs` (read-only, no transactions)
