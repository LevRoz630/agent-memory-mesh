# Agent Memory Mesh — internal notes

Everything that was previously split across `docs/PRODUCT.md`, `docs/build-plan.md`,
`arkiv/schema.md`, and `EVIDENCE.md`, merged into one reference for us. The pitch-facing
file is `README.md`; the scored Arkiv feedback report is `feedback.md`.

## What this is

An AI agent's memory, implemented as three separate concerns instead of one database:

- **Identity** — an ENSv2 name on Sepolia. The agent's name is not a display string, it's
  the thing other systems resolve to find the agent.
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
    -> upload to Swarm (gateway, no Bee node run by this app)
    -> get back a content reference
    -> create an Arkiv entity: { agent_id, memory_type, tag, importance, swarm_ref, $expiresAt }

READ PATH (live)
  second process/panel calls watchEntityEvents
    -> webSocket transport, no fromBlock
    -> event fires the moment something is written — no poll, no refresh
    -> the event itself carries change metadata only (e.g. owner), NOT attributes/payload
    -> use that metadata as an initial relevance filter (not authentication)
    -> bounded follow-up getEntity read on the entity key to fetch swarm_ref etc.
    -> fetches + decrypts the content from Swarm
    -> renders it
  (an irrelevant event must NOT trigger this chain — demo that)

READ PATH (queried)
  compound filter over Arkiv attributes, e.g.:
    agent_id = "atlas" AND memory_type = "task" AND importance >= 7
    agent_id = "atlas" AND tag STARTSWITH "proj"

EXPIRY
  a memory's $expiresAt is set short for working/task memory
  when the lease runs out, the entity stops matching queries — no delete call issued
  querying the same filter before and after the boundary returns a different row count
