# Arkiv friction report — Hydra

Four issues hit while building Hydra's claim-takeover protocol on `@arkiv-network/sdk@0.8.1`
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

Reproduce: `scripts/feedback/01-attribute-wrapper-shape.mjs`

## 2. Attribute-name validation is client-permissive, engine-strict, and self-contradictory

`isValidAttributeName('AGENT')` returns `true` client-side; the engine rejects it on-chain. The
engine's own rejection message lists `"A"-"Z"` as a permitted character range while rejecting
`"A"` (0x41) in the same breath. snake_case names (`agent_id`, not `agentId`) are the only safe
choice, and nothing catches the mismatch before an on-chain transaction is spent finding out.

Reproduce: `scripts/feedback/02-name-vs-value-validation.mjs`

## 3. Concurrent writes from one signer need an explicit nonce manager

Six concurrent `createEntity` calls from a single wallet: 1 of 6 land without viem's
`nonceManager`, 6 of 6 with it — and the error text for the failing five never mentions "nonce",
so the actual cause is invisible from the error alone. This is the finding most likely to bite
another team building any multi-write agent workflow, and it's why Hydra gives each of its three
agents (atlas/nova/sol) its own signer with its own nonce sequence rather than sharing one wallet.

Reproduce: `scripts/feedback/03-nonce-manager.mjs`

## 4. A never-created entity and an expired one return the identical error

`getEntity` on a key that was never written and a key whose entity already expired both return
the same "not found"-shaped error, byte-for-byte. A caller has no way to distinguish "nothing
was ever here" from "something was here and lapsed" without independently tracking expiry —
which is exactly the ambiguity Hydra's claim-lease protocol has to design around (via `lane` rows
as a separate, long-lived provenance record, since the claim entity itself gives no history once
it's gone).

Reproduce: `scripts/feedback/04-not-found-ambiguity.mjs`
