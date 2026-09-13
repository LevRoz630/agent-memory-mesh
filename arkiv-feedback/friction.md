# Arkiv friction report — Hydra

Six issues hit while building Hydra's claim-takeover protocol on `@arkiv-network/sdk@0.8.1`
against Tiramisu. Each is reproduced live, with a runnable script — see `feedback.md` for the
full write-up, repro output, and exact entity keys/tx hashes. This file is the short version.

```
npm run feedback:repro           # reproduce every finding
npm run feedback:repro -- 03     # just one
```

## 1. Read/write shape asymmetry for attributes

`createEntity` takes bare constructors (`str('atlas')`); `getEntity`/queries hand back typed
wrapper objects (`{ type: 'str', value: 'atlas' }`). Rendering a query result without unwrapping
first silently prints `[object Object]` — no error, no warning. Discoverable only from the read
side; `createEntity`'s own JSDoc never mentions it. We unwrap centrally in `src/arkiv.mjs`
(`unwrapAttributes`) so nothing downstream has to know.

Reproduce: `arkiv-feedback/repro/01-attribute-wrapper-shape.mjs`

## 2. Attribute-name validation is client-permissive, engine-strict, and self-contradictory

`isValidAttributeName('AGENT')` returns `true` client-side; the engine rejects it on-chain. The
engine's own rejection message lists `"A"-"Z"` as a permitted character range while rejecting
`"A"` (0x41) in the same breath. snake_case names (`agent_id`, not `agentId`) are the only safe
choice, and nothing catches the mismatch before an on-chain transaction is spent finding out.

Reproduce: `arkiv-feedback/repro/02-name-vs-value-validation.mjs`

## 3. Concurrent writes from one signer need an explicit nonce manager

Six concurrent `createEntity` calls from a single wallet: 1 of 6 land without viem's
`nonceManager`, 6 of 6 with it — and the error text for the failing five never mentions "nonce",
so the actual cause is invisible from the error alone. This is the finding most likely to bite
another team building any multi-write agent workflow, and it's why Hydra gives each of its three
agents (atlas/nova/sol) its own signer with its own nonce sequence rather than sharing one wallet.

Reproduce: `arkiv-feedback/repro/03-nonce-manager.mjs`

## 4. A never-created entity and an expired one return the identical error

`getEntity` on a key that was never written and a key whose entity already expired both return
the same "not found"-shaped error, byte-for-byte. A caller has no way to distinguish "nothing
was ever here" from "something was here and lapsed" without independently tracking expiry —
which is exactly the ambiguity Hydra's claim-lease protocol has to design around (via `lane` rows
as a separate, long-lived provenance record, since the claim entity itself gives no history once
it's gone).

Reproduce: `arkiv-feedback/repro/04-not-found-ambiguity.mjs`

## 5. `watchEntityEvents` silently polls unless it gets a websocket and no `fromBlock`

Over `http()`, the transport in its own JSDoc example, the watcher polls `eth_getLogs`. Over
`webSocket()` it holds one `eth_subscribe(logs)`. Pass `fromBlock` on a websocket and it's back to
polling. Nothing in the return value or the docs says which you got, and `pollingInterval` is
documented as if it always applies. We only caught it by counting RPC calls.

Reproduce: `arkiv-feedback/repro/05-watch-silently-polls.mjs`

## 6. With `nonceManager`, one write that fails gas estimation freezes the wallet

The nonce is taken before gas is estimated and isn't given back when the estimate reverts, which is
routine when renewing a lease that just lapsed. Every later write from the wallet waits in the mempool
behind the gap, with no error and no timeout. For Hydra that stalled heartbeats for 20–80 s and made
peers declare live agents dead. We now count nonces per wallet ourselves.

Reproduce: `arkiv-feedback/repro/06-nonce-gap-freezes-wallet.mjs`
