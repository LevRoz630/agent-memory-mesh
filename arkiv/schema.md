# Arkiv schema — Hydra

One entity type, `agent_memory`, used for every row Hydra writes. The role a row plays is carried
entirely in its attributes — there is no separate on-chain type per role. Full design rationale:
`docs/ARCHITECTURE.md` §3 and §7.

## Attributes

| Attribute       | Type  | Values                                                              |
| --------------- | ----- | -------------------------------------------------------------------- |
| `app`         | `str` | `hydra` — constant; lets the whole index be selected with one `eq`  |
| `agent_id`    | `str` | `atlas` \| `nova` \| `sol`                                        |
| `memory_type` | `str` | `event` \| `claim` \| `lane` \| `done` \| `verdict` \| `heartbeat` — whitelisted client-side, nothing else accepted |
| `tag`         | `str` | `incident-<id>` for the first five roles; `agent-<id>` for a `heartbeat`; `outage-<id>` for an `event` row a peer filed about a lapsed heartbeat |
| `importance`  | `u64` | 0–10, supports `gte` filtering                                     |
| `swarm_ref`   | `str` | 64-hex Swarm chunk address; every row has one, even `claim`         |
| `outcome`     | `str` | `fixed` \| `reopened` — present only on `verdict` rows              |

Names are snake_case only — the engine's charset silently differs from what its client-side
validator accepts (see `friction.md` finding 2).

## The six roles

| Role      | `memory_type` | TTL                              | Written by                        |
| --------- | --------------- | --------------------------------- | ---------------------------------- |
| incident  | `event`       | 600 blocks                      | whichever agent reports it — either the one that noticed an external signal, or a peer filing an outage it detected |
| claim     | `claim`       | 12 blocks, renewed while working | the working agent                  |
| lane      | `lane`        | 600 blocks                      | each agent, once, on first Swarm write |
| done      | `done`        | 600 blocks                      | the finishing agent                |
| verdict   | `verdict`     | 600 blocks                      | whichever agent's watch loop notices the `done` row and checks the fix |
| heartbeat | `heartbeat`   | 8 blocks, renewed every ~1/3 of that | each agent, about itself, on `tag: agent-<id>` |

Claims and heartbeats are the only types designed to expire and stay gone — everything else
persists so an incident's full history survives even after every claim on it has lapsed.

A heartbeat lapsing is what lets a peer detect that an agent is down at all: any agent can poll
`and(eq(app,'hydra'), eq(tag,'agent-<id>'), eq(memory_type,'heartbeat'))` for each of its peers,
and file an `event` row on `tag: outage-<id>` once that peer's heartbeat has been missing for two
consecutive polls (one miss is treated as ordinary chain-index lag after a write, not a lapse).

## Queries

Every query composes `eq`/`gte`/`startsWith` under `and` — Arkiv rejects a predicate-free query,
so "everything" is `eq(app, 'hydra')` rather than an unfiltered scan.

- **Is anyone alive on this incident?** `and(eq(app,'hydra'), eq(tag,'incident-42'), eq(memory_type,'claim'))` — zero rows means free to take; one row means its owner holds it, provably (owner-gated by the engine, not by convention).
- **Who has ever worked it, and what did they produce?** `and(eq(app,'hydra'), eq(tag,'incident-42'), eq(memory_type,'lane'))` for the *who*; each owner's Swarm lane (topic `hash('hydra/incident-42')`) for the *what*.
- **Has it been checked?** `and(eq(app,'hydra'), eq(tag,'incident-42'), eq(memory_type,'verdict'))`.
- **Is a given peer still alive?** `and(eq(app,'hydra'), eq(tag,'agent-nova'), eq(memory_type,'heartbeat'))` — zero rows on two consecutive polls means that agent is down.

## Expiry as the mechanism, not a cleanup job

`ExpirationTime.fromBlocks(n)` is exact — no transaction happens at the expiry block, and there
is no expiry event. A watcher holds `{entityKey → expiresAt}` from `EntityCreated`, updates it on
`ExpiryExtended`, drops it on `EntityDeleted`, and infers a lapse by comparing against head. Claims
use this deliberately: a crashed worker's claim needs nothing to act on it — it just stops
answering for that key. See `docs/ARCHITECTURE.md` §7 "The lapse is derived, never announced".