```

## Component 1 — Arkiv (index)

**What it holds.** Metadata only: which agent, what kind of memory, a tag, a numeric
importance, a pointer to the Swarm content, and a native expiry. Never the memory content
itself.

**Schema — entity type `agent_memory`.** One entity per memory. No sub-types, no separate
entity per agent — `agent_id` is a filterable attribute, not a partition key, because the
actual product query is always "this agent's memories of this kind," never "give me
everything."

| Attribute | Type | Why it's an attribute |
|---|---|---|
| `agent_id` | `str` | Primary narrowing filter — always present in the write path's own query |
| `memory_type` | `str` | `fact` \| `task` \| `preference` \| `event` — equality filter |
| `tag` | `str` | Short topic string, `STARTSWITH`-filterable |
| `importance` | `u64` | 0–10 salience, range-filterable (`>= n`) — what makes a query compound, not a single equality lookup |
| `swarm_ref` | `str` | Pointer to the encrypted content on Swarm. Never the content itself |
| `$expiresAt` | native | The lease |

Attribute names are lowercase snake_case only — the engine's charset excludes uppercase
and camelCase entirely (verified empirically in pre-flight; the SDK's client-side
`isValidAttributeName` disagrees with the engine and will not catch this).

**Constraints verified against the live Tiramisu node during pre-flight:**

- Attribute names: lowercase, digits, `_`, `-`, `.` only. Uppercase/camelCase are rejected
  by the engine even though the SDK's client-side validator returns `true` for them.
- Working operators: `=`, `<`, `<=`, `>`, `>=`, `STARTSWITH`, `AND`, `OR`, `NOT`. Rejected by
  the node despite being exported by the SDK: `!=`, `EXISTS()`, `TYPEOF()`. Negation goes
  through `NOT(eq(...))`.
- `extendEntity` is a true in-place lease — same entity key, same payload, same owner, only
  the expiry moves. Confirmed 7/7 live. Extension **sets** the expiry, it does not add to
  it, and a shorter extension is rejected by the engine. Deliberately not used in this
  schema — working memory is meant to lapse, not be renewed.
- Expiry emits no event. Nothing can watch for "this just expired" — the demo has to poll a
  query across the expiry boundary, not subscribe to an expiry notification.
- A live websocket subscription requires the `webSocket()` transport and **no** `fromBlock`
  argument. Passing `fromBlock` either silently drops the replay (with `poll: false`) or
  forces the watcher into HTTP polling despite the open socket (viem's default).
  `watchEntityEvents` itself exposes no `poll` flag, so this decision is made entirely by
  transport choice.
- `executeBatch` returns `createdEntities`, not `entityKeys`.
- `createEntity`'s returned `expiresAt` is a lower bound for `fromBlocks()` — the engine
  resolves the duration against whichever block the transaction lands in, so requested and
  applied can differ. Record both (see `src/arkiv.mjs`, `createMemory`).
- `getEntity`/`select` return attribute values as typed wrapper objects
  (`{ type: 'str', value: 'atlas' }`), asymmetric with the write path's plain constructors
  (`str()`/`u64()`). Unwrap once, centrally — `unwrapAttributes()` in `src/arkiv.mjs`.
- `getEntity` throws the identical `NoEntityFoundError` for a key that never existed and a
  key that legitimately expired — confirmed live, can't tell them apart from the error
  alone. Low impact here since `watchMemories` treats both the same way already.
- `watchEntityEvents`'s `onEntityCreated` carries no attributes or payload, only
  `entityKey`/`owner`/`expiresAt` — confirmed against the SDK's own shipped source.
- `privateKeyToAccount` needs viem's `nonceManager` passed explicitly, or concurrent
  `createEntity` calls from the same wallet collide on nonce and mostly revert (confirmed:
  1/6 landed without it, 6/6 with it). Applied in `makeClients()`.

**Mission mapping.** Mission 02 (`Built to expire`) is the TTL memory: same query before
and after the expiry boundary returns a different row count, no delete call in the trace.
Mission 03 (`Live wire`) is the cross-panel update: a websocket subscription with no
`fromBlock`, demonstrated live with two screens. Mission 01 is not attempted — there is no
pre-existing indexer this product replaces, and inventing one to decommission is against
the brief.

## Component 2 — Swarm (content)

Memory content, AES-256-GCM encrypted in-process, uploaded to a public gateway. No Bee node,
no postage stamp. `src/swarm.mjs`.

`@snaha/swarm-id` is not used: `SwarmIdClient` is iframe-based browser auth, which a server
writing memories programmatically cannot drive. The plain gateway `fetch()` path is
explicitly allowed by Swarm's bounty brief.

**Verified live.** Uploads with no batch header, an all-zero batch id, and a bogus batch id
all return 201. 1 MB and 5 MB round-trips are byte-identical.

The gateway stores ciphertext only — encryption happens before upload:

```js
const ref = await uploadMemory({ canary: 'CANARY_12345' })
const raw = Buffer.from(await (await fetch(`${GATEWAY}/bytes/${ref}`)).arrayBuffer())
raw.toString('utf8').includes('CANARY_12345')  // false
raw.length - JSON.stringify({ canary: 'CANARY_12345' }).length  // 28 = IV + authTag
```

**Encryption costs content-addressed dedup.** The raw gateway returns one reference for
identical bytes. `encrypt()` draws a fresh random IV per call, so the app never uploads
identical bytes twice:

```js
const [a, b] = await Promise.all([uploadMemory({ x: 1 }), uploadMemory({ x: 1 })])
a !== b  // true
```

A deterministic IV would restore dedup and leak which memories are identical.

**Reference length.** A plain reference is 64 hex chars; an encrypted one (Swarm's own
`Swarm-Encrypt` header) is 128 — exactly Arkiv's `MAX_STRING_BYTES`:

```js
str('a'.repeat(128))         // accepted
str('0x' + 'a'.repeat(128))  // InvalidValueError: 130 UTF-8 bytes exceeds the 128-byte limit
```

Not hit in this build — app-level encryption yields plain 64-hex refs — but any switch to
`Swarm-Encrypt` must store refs without the `0x` prefix.

**8s timeout on both calls.** A bare `fetch()` against a server that accepts a connection and
never responds stays pending indefinitely; `/api/query` and `/api/recent` fan out concurrent
downloads via `Promise.all`, so one stalled connection hangs the whole response:

```js
const s = createServer(() => {})              // accepts, never responds
process.env.SWARM_GATEWAY = `http://127.0.0.1:${s.address().port}`
await downloadMemory('0'.repeat(64))          // TimeoutError at ~8001ms
                                              // without the signal: still pending at 30s
