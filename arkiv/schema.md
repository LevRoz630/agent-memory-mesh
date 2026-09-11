# Arkiv schema — agent_memory

## Why Arkiv

An AI agent's memory needs to be findable by kind, topic and salience — not fetched by a
single id — and needs to genuinely disappear when it's no longer relevant, without a
cleanup job somewhere babysitting it. A Postgres table with a `WHERE expires_at > now()`
clause fakes the second half: the row is still there, still costs a read, still needs a
scheduled DELETE to actually go away. Arkiv's native entity expiry does the second half for
real — the row stops matching queries on its own, and a `deleteEntity` call never appears
in this codebase.

The trade-off this schema makes explicit: only the pointer and the filterable metadata go
on Arkiv. The memory's actual content is bulk, unstructured, and does not need a query
language — that lives on Swarm instead (see `docs/PRODUCT.md`, Component 2). Arkiv is the
index; it is not asked to be the database that holds everything.

## Entity type: agent_memory

One entity per memory. No sub-types, no separate entity per agent — `agent_id` is a
filterable attribute, not a partition key, because the actual product query is always
"this agent's memories of this kind," never "give me everything."

| Attribute | Type | Why it's an attribute (i.e. why it's filtered on) |
|---|---|---|
| `agent_id` | `str` | Primary narrowing filter — always present in the write path's own query |
| `memory_type` | `str` | `fact` \| `task` \| `preference` \| `event` — equality filter |
| `tag` | `str` | Short topic string, `STARTSWITH`-filterable |
| `importance` | `u64` | 0–10 salience, range-filterable (`>= n`) — this is what makes a query compound, not a single equality lookup |
| `swarm_ref` | `str` | Pointer to the encrypted content on Swarm. Never the content itself. |

Attribute names are lowercase snake_case only — the engine's charset excludes uppercase
and camelCase entirely (verified empirically in pre-flight, `smoke/attr-charset.mjs`; the
SDK's client-side `isValidAttributeName` disagrees with the engine and will not catch this).

## What stays off Arkiv

The memory's actual content — never written as an attribute or payload here. Arkiv's own
brief is explicit that entities are public and verifiable by design, so anything that
should not be publicly queryable does not belong on Arkiv at all. This schema's payload is
empty; `swarm_ref` is the only pointer to where the real content lives, encrypted, on
Swarm.

## Expiry is the mechanic (Mission 02)

Every `agent_memory` entity's lifetime is set with `ExpirationTime.fromBlocks(n)` — block-
based, exact, no wall-clock rounding. Short-lived "working memory" gets a small block
count; once the chain passes that height, the entity stops matching queries with **no**
`deleteEntity` call anywhere in the trace. The same query run before and after that
boundary returns a different row count — that difference is the evidence, not a screen
recording of a countdown timer.

`createEntity`'s returned `expiresAt` is a lower bound for `fromBlocks()` — the engine
resolves the duration against whichever block the transaction actually lands in, so the
requested block count and the applied expiry height are recorded separately (see
`src/arkiv.mjs`, `createMemory`) rather than assumed equal.

## Live queries

Real compound filters over typed attributes, not a lookup by id — the code backing the
"Why Arkiv" story above:

```js
import { and, eq, gte, startsWith } from '@arkiv-network/sdk/query'
import { str, u64 } from '@arkiv-network/sdk'

// agent_id = "atlas" AND memory_type = "task" AND importance >= 7
const q1 = and(
  eq('agent_id', str('atlas')),
  eq('memory_type', str('task')),
  gte('importance', u64(7n)),
)

// agent_id = "atlas" AND tag STARTSWITH "proj"
const q2 = and(
  eq('agent_id', str('atlas')),
  startsWith('tag', str('proj')),
)

const results = await pub.select('*').where(q1).limit(50).fetch()
```

Both are reproducible via `src/arkiv.mjs`'s `queryMemories()`.

## Live subscription (Mission 03)

`watchEntityEvents` events carry change metadata only (`entityKey`, `owner`, `expiresAt`)
— never attributes or payload (confirmed against the SDK's shipped source, not just its
docs: `node_modules/@arkiv-network/sdk/src/actions/public/watchEntityEvents.ts`). This
schema's write path therefore does a bounded follow-up `getEntity` read per event to
actually fetch `agent_id` / `memory_type` / `swarm_ref`, and skips (does not surface as an
error) any event whose entity isn't one of this schema's — that's how an irrelevant chain
event is demonstrated *not* updating the UI. See `src/arkiv.mjs`, `watchMemories()`.

## Lifetime extension — deliberately not used

`extendEntity` is not called anywhere in this schema. Working memory is meant to genuinely
lapse, not be renewed — extending it on activity would defeat the "built to expire"
mechanic this schema exists to demonstrate. (For reference: extension SETS a new expiry
from now rather than adding to the current one, and the engine rejects an extension that
would not move the expiry later — verified in pre-flight, 7/7 live checks.) A future,
non-hackathon version of this product would plausibly use it for durable/long-term
memories; this build keeps to one pattern, demonstrated well, rather than two half-shown.

## Ownership

Each entity is created and owned by the wallet acting on behalf of its agent identity
(the agent's ENSv2 name resolves to that wallet's address — see `docs/PRODUCT.md`,
Component 3). Creator/owner addresses and entity keys are recorded per write as evidence.
