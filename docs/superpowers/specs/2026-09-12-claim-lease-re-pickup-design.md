# Claim leases and re-pickup

Three agents with separate wallets, a short-lived claim renewed while work is in progress, and a
takeover path for work whose claim has lapsed.

## Problem

The repo has one concept: an `agent_memory` entity with `agent_id`, `memory_type`, `tag`,
`importance`, `swarm_ref`. A "claim" is a memory whose `memory_type` happens to be `task`. Nothing
makes a claim exclusive, nothing releases one, and nothing picks work back up. Both agents also
sign with the same wallet, so `agent_id` is a string rather than an identity.

## Entity roles

All three are ordinary `agent_memory` entities. The role is carried by `memory_type` + `tag`.

| Role | `memory_type` | `tag` | TTL | Written by |
|---|---|---|---|---|
| incident | `event` | `incident-<id>` | 600 blocks | the reporting agent |
| claim | `task` | `claim-incident-<id>` | 8 blocks, renewed | the working agent |
| done | `event` | `done-incident-<id>` | 600 blocks | the finishing agent |

The asymmetry is the point: claims clean themselves up, completions persist. Expiry is the
default and survival is what costs effort.

## Pickup protocol

Ordering is the feature. An agent wanting to work on `<id>`:

1. Query `done-incident-<id>`. Present → stop, the work is already finished.
2. Query live `claim-incident-<id>`. Present → stop, another agent holds it.
3. Otherwise write a claim with an 8-block TTL and begin work.

While working, `extendEntity` on its own claim every ~3 blocks. On finishing, write the `done`
record **first**, then `deleteEntity` the claim. That order matters: a crash between the two
leaves the claim to lapse on its own while the `done` record still prevents repeated work.

### Renewal ratio

Renew at roughly one third of the lease. An 8-block lease (~16s at Tiramisu's ~2s blocks) renewed
every 3 blocks tolerates two consecutive failed renewals before lapsing. Renewing at the full
lease length makes every renewal a photo finish, and a single slow RPC drops a lease that is
actively being worked.

## The lapse signal

Arkiv emits five events: `EntityCreated`, `EntityPatched`, `ExpiryExtended`,
`OwnershipTransferred`, `EntityDeleted`. **There is no expiry event** — expiry is passive, no
transaction happens at the expiry block, and the engine simply stops answering for that key.

A lapse is therefore derived, not observed:

- `EntityCreated` carries `expiresAt`, so a claim's death block is known when it appears
- `ExpiryExtended` carries the new `expiresAt` on every renewal
- `EntityDeleted` fires on early release

The watcher holds `{entityKey → expiresAt}` for live claims, compares against head, and emits
`claim lapsed` itself when head passes an expiry with no renewal. The chain never announces the
broken lease; the watcher notices the silence.

## Identity

Three funded wallets, one per agent: `ARKIV_PRIVATE_KEY` (atlas), `ARKIV_PRIVATE_KEY_NOVA`,
`ARKIV_PRIVATE_KEY_SOL`. `makeClients` is built per agent and the server selects the signer by
`agentId`. Separate signers are what make "the only thing connecting them is the public index"
true, and they give each agent its own nonce sequence.

Verified live on Tiramisu: the engine gates both `deleteEntity` and `extendEntity` on ownership.
A non-owner is rejected with

```
entity 0xdb4b65ff…016832 is owned by 0x9F5997…86C1, not 0xEE82A6…6fb2
```

so no agent can release or extend another's claim, and only the holder can renew its own. This is
why expiry has to do the cleanup: an abandoned claim cannot be cleared by anyone else, so lapsing
is the only mechanism that frees the work.

Measured cost, same transaction: **0.000105 GLM per `createEntity`** at 1 gwei. The 0.08 GLM
funded to each agent wallet is roughly 760 writes.

## Known limitation: the claim race

Query-then-write is not atomic, and Arkiv has no compare-and-set, so two agents can both write a
claim for the same incident:

```
block 1000   the incumbent claim expires (passively, no tx, no event)
block 1001   agent C queries for a live claim -> none
block 1001   agent D queries for a live claim -> none
block 1002   both claim transactions land; both agents believe they hold the lease
```

The window is one block plus RPC latency, between the index reporting the claim free and the new
claim landing. Its realistic trigger is a thundering herd on takeover: several idle agents all
watching for lapsed work and noticing the same lapse at the same moment.

**This is deliberately not fixed.** The lease is advisory, not exclusive — the same guarantee
etcd gives without fencing tokens. Every agent here is invoked as a one-shot command, so only one
actor ever writes a claim and the race is unreachable.

### How to fix it, if a herd ever becomes real

Deterministic tie-break, roughly 20 lines and no new primitive:

1. Write the claim as normal.
2. Re-query all live claims for that incident.
3. The winner is the one with the lowest `entityKey`, a rule every agent applies identically.
4. An agent that is not the winner abandons its claim and backs off.

This resolves genuine same-block collisions without CAS because the resolution is a pure function
of on-chain state. It does not close the zombie-worker case below.

### What stays unsolved either way

An agent that goes slow rather than dying has its lease lapse while it is still working, and the
takeover agent then works in parallel with it. Real systems solve this with fencing tokens, where
the resource rejects writes carrying a stale lease generation. There is no such resource here, so
the honest description is an advisory lease.

## Surface

- `src/claims.mjs` — the protocol: `tryClaim`, `renewClaim`, `completeClaim`, `findUnclaimed`
- `src/arkiv.mjs` — `extendMemory`, `deleteMemory`, claim/done queries, per-agent clients
- `src/app.mjs` — `POST /api/claim`, `POST /api/claim/renew`, `POST /api/claim/complete`
- `server.mjs` — the lapse watcher
- `scripts/agent-chat.mjs` — `claim`, `renew`, `complete` tools; three agent ids
- `scripts/takeover.mjs` — one-shot: find an incident with no `done` and no live claim, take it
- `public/index.html` — third agent, renewal and lapse lines in the event log

## Testing

- `tryClaim` returns `blocked` when a live claim exists, `done` when a completion record exists,
  `held` otherwise — exercised against a local fake before any live transaction
- ordering: a `done` record beats a live claim beats an empty index
- the lapse watcher fires exactly once per claim, and not at all when renewals keep arriving
- live: one claim written, renewed twice, then abandoned; `scripts/takeover.mjs` picks it up
