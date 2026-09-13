# Arkiv schema — Hydra

One entity type, `agent_memory`, used for every row Hydra writes. The role a row plays is carried
entirely in its attributes — there is no separate on-chain type per role. Full design rationale:
`docs/ARCHITECTURE.md` §2 and §4.

## Attributes

| Attribute       | Type  | Values                                                              |
| --------------- | ----- | -------------------------------------------------------------------- |
| `app`         | `str` | `hydra` — constant; lets the whole index be selected with one `eq`  |
| `agent_id`    | `str` | `atlas` \| `nova` \| `sol`                                        |
| `memory_type` | `str` | `event` \| `claim` \| `lane` \| `done` \| `verdict` \| `heartbeat` — whitelisted client-side, nothing else accepted |
| `tag`         | `str` | `incident-<run>` for atlas's rack incident; `outage-<agent>-<run>-<n>` for an outage a peer filed about a lapsed heartbeat (both shared by the first five roles); `agent-<agent>` for a `heartbeat` |
| `importance`  | `u64` | 0–10                                                               |
| `swarm_ref`   | `str` | 64-hex Swarm chunk address; every row has one, even `claim`         |
| `outcome`     | `str` | `fixed` \| `reopened` — present only on `verdict` rows              |

Names are snake_case only — the engine's charset silently differs from what its client-side
validator accepts (see `arkiv-feedback/friction.md` finding 2).

## The six roles

| Role      | `memory_type` | TTL                              | Written by                        |
| --------- | --------------- | --------------------------------- | ---------------------------------- |
| incident  | `event`       | 600 blocks                      | whichever agent reports it — either the one that noticed an external signal, or a peer filing an outage it detected |
| claim     | `claim`       | 24 blocks, renewed every 4 while working | the working agent          |
| lane      | `lane`        | 600 blocks                      | each agent, once per incident, the first time it wins the claim |
| done      | `done`        | 600 blocks                      | the finishing agent                |
| verdict   | `verdict`     | 600 blocks                      | whichever agent's verify loop notices the `done` row first — never the finisher (`verify()` checks the `done` row's owner) |
| heartbeat | `heartbeat`   | 16 blocks, renewed every 2 | each agent, about itself, on `tag: agent-<id>` |

Claims and heartbeats are the only types designed to expire and stay gone — everything else
persists so an incident's full history survives even after every claim on it has lapsed.

A heartbeat lapsing is what lets a peer detect that an agent is down at all: any agent can poll
`and(eq(app,'hydra'), eq(tag,'agent-<id>'), eq(memory_type,'heartbeat'))` for each of its peers,
and file an `event` row on `tag: outage-<agent>-<run>-<n>` once that peer's heartbeat has been
missing for two consecutive polls (one miss is treated as ordinary chain-index lag after a write, not
a lapse). `<run>` keeps an earlier run's rows from standing in for this one's; `<n>` counts that peer's outages
in the run that already have a `done` row, so watchers converge on one tag and a second death is a
new incident.

The same query guards a takeover: before claiming, an agent checks the heartbeat of every agent with
a `lane` row on the incident. A live one is slow, not dead, and keeps the right to resume.

## Queries

Every query composes `eq`/`startsWith` under `and` — Arkiv rejects a predicate-free query,
so "everything" is `eq(app, 'hydra')` rather than an unfiltered scan.

- **Is anyone alive on this incident?** `and(eq(app,'hydra'), eq(tag,'incident-42'), eq(memory_type,'claim'))` — zero rows means free to take; one row means its owner holds it, provably (owner-gated by the engine, not by convention).
- **Who has ever worked it, and what did they produce?** `and(eq(app,'hydra'), eq(tag,'incident-42'), eq(memory_type,'lane'))` for the *who*; each owner's Swarm lane (topic `hash('hydra/incident-42')`) for the *what*.
- **Has it been checked?** `and(eq(app,'hydra'), eq(tag,'incident-42'), eq(memory_type,'verdict'))`.
- **Which outage number is next for a peer in this run?** `and(eq(app,'hydra'), startsWith(tag,'outage-nova-<run>-'), eq(memory_type,'done'))` — the count of distinct tags.
- **Is a given peer still alive?** `and(eq(app,'hydra'), eq(tag,'agent-nova'), eq(memory_type,'heartbeat'))` — zero rows on two consecutive polls means that agent is down.

## Expiry as the mechanism, not a cleanup job

`ExpirationTime.fromBlocks(n)` is exact — no transaction happens at the expiry block, and there
is no expiry event; the row just stops showing up in queries. Claims
use this deliberately: a crashed worker's claim needs nothing to act on it — it just stops
answering for that key. See `docs/ARCHITECTURE.md` §2 "Expiry".
