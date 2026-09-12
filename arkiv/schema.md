# Arkiv schema — Hydra

One entity type, `agent_memory`, used for every row Hydra writes. The role a row plays is carried
entirely in its attributes — there is no separate on-chain type per role. Full design rationale:
`docs/ARCHITECTURE.md` §3 and §7.

## Attributes

| Attribute       | Type  | Values                                                              |
| --------------- | ----- | -------------------------------------------------------------------- |
| `app`         | `str` | `hydra` — constant; lets the whole index be selected with one `eq`  |
| `agent_id`    | `str` | `atlas` \| `nova` \| `sol`                                        |
| `memory_type` | `str` | `event` \| `claim` \| `lane` \| `done` \| `verdict` — whitelisted client-side, nothing else accepted |
| `tag`         | `str` | `incident-<id>` — the thread key every row of one piece of work shares |
| `importance`  | `u64` | 0–10, supports `gte` filtering                                     |
| `swarm_ref`   | `str` | 64-hex Swarm chunk address; every row has one, even `claim`         |
| `outcome`     | `str` | `fixed` \| `reopened` — present only on `verdict` rows              |

Names are snake_case only — the engine's charset silently differs from what its client-side
validator accepts (see `friction.md` finding 2).

## The five roles

| Role     | `memory_type` | TTL                              | Written by                        |
| -------- | --------------- | --------------------------------- | ---------------------------------- |
| incident | `event`       | 600 blocks                      | the reporting agent (atlas)       |
| claim    | `claim`       | 12 blocks, renewed while working | the working agent                  |
| lane     | `lane`        | 600 blocks                      | each agent, once, on first Swarm write |
| done     | `done`        | 600 blocks                      | the finishing agent                |
| verdict  | `verdict`     | 600 blocks                      | the reporting agent, after checking |

Claims are the only type that's designed to expire and stay gone — everything else persists so
the incident's full history survives even after every claim on it has lapsed.

## Queries

Every query composes `eq`/`gte`/`startsWith` under `and` — Arkiv rejects a predicate-free query,
so "everything" is `eq(app, 'hydra')` rather than an unfiltered scan.

- **Is anyone alive on this incident?** `and(eq(app,'hydra'), eq(tag,'incident-42'), eq(memory_type,'claim'))` — zero rows means free to take; one row means its owner holds it, provably (owner-gated by the engine, not by convention).
- **Who has ever worked it, and what did they produce?** `and(eq(app,'hydra'), eq(tag,'incident-42'), eq(memory_type,'lane'))` for the *who*; each owner's Swarm lane (topic `hash('hydra/incident-42')`) for the *what*.
- **Has it been checked?** `and(eq(app,'hydra'), eq(tag,'incident-42'), eq(memory_type,'verdict'))`.

## Expiry as the mechanism, not a cleanup job

`ExpirationTime.fromBlocks(n)` is exact — no transaction happens at the expiry block, and there
is no expiry event. A watcher holds `{entityKey → expiresAt}` from `EntityCreated`, updates it on
`ExpiryExtended`, drops it on `EntityDeleted`, and infers a lapse by comparing against head. Claims
use this deliberately: a crashed worker's claim needs nothing to act on it — it just stops
answering for that key. See `docs/ARCHITECTURE.md` §7 "The lapse is derived, never announced".