```

**Untested:** retention. The gateway sponsors its own postage and may garbage-collect
content; this build has not verified durability over time.

## Component 3 — ENS (identity)

**What it holds.** Two names, one per agent — `atlas-ethrome26.eth` and
`nova-ethrome26.eth` — registered against the **ENSv2 beta deployment on Sepolia**, not v1.
The original plan was one parent name plus a subname per agent (`atlas.<parent>.eth`); flat
top-level names instead, because subname creation turned out to need deploying a custom
subregistry contract, which didn't fit inside the 60-minute cap this leg was given. A
registered ENSv2 name is still a real agent identity either way — the bounty asks for depth
of integration, not a specific name shape.

**Why a name and not just a wallet address.** A wallet address identifies a signer. A name
identifies an agent that other systems can look up, independent of which key currently
controls it — that's the "agent controlled namespace" ENS's own brief asks for, and it's
what makes the agent's identity portable rather than tied to one wallet.

**Registration path** (`scripts/ens-register.mjs`): mint a test token, approve the
registrar, commit, wait for `MIN_COMMITMENT_AGE`, register. The first attempt reverted
because a doc-page summary had the registrar's `duration` parameter as `uint256` when the
real deployed contract takes `uint64` — a different function selector, silent revert, no
reason given. Fixed by pulling the actual verified ABI from Blockscout instead of trusting
the summary. Both names registered clean once that was fixed (tx hashes below).

**Setting a profile text record is blocked — a real architectural mismatch, confirmed
on-chain.** `TextResolver.setText()` is gated by an `authorised(node)` modifier, which
calls `PublicResolverV2.isAuthorised()`, which calls `canModifyName()`. That function's
first step is `NAME_WRAPPER.names(node)` — a lookup against the **ENSv1** NameWrapper
contract — and returns `false` immediately if that's empty, before ever checking real
ownership. Names registered natively through ENSv2's own `ETHRegistrar` never touch the v1
NameWrapper, so that lookup returns `0x` for both names here (checked directly). The other
resolver in the Sepolia deployments table, `ENSV2Resolver`, is a read-only CCIP-read mirror,
not an alternative. Not pursued further — registration alone already satisfies "does real
work" / "end-to-end on live testnet data."

## Evidence

**Public deployment.** `https://agent-memory-mesh.vercel.app` — permanent, deployed under
the project owner's own Vercel account. Full write→Swarm→Arkiv→query round trip verified
live. The deployment-hash URL Vercel prints after `vercel deploy`
(`agent-memory-mesh-<hash>-leviticus.vercel.app`) 302s to Vercel's own SSO login —
Deployment Protection is on by default. The stable project-alias URL above is not behind
that wall and is the one to share.

Getting a working deploy took two fixes: (1) Vercel's zero-config "express" framework
detection auto-wrapped `server.mjs` itself as a second function, and `server.mjs` calls
`httpServer.listen()`/creates a `WebSocketServer`, neither valid inside a serverless
function — fixed with `"framework": null` in `vercel.json`; (2) the SSO wall above.

**ENS — ENSv2 beta, Sepolia.** Owner (both): `0x0Ef440b8C9Ce507Ce5f84c6b9EA7FB8b2C11a006`.

