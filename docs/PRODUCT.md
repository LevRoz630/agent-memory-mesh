# Agent Memory Mesh — product and technical reference

The developer-facing reference during the build and the source material for the judge
presentation. Keep it updated as the build diverges from plan.

## What this is

An AI agent's memory, implemented as three separate concerns instead of one database:

- **Identity** — an ENSv2 subname on Sepolia. The agent's name is not a display string,
  it's the thing other systems resolve to find the agent.
- **Content** — encrypted, content-addressed blobs on Swarm. The actual memory: what the
  agent knows, what it was told, what it decided.
- **Index** — typed, queryable, expiring records on Arkiv. Not the memory itself, a pointer
  to it plus enough metadata to search, filter, and decide when it should disappear.

Two agent instances demonstrate it: one writes a memory, the other's view of the world
updates without a refresh, over a live subscription, not a polling loop. A short-lived
memory expires from queries on its own, with no delete call, because its lease ran out.

## Why this shape

Most AI agent products solve memory with one bucket: a vector DB, a JSON blob, a table.
That bucket does not answer three questions an agent-memory system needs answered: who
does this belong to across host apps, what happens to memory that should not persist
forever, and how does a second process find out something changed without asking it every
second.

This design answers those three with the three primitives the ETHRome sponsors put on the
table this year:

- ENS's own suggested direction: "profiles for AI agents inside an agent controlled
  namespace." Detail in Component 3 below.
- Swarm's own suggested direction: "portable AI memory that moves between assistants." If
  memory is content-addressed and stored off any single vendor's infrastructure, any client
  holding the reference can read it — memory stops being locked to whichever app wrote it.
- Arkiv's own stated pattern for its expiry mechanic: "let an entity lapse and treat its
  absence as the signal." Most memory systems delete explicitly, via a cron job or a TTL
  index that still requires someone to build the cleanup path. Here expiry is native — the
  record vanishes from queries when its lease is up, nothing else has to run.

None of the three pieces stands in for the others. Swarm is not a database — it has no
query language. Arkiv is not file storage — its own docs say so. ENS is not storage or a
database — it's a name that resolves to something. The product only exists at the seam
between them, which is also the reason no single sponsor's brief covers it alone.

## Architecture

```
WRITE PATH
  agent decides to remember something
    -> encrypt the content
    -> upload to Swarm (gateway, via Swarm ID — no Bee node run by this app)
    -> get back a content reference
    -> create an Arkiv entity: { agentId, memoryType, tag, importance, swarmRef, $expiresAt }

READ PATH (live)
  second process/panel calls watchEntityEvents
    -> webSocket transport, no fromBlock
    -> event fires the moment something is written — no poll, no refresh
    -> the event itself carries change metadata only (e.g. owner), NOT attributes/payload
    -> use that metadata as an initial relevance filter (not authentication)
    -> bounded follow-up getEntity read on the entity key to fetch swarmRef etc.
    -> fetches + decrypts the content from Swarm
    -> renders it
  (an irrelevant event must NOT trigger this chain — demo that explicitly)

READ PATH (queried)
  compound filter over Arkiv attributes, e.g.:
    agentId = "atlas" AND memoryType = "task" AND importance >= 7
    agentId = "atlas" AND tag STARTSWITH "proj"

EXPIRY
  a memory's $expiresAt is set short for working/task memory
  when the lease runs out, the entity stops matching queries — no delete call issued
  querying the same filter before and after the boundary returns a different row count
```

## Component 1 — Arkiv (index)

**What it holds.** Metadata only: which agent, what kind of memory, a tag, a numeric
importance, a pointer to the Swarm content, and a native expiry. Never the memory content
itself — that's the split Arkiv's own brief asks projects to reason about explicitly
("what went in attributes, what stayed in the payload, and why").

**Schema.**

| Attribute | Type | Purpose |
|---|---|---|
| `agentId` | str | which agent wrote this |
| `memoryType` | str | `fact` \| `task` \| `preference` \| `event` |
| `tag` | str | short topic string, supports `STARTSWITH` |
| `importance` | u64 | 0–10, supports range filters |
| `swarmRef` | str | pointer to the encrypted content on Swarm |
| `$expiresAt` | native | the lease |

**Why these attributes.** Each one earns its place by being something a query filters on.
`agentId` narrows to one agent. `memoryType` and `tag` narrow by kind and topic.
`importance` supports a range query (`>= 7`), which is what makes a filter compound rather
than a single equality lookup — the thing Arkiv's rubric rewards. Nothing here is free text
or a blob; that's what `swarmRef` points at instead.

**Constraints already verified against the live Tiramisu node during pre-flight:**

- Attribute names: lowercase, digits, `_`, `-`, `.` only. Uppercase is rejected by the
  engine even though the SDK's client-side validator returns `true` for it. Do not name an
  attribute `agentId` — it must be `agent_id` or similar. Confirm the exact accepted
  spelling empirically before committing to names in code.
- Working operators: `=`, `<`, `<=`, `>`, `>=`, `STARTSWITH`, `AND`, `OR`, `NOT`. Rejected
  by the node despite being exported by the SDK: `!=`, `EXISTS()`, `TYPEOF()`. Negation
  goes through `NOT(eq(...))`.
- `extendEntity` is a true in-place lease — same entity key, same payload, same owner, only
  the expiry moves. Confirmed 7/7 live. Extension **sets** the expiry, it does not add to
  it, and a shorter extension is rejected by the engine.