| Name | Register tx | Block |
|---|---|---|
| `atlas-ethrome26.eth` | [`0xe9c7380f9e07c85a2120f17df787891d088ba58ccadc8e8b9ba9f5a2c4abaa63`](https://sepolia.etherscan.io/tx/0xe9c7380f9e07c85a2120f17df787891d088ba58ccadc8e8b9ba9f5a2c4abaa63) | 11683692 |
| `nova-ethrome26.eth` | [`0xc7e9fa2fe1d25a026ef8fa8b4e15ca9d2a6cf159463f2d6e686f8cfea798b432`](https://sepolia.etherscan.io/tx/0xc7e9fa2fe1d25a026ef8fa8b4e15ca9d2a6cf159463f2d6e686f8cfea798b432) | 11683703 |

Contracts (Sepolia ENSv2 beta): `ETHRegistrar` `0xa88553f454b77203b0d036a05c894d555eaaa2cc`,
`MockUSDC` `0x768f42455a2d082e23ceef7d51e5787c82d67a39`,
`PublicResolverV2` `0xe7b9a25607e02da8145e4eb1836ca539e53f11f7` (set as resolver at
registration).

**Arkiv — Tiramisu.** Creator/owner wallet: `0x9F5997ecB905211a464F29090900468BDBa286C1`.

Write path, live, `agent_memory` entities created via `src/memory.mjs`'s `writeMemory`
(encrypt → Swarm → Arkiv entity), e.g. entity
`0xb762042b49aa288cb27f1084ccef3f234629a618812a8d4ecf93104d806a154a` via tx
`0xb015b269f43680c96d0a927d5f137166f3db9190b01bf3cebe14803f38bd99a5`.

Mission 02, `scripts/demo-expiry.mjs`, run live:

| | |
|---|---|
| Entity key | `0x4cb58a281dc35289f6c0ec97b82e849799d52685155d6a637be056f9ea3c2fb1` |
| Creation tx | `0x1dd2c53a001667a26623e01d93540432a380d88e1de965836a997e1580ef4120` |
| Requested lifetime | 8 blocks |
| Applied expiry (from receipt) | block 323562 |
| Written at | block 323552 |
| Query before expiry | 1 row |
| Query after expiry (block 323565) | 0 rows |
| `deleteEntity` calls made | 0 |

Requested (8) and applied (10 blocks' worth) differ, exactly as `ExpirationTime.fromBlocks`
says they can — the tx landed a couple blocks after the head was captured.

Mission 03, `server.mjs` + `src/arkiv.mjs`'s `watchMemories`, live end-to-end test: a
`POST /api/memory` write triggered a real `EntityCreated` websocket event, a bounded
`getEntity` follow-up read, a Swarm fetch+decrypt, and a push to a connected client over
`/live` — no polling, no refresh, a connected websocket client received the decrypted
content within ~6s of the write.

**Swarm.** Gateway: `api.gateway.ethswarm.org`, no postage stamp, no Bee node. Content is
app-level AES-256-GCM encrypted before upload. Example reference from a live write:
`0246bf131185b1c5829616bb4932194734bbbf50ec91a976a5bdcd8612e11e6b` (64 hex, plain
reference). Round-trip verified byte-for-byte.

## Bounties targeted

- **Arkiv** — Mission 02 (Built to expire), Mission 03 (Live wire), Best Use. Skipping
  Mission 01 — no pre-existing indexer to decommission.
- **Swarm** — real upload/retrieval, gateway, no Bee node.
- **ENS** — ENSv2 beta on Sepolia, name = agent identity.
- **Team1 — not pursued.** Wrong network (Avalanche) for this product.

## Cuts, in order, if time runs short before the demo

1. ENS entirely — weakest line of the three, costs a share of a $500 pool.
2. The "extend on activity" lease pattern — keep only "let it lapse" for Mission 02
   (already the case — `extendEntity` is never called).
3. ENSv2 resolver depth (roles/delegation, text records) — registration alone still
   qualifies.
4. Swarm ID → plain gateway `fetch()` if it has rough edges (already the case).
5. Never cut: the live two-panel update (Mission 03 and the product demo, same artifact),
   or the public deployment.

## Demo script, mapped to what each judge is checking

1. State what this is in one sentence — memory as identity + content + index, three
   different systems, none of which does the others' job.
2. Agent A writes a memory on camera. Show the sequence: encrypt, land on Swarm, index on
   Arkiv with `$expiresAt` set.
3. Agent B's panel updates with no refresh. This is Arkiv Mission 03's literal demo ask —
   point at it, don't make the judges infer it.
4. Run a compound query live: `agent_id = X AND memory_type = Y AND importance >= N`. This
   is what "query depth" means in Arkiv's rubric — not a lookup by id.
5. Show a short-lived memory disappear from that same query with no delete call anywhere in
   the code being shown. This is Mission 02 — use block-based expiration
   (`ExpirationTime.fromBlocks(n)`) and show both the requested duration and the applied
   expiration height from the creation receipt, they can differ.
6. Show one irrelevant change that does *not* trigger Agent B's panel — proves the event
   filter is real, not "something happened, refresh anyway."
7. One line on the ENS name: it's the identity, not a lookup — say what would break if it
   were just a wallet address instead.
8. One line on why the content is on Swarm and not Arkiv: Arkiv is the index, not the place
   data lives.

Recording constraint: ≤3 minutes, face on camera, against the deployed URL.

## Qualification checklists

**Arkiv:** tick Arkiv + name missions · public repo · public deployment URL · feedback
report (`feedback.md`) · creator wallet + entity key/tx evidence.

**Swarm:** public repo · short README · a demo · one line on future direction.

**ENS:** official ENSv2 beta contracts on Sepolia · real work, not decorative · end-to-end
on live testnet data, no hardcoded results · Sepolia names/addresses/tx links · demo +
architecture explanation at judging.

**ETHRome minimums:** open source · contract addresses for anything deployed · ≤3-minute
demo video, works logged out.

## Current scoring, confirmed live via the arkiv-ethrome MCP (`guides/ethrome-current`, checked 2026-09-12)

Weighted judging criteria (supersedes any earlier unweighted checklist):

| Weight | Criterion | Show |
|---|---|---|
| 30% | Why Arkiv / Web3 database? | The user-visible capability Arkiv enables, the query the app depends on, trade-offs against a Web2 database |
| 25% | Technical execution | A working core flow end to end, including the Arkiv reads/writes that power it |
| 20% | Usefulness and adoption potential | Intended users, their problem, a concrete way to reach the first 100 users |
| 25% | Arkiv feedback | Specific, reproducible observations — what worked and what didn't |

**Gap:** nothing in this repo currently states intended users or a first-100-users
distribution plan (the 20% criterion). Needs adding to `README.md` before submission.

Submission checklist (from the same source):

1. Public GitHub repo with setup/run instructions and disclosure of third-party components.
2. Public deployment URL (Vercel is explicitly accepted).
3. Product explanation tied to a real query and user flow: what it is, why Arkiv, intended
   users, distribution plan.
4. Completed missions with linked source, commands, recordings, known limitations.
5. Public Tiramisu creator-wallet address, entity keys mapped to creation transactions.
6. Link directly to `feedback.md` in GitHub (an existing `arkiv/friction.md` is also
   accepted as the same report — this repo uses `feedback.md`).

Corrections against the freshest MCP guidance, superseding earlier notes in this file's
predecessor docs:

- `arkiv/schema.md` was never a hard gate — confirmed directly by the current guidance, not
  just an earlier inference. Its content now lives in this file instead.
- Prize pool is **EUR 2,500** (EUR 500/mission + EUR 1,000 Best Use), not USDC — an earlier
  note in this project guessed USDC from a hacker-manual/MCP conflict; the current
  production Hub page states EUR directly. One team, one payout, even across multiple
  completed missions.
- Mission 03 evidence should show an irrelevant event *not* triggering a UI update, and
  actual disconnect/reconnect behavior (not just an initial connect).