- Expiry emits no event. Nothing can watch for "this just expired" — the demo has to poll
  a query across the expiry boundary, not subscribe to an expiry notification.
- A live websocket subscription requires the `webSocket()` transport and **no** `fromBlock`
  argument. Passing `fromBlock` either silently drops the replay (with `poll: false`) or
  forces the watcher into HTTP polling despite the open socket (viem's default) — the two
  failure modes are different and both are wrong. `watchEntityEvents` itself exposes no
  `poll` flag, so this decision is made entirely by transport choice.
- `executeBatch` returns `createdEntities`, not `entityKeys`.

**Mission mapping.** Mission 02 (`Built to expire`) is the TTL memory: same query before
and after the expiry boundary returns a different row count, no delete call in the trace.
Mission 03 (`Live wire`) is the cross-panel update: a websocket subscription with no
`fromBlock`, demonstrated live with two screens. Mission 01 is not attempted — there is no
pre-existing indexer this product replaces, and inventing one to decommission is explicitly
against the brief.

## Component 2 — Swarm (content)

**What it holds.** The actual memory content, encrypted, uploaded via the gateway. No Bee
node run by this app — Swarm ID signs the postage stamp client-side and the app talks to a
public gateway.

**Verified against the live gateway during pre-flight:** uploads with no batch header, an
all-zero batch id, or a bogus batch id all return 201. A 1 MB round-trip is byte-identical.
Identical content produces an identical reference — content addressing gives deduplication
with no extra code.

**The one landmine to route around.** A plain content reference is 64 hex characters, fits
a `bytes32`. An encrypted reference is 128 hex characters — exactly Arkiv's `MAX_STRING_BYTES`
limit with zero headroom. `str("0x" + ref)` at 130 bytes throws `InvalidValueError`. Store
the encrypted reference **without** the `0x` prefix.

**What this is not.** Durability is not guaranteed — the gateway sponsors its own postage,
content may be garbage-collected. Confidentiality is gateway-side, not end-to-end — the
gateway sees the plaintext before it encrypts. Both are fine for a demo, neither is a claim
to make in the pitch.

## Component 3 — ENS (identity)

**What it holds.** One parent name plus a subname per agent (e.g. `atlas.<parent>.eth`,
`nova.<parent>.eth`), registered against the **ENSv2 beta deployment on Sepolia**, not v1.
A resolver record on each subname carries a short profile string.

**Why a subname and not just a wallet address.** A wallet address identifies a signer. A
subname identifies an agent that other systems can look up by name, independent of which
key currently controls it — that's the "agent controlled namespace" ENS's own brief asks
for, and it's what makes the agent's identity portable rather than tied to one wallet.

**Registration path, unverified before the event, beta-flagged by ENS's own docs**
("write flows are ENSv2-specific, and their authorization details may still change before
mainnet"): mint a test token, approve the registrar, register. Three transactions before
the subname exists. This is the one component in this build with no prior validated code —
register the demo subnames first, before any other work, so a beta surprise shows up early
rather than late.

**Hard cap: 60 minutes.** If registration is not working by then, drop ENS and ship
Arkiv + Swarm only. See `build-plan.md` for the schedule this sits inside.

## Demo script, mapped to what each judge is actually checking

1. State what this is in one sentence — memory as identity + content + index, three
   different systems, none of which does the others' job.
2. Agent A writes a memory on camera. Show the sequence: encrypt, land on Swarm, index on
   Arkiv with `$expiresAt` set.
3. Agent B's panel updates with no refresh. This is Arkiv Mission 03's literal demo ask —
   point at it, don't make the judges infer it.
4. Run a compound query live: `agentId = X AND memoryType = Y AND importance >= N`. This is
   what "query depth" means in Arkiv's rubric — not a lookup by id.
5. Show a short-lived memory disappear from that same query with no delete call anywhere in
   the code being shown. This is Mission 02 — use block-based expiration
   (`ExpirationTime.fromBlocks(n)`) and show both the requested duration and the applied
   expiration height from the creation receipt, they can differ.
5b. Show one irrelevant change that does *not* trigger Agent B's panel — proves the event
   filter is real, not "something happened, refresh anyway."
6. One line on the ENS subname: it's the identity, not a lookup — say what would break if
   it were just a wallet address instead.
7. One line on why the content is on Swarm and not Arkiv: Arkiv is the index, not the
   place data lives — that's a direct quote from their own brief, and repeating it back to
   them in the Saturday conversation is the answer to their "Arkiv fit and trade-offs"
   criterion.

## Known risks

| Risk | Mitigation |
|---|---|
| ENSv2 registration flow untested, beta, three transactions before a name exists | Do it first, hard 60-minute cap, drop ENS if it blows the cap |
| "AI agent memory" as a category is common in 2026 AI-track pitches | Differentiate on the mechanic, not the category: expiry with no delete call, content-addressed portability instead of vendor lock-in, live handoff over a subscription instead of polling — say this, don't assume the demo makes it obvious |
| Two-panel demo has to serve both the Arkiv Mission 03 judges and the general ETHRome judges | It's the same artifact for both — don't build two separate demos, don't cut corners on either angle |
| Arkiv's live rubric has already changed once between the mission-page brief and the actual `hub.arkiv.network/ethrome` page | Re-check that page again before finalizing the pitch |

## Reference

Full build schedule, cut lines, and qualification checklists: `build-plan.md`.
