# Agent Memory Mesh — architecture

What the code in this repo does today, why each piece is there, and where the claims come
from. Every behavioural claim below is followed by its source: a file and line in this repo,
a file and line in a dependency's shipped source, a line in Bee's OpenAPI spec, or a live
request with its response. Nothing here is from a blog post or from memory.

Read this before the design questions at the end. Those are the parts that are not settled.

---

## 1. The problem the split solves

Agents that never call each other. Atlas detects an incident; Nova or Sol claims it and works
it. If the working agent's process dies mid-fix, the claim must lapse without anything having
to notice. §7 covers the full three-agent workflow.

That produces two different storage needs, and they pull in opposite directions:

| Need                                                                   | Shape                                                           | Where it goes |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- | ------------- |
| "Is there an open task tagged for remediation, importance ≥ 7?"       | small, typed, queryable by many parties, must expire on its own | Arkiv         |
| The incident itself — log excerpts, affected endpoints, the reasoning | arbitrary size, not queryable, must stay private                | Swarm         |

Arkiv attributes are capped: `str` values are 128 bytes, UTF-8 correct (`feedback.md:59-60`).
An incident report does not fit. So Arkiv holds a 64-hex pointer and the searchable metadata;
Swarm holds the bytes. That is the whole architecture in one sentence.

---

## 2. Component map

```
scripts/agent-chat.mjs        a Claude session with two tools: remember / recall
        │  HTTP
        ▼
src/app.mjs                   REST surface (shared)
  ├── server.mjs              local: same app + WebSocket push on /live
  └── api/index.mjs           Vercel: same app, no WebSocket (no long-lived process)
        │
        ▼
src/memory.mjs                the only place the two legs are joined
        ├──────────────► src/swarm.mjs   AES-256-GCM → POST /bytes → reference
        └──────────────► src/arkiv.mjs   createEntity{ attributes incl. swarm_ref }
```

`src/memory.mjs` is 16 lines and does one thing: upload content, then index the reference.
Order matters — a Swarm upload that fails must not leave an Arkiv row pointing at nothing
(`src/memory.mjs:5-9`).

---

## 3. The Arkiv leg

**Chain.** Tiramisu, a db-chain testnet. RPC endpoints come from the SDK's own chain
definition, not from us: `node_modules/@arkiv-network/sdk/src/chains/tiramisu.ts:17-18`
(`https://rpc.tiramisu.db-chain.testnet.arkiv.network`, and the same host over `wss://`).

**Schema.** Six attributes, snake_case, defined once in `src/arkiv.mjs:23-30`:

| Attribute       | Type    | Purpose                                                                  |
| --------------- | ------- | ------------------------------------------------------------------------ |
| `app`         | `str` | constant`agent-memory-mesh` — written by every participant, see below |
| `agent_id`    | `str` | who wrote it - atlas, nova or sol                                        |
| `memory_type` | `str` | `fact` / `task` / `preference` / `event` / `claim`             |
| `tag`         | `str` | topic                                                                    |
| `importance`  | `u64` | 0–10, supports`gte` filtering                                         |
| `swarm_ref`   | `str` | the 64-hex Swarm reference                                               |

`claim` is a first-class type, not a tag convention: it is what an agent writes to take a
task another agent filed, and it is the only type the demo TTL clamp applies to
(`src/app.mjs:58-59`). A lease that an agent has to spell correctly in a tag is not a lease.

`app` exists so the index can be selected as a whole. It replaced an `or` across hard-coded
agent ids, which did not survive a third agent, and it is also what the live watcher tests to
decide whether a chain event is ours (`src/arkiv.mjs:126-128, 149`).

snake_case is not style. The SDK's client-side `isValidAttributeName` accepts `agentId` and
`AGENT`; the engine rejects both on-chain (`feedback.md:43-56`). The payload itself is empty
— `stringToPayload('')` — because the entity is an index row, not a container
(`src/arkiv.mjs:71`).

**Expiry is the feature.** `ExpirationTime.fromBlocks(n)` takes a positive integer, exact, no
rounding — verified in the shipped source at
`node_modules/@arkiv-network/sdk/src/utils/expirationTime.ts:106-114`, and in the SDK's own
test at `node_modules/@arkiv-network/sdk/src/entity/expiry.test.ts:55-57`. But the value `createEntity` returns is resolved
against whichever block the transaction actually lands in, so requested and applied differ.
Both are recorded and returned rather than one being assumed
(`src/arkiv.mjs:66-83`, `src/memory.mjs:9`).

Nothing in this repo calls `deleteEntity`. That is the claim being demonstrated: rows leave
by block height, not by anyone acting. `scripts/demo-expiry.mjs` writes an 8-block row and
polls the same query until it returns zero rows; `scripts/watch-claim.mjs` does the same for
a claim written by someone else.

**Queries.** `queryMemories` composes `eq` / `gte` / `startsWith` under `and`
(`src/arkiv.mjs:115-122`). Two constraints shaped this:

- Arkiv rejects a predicate-free query, so "show me everything recent" is a single
  `eq(app, 'agent-memory-mesh')` (`src/arkiv.mjs:126-128`) rather than an unfiltered scan.
- `select('*')` silently omits `owner` on the live node, so fields are listed explicitly
  (`src/arkiv.mjs:107-113`).

**Reads come back shaped differently from writes.** Writes take `str('atlas')`; reads return
`{ type: 'str', value: 'atlas' }`. Unwrapped in one place so nothing downstream has to know
(`src/arkiv.mjs:101-105`); filed as finding 1 in `feedback.md`.

**Concurrency.** Six concurrent `createEntity` calls from one signer: 1 of 6 land without
viem's `nonceManager`, 6 of 6 with it, and the error text never says "nonce"
(`feedback.md:68-84`). Applied at `src/arkiv.mjs:47, 57`. This is the finding most likely to
bite another team, and it is reproducible: `scripts/feedback/03-nonce-manager.mjs`.

**Live view.** `watchEntityEvents` delivers `{ entityKey, owner, expiresAt }` and nothing
else — confirmed in the SDK's own JSDoc example at
`node_modules/@arkiv-network/sdk/src/actions/public/watchEntityEvents.ts:78-79`. So every
event must be read back to find out whether it is ours; anything whose `app` doesn't match is
dropped silently so unrelated chain traffic never reaches the UI (`src/arkiv.mjs:142-161`).
Two things are easy to get wrong here and are handled: the watch needs its own
`webSocket()`-transport client or it degrades to polling (`src/arkiv.mjs:60-62`), and viem
reconnects the socket without restoring the subscription behind it, so the watch is re-armed
on error (`server.mjs:46-71`).

---

## 4. The Swarm leg

**What the code does.** `src/swarm.mjs` encrypts with AES-256-GCM, packs
`[12-byte IV][16-byte auth tag][ciphertext]` into one blob, and POSTs it to
`${SWARM_GATEWAY}/bytes`, default `https://api.gateway.ethswarm.org` (`src/swarm.mjs:10, 25-33, 45-60`). Download reverses it (`src/swarm.mjs:62-70`). An 8-second timeout exists because a
gateway that accepts the connection and then stalls leaves a bare `fetch()` pending forever,
hanging whichever route awaits it (`src/swarm.mjs:11-13`).

**Which SDK, and why not the other one.** `@ethersphere/bee-js` is a dependency and works
server-side. `@snaha/swarm-id` — the library behind Swarm's drive UI, and the one that
implements ACT as plain functions — does not: importing it under Node fails with
`window is not defined`, because its single bundle touches browser globals at module scope.
Its published `exports` map offers one entry point, so there is no server-safe subpath to
reach past it. That is the constraint that shapes §8's access-control options.

**Why app-level encryption rather than Swarm's own.** Bee supports `swarm-encrypt`
(`Swarm.yaml:185`, the `SwarmEncryptParameter`). Using it would push the reference from 64 to
128 hex characters — verified live:

```
POST /bytes                          → reference 64 hex  (d88102d6…af9abbd0)
POST /bytes  Swarm-Encrypt: true     → reference 128 hex (c9650684…48e37171)
```

128 hex characters exceeds nothing structurally, but it doubles what has to sit in a `str`
attribute capped at 128 bytes, leaving no headroom. More to the point, the gateway would hold
the key. App-level GCM means the gateway never sees plaintext (`src/swarm.mjs:5-6`).

### Postage: whose storage are we actually using

Two paths exist through the same gateway, and they are not equivalent.

**The `/bytes` path ignores postage entirely.** Bee's spec lists `swarm-postage-batch-id` as
a parameter of `POST /bytes` (`Swarm.yaml:175-182`) with `402 Payment Required` among its
responses (`Swarm.yaml:206`). On this gateway the header is decorative — verified by sending
a deliberately invalid one:

```
POST /bytes  (no postage header)                     → 201
POST /bytes  Swarm-Postage-Batch-Id: <our real batch> → 201
POST /bytes  Swarm-Postage-Batch-Id: not-even-hex-garbage → 201
```

Identical responses. `X-Powered-By: Express` is the tell: this is a gateway proxy in front of
a Bee node, and per Swarm's own documentation a gateway can "optionally manage postage stamps
on behalf of the operator, including automatically buying new batches"
(https://docs.ethswarm.org/docs/develop/tools-and-features/gateway-proxy/). So a 201 here is
not evidence our batch was charged. It is evidence the gateway paid, from its own batch, for
anyone who asks.

**The chunk path honours a locally signed stamp, and that is the one to use.** The Swarm team
provided a drive: a postage batch plus the private key that owns it on Gnosis. That key signs
a stamp per chunk locally — the batch is never in anyone else's hands and no Bee node is
involved. Verified live:

```
chunk address: 9bfa8221cd7b3b5916d0d299668242cd35d10a35ecc4abc13a9e1898c3c12af9
locally signed stamp for batch: 15c48475dafee866…
POST /chunks with envelope  → 201, reference 9bfa8221…c3c12af9
GET  /chunks/9bfa8221…      → "agent-memory-mesh: locally stamped chunk, no bee node"
```

`Stamper.fromBlank(signerKey, batchId, depth)` from `@ethersphere/bee-js` produces the
envelope; `bee.uploadChunk(envelope, chunk.data)` sends it. The credential lives in `.env` as
`SWARM_SIGNER_KEY` and `SWARM_POSTAGE_BATCH_ID`; the signer address is the batch's on-chain
owner, which is what makes the stamp valid.

**This is the difference between renting and owning.** On `/bytes` the durability of what we
store is a stranger's decision. On the chunk path it is ours, bounded by the batch — and the
batch is the live constraint: **depth 23, ~3.9 days of TTL, expiring around 2026-09-16.**
Nothing else in this document has a deadline attached to it.

**Not yet wired.** `src/swarm.mjs` still uses the unstamped `/bytes` path. Moving it to
stamped chunks also means chunking payloads above 4 KB ourselves, and persisting the
stamper's bucket counters between restarts — `Stamper.fromState` exists for exactly that, and
without it a restarted process re-stamps buckets it has already filled and eventually gets
`Bucket is full`.

---

## 5. The three paths through the system

**Write.** `POST /api/memory` → validate all six fields, rejecting non-integer importance and
TTL before they reach the SDK → select the signer for `agentId`, refusing an unknown one (§7)
→ clamp the TTL if this is a `claim` (§6) → `writeMemory` →
encrypt, upload, get reference → `createEntity` with the reference and five metadata
attributes → return `{ entityKey, txHash, swarmRef, appliedTtlBlocks, appliedExpiresAt, requestedTtlBlocks, ttlClamped }` (`src/app.mjs:36-74`).

**Read.** `GET /api/query?agentId=…` → Arkiv predicate → for each row, fetch and decrypt its
Swarm content. A failed fetch degrades to `{ error: 'content unavailable: …' }` on that row
rather than failing the request, so an expired or unreachable blob does not take the page
down (`src/app.mjs:16-24, 77-92`).

**Live.** `watchEntityEvents` → read back → broadcast over `/live` to every connected
browser (`server.mjs:39-65`). This path does not exist on Vercel; a serverless function
cannot hold a socket open, so the deployment falls back to `/api/recent` polling
(`src/app.mjs:1-2, 94-105`).

Error handling worth naming: Express's default handler serves stack traces including
filesystem paths, so malformed JSON and oversized bodies are caught before that
(`src/app.mjs:117-122`).

---

## 6. Demo affordances

Two things exist for the recorded demo rather than for the design:

- `src/app.mjs`: a `DEMO_MAX_TTL_BLOCKS` clamp applied to `memory_type: 'claim'`
  (`src/app.mjs:33-34, 58-59`). Rationale: the agent picks its own TTL, and a claim it
  decides should live 1800 blocks cannot be shown lapsing inside a three-minute video. The
  response reports `requestedTtlBlocks`, `appliedTtlBlocks` and `ttlClamped` separately, so
  neither the agent nor the UI can mistake a clamped write for an honoured one
  (`src/app.mjs:65-70`).
- `scripts/watch-claim.mjs`: watches an existing claim lapse rather than writing one first,
  so the expiry demo can run against a claim Nova actually made.

---

## 7. The three-agent workflow

This is the shape the project is being built toward. **Identity is built**: three funded
wallets, and the server signs each write with the agent that asked for it. **The claim
protocol is not** — the lifecycle below is designed, and nothing yet renews, completes or
takes over a lease.

### Why three and not two

Two agents can show a hand-off. They cannot show *contention*, and contention is what makes
an expiring lease worth anything. With a third agent, "Nova crashed" stops being a claim made
by narration and becomes something visible: Sol picks the work up, and the only thing that
let it do so was the lease lapsing on its own.

| Agent     | Role                                              | Writes                   | Reads                       |
| --------- | ------------------------------------------------- | ------------------------ | --------------------------- |
| `atlas` | monitoring — detects incidents, never fixes them | `event` incidents      | nothing it needs to act on  |
| `nova`  | remediation worker                                | `claim`, then `done` | open incidents, live claims |
| `sol`   | second remediation worker — identical to Nova    | `claim`, then `done` | open incidents, live claims |

Nova and Sol are the same program with different identities. That is the point: neither is
special, and either can take work the other abandons.

### Identity

Four wallets. Three agents sign for themselves; the original key becomes the funder and signs
nothing in the protocol.

| Role   | Env var                     | Address                                        | Funded     |
| ------ | --------------------------- | ---------------------------------------------- | ---------- |
| funder | `ARKIV_PRIVATE_KEY`       | `0x9F5997ecB905211a464F29090900468BDBa286C1` | 0.0486 GLM |
| atlas  | `ARKIV_PRIVATE_KEY_ATLAS` | `0xa3D849F993765d7B434E53f76Ab4Bd6e6C214215` | 0.05 GLM   |
| nova   | `ARKIV_PRIVATE_KEY_NOVA`  | `0x992c6b62B5E2C227204FB28FFB1e88693206Cfb0` | 0.05 GLM   |
| sol    | `ARKIV_PRIVATE_KEY_SOL`   | `0x7D75c4b534feC6c205245aF5A87A2A6Be9049d49` | 0.05 GLM   |

At the measured 0.000105 GLM per `createEntity`, 0.05 GLM is roughly 475 writes per agent.
Keys live in `.env`, which is gitignored.

Separate signers are what make the central claim true rather than rhetorical. Until now both
agents shared one key, so every row had the same `owner` and `agent_id` was a string an agent
asserted about itself. `makeAgentSigners` now builds one wallet client per agent from
`ARKIV_PRIVATE_KEY_<AGENT>`, and the write route picks the signer by `agentId`
(`src/arkiv.mjs`, `src/app.mjs`). An agent with no configured key is refused rather than
signed for by whichever key is at hand:

```
$ curl -X POST /api/memory -d '{"agentId":"mallory", …}'
{"error":"no signer configured for agentId \"mallory\" — known: atlas, nova, sol"}
```

Verified live: each of the three agents wrote one entity through the API, and each row's
`owner` came back as that agent's own address from the table above. `agent_id` and `owner`
now agree, and `owner` is the one the engine enforces. Two consequences follow immediately:

- **Nobody can release or renew anyone else's claim.** `extendEntity` and `deleteEntity` are
  owner-gated (`src/arkiv.mjs:85-99`); a non-owner is rejected with
  `entity 0x… is owned by 0x…, not 0x…`. So an abandoned claim cannot be cleaned up by a
  peer — expiry is not the convenient mechanism, it is the *only* one.
- **Each agent gets its own nonce sequence**, which is what made the concurrent funding and
  the three writes above land together (`feedback.md` finding 3).

### The three entity roles

All three are ordinary `agent_memory` entities. The role is carried by `memory_type`; the tag
says which piece of work it concerns.

| Role     | `memory_type` | `tag`           | TTL                             | Written by          |
| -------- | --------------- | ----------------- | ------------------------------- | ------------------- |
| incident | `event`       | `incident-<id>` | 600 blocks                      | the reporting agent |
| claim    | `claim`       | `incident-<id>` | 8 blocks, renewed while working | the working agent   |
| done     | `done`        | `incident-<id>` | 600 blocks                      | the finishing agent |

All three share one tag per piece of work and differ only by type, so every query in the
protocol is an equality match on two attributes. Nothing parses a built string.

The asymmetry is the design: **claims clean themselves up, completions persist.** Expiry is
the default, and survival is what costs effort.

### The lifecycle

```
atlas                    nova                       sol
  │                        │                          │
  ├─ event/incident-42 ───►│                          │
  │  (600 blocks)          │                          │
  │                        ├─ query done/42  → none   │
  │                        ├─ query claim/42 → none   │
  │                        ├─ claim/42 (8 blocks) ───►│ query claim/42 → held, backs off
  │                        │                          │
  │                        ├─ extend every ~3 blocks  │
  │                        ✗  process dies            │
  │                           (no tx, no event)       │
  │                        ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
  │                        lease lapses at its block  │
  │                                                   ├─ query claim/42 → none
  │                                                   ├─ claim/42 ─────────────►
  │                                                   ├─ done/42 (600 blocks)
  │                                                   └─ delete its own claim
```

Four things in that diagram are decisions rather than mechanics:

- **Check `done` before `claim`.** The other order leaves a window where finished work gets
  picked up and redone.
- **The lease is far shorter than the work.** 8 blocks, about 16 seconds, renewed roughly
  every 3. A third of the lease means two consecutive failed renewals are survivable;
  renewing at full length makes every renewal a photo finish, and one slow RPC drops a lease
  that is being actively worked.
- **Nothing happens when the worker dies, and that is the mechanism.** No transaction, no
  event, no cleanup job — the engine simply stops answering for that key at the expiry block.
- **On finishing, write `done` before deleting the claim.** A crash between the two leaves
  the claim to lapse on its own while the `done` record already prevents repeated work. The
  reverse order can lose both.

### The lapse is derived, never announced

Arkiv emits `EntityCreated`, `EntityPatched`, `ExpiryExtended`, `OwnershipTransferred` and
`EntityDeleted`. **There is no expiry event.** Expiry is passive: no transaction happens at
the expiry block.

So a watcher cannot wait to be told a lease broke. It holds `{entityKey → expiresAt}` from
`EntityCreated`, updates it on each `ExpiryExtended`, drops it on `EntityDeleted`, and
compares the rest against head. A lapse is head passing an expiry with no renewal having
arrived. The chain never announces the broken lease; the watcher notices the silence.

This is also why §3's point about `watchEntityEvents` carrying only
`{ entityKey, owner, expiresAt }` matters more than it first appears — `expiresAt` on the
creation event is the entire basis for knowing when a lease is due to die.

### The race, stated honestly

Query-then-write is not atomic and Arkiv has no compare-and-set, so two workers can both
claim the same incident: both query in the block after a lapse, both find nothing, both
write. The window is one block plus RPC latency.

This is not fixed, and the reason is worth saying plainly to a mentor: **the lease is
advisory, not exclusive** — the same guarantee etcd gives without fencing tokens. A
deterministic tie-break (re-query, lowest `entityKey` wins, losers back off) closes genuine
collisions in about twenty lines and no new primitive. It does not close the case of an agent
that goes slow rather than dying, whose lease lapses while it is still working. Fixing that
needs a resource that rejects stale writes, and there isn't one here.

---

## 8. Everything else that is design, not code

Everything below is unbuilt. It is written down so mentors can push back on the shape before
any of it costs a day.

**One decryption key is the load-bearing simplification.** Today the server holds a single
`MEMORY_ENC_KEY` and both agents go through it (`src/swarm.mjs:17-23`). The pitch already
concedes this out loud. But it means the mesh is not actually trustless between agents: Nova
can read Atlas's content because the same process decrypts both. Two ways out:

ACT is what this wants to be. Bee ships access control natively: `POST /grantee` creates a
grantee list, `PATCH /grantee/{address}` adds and removes grantees, and transfers carry
`swarm-act` and `swarm-act-history-address` (`Swarm.yaml:31-170, 186-187`). Atlas publishes
under its own key and grants Nova and Sol; revocation is a list update, not a key rotation.
That is the version where "content addressed, publisher controlled" is true rather than
aspirational, and it is the spine of the incident workflow in §7.

**Three routes to it, all with a real cost. This is the open decision.**

1. *A Bee node of our own.* `bee-js` already exposes `createGrantees`, `getGrantees` and
   `patchGrantees`, so this is a config change, not new code — but those methods call
   `/grantee`, which the public gateway answers with 404. A node was stood up and torn down
   during this work: it runs, deploys a chequebook on first boot, and takes an unmeasured
   time to finish initialising. Feasible, not free.
2. *Implement ACT ourselves.* The format is not a secret: a JSON manifest of
   `{lookupKey, encryptedAccessKey}` entries, each grantee's lookup key derived by ECDH
   against the publisher's key, uploaded as an ordinary chunk. `@snaha/swarm-id` does exactly
   this client-side, which proves a node is not strictly required — but that library cannot
   be imported server-side (§4), so this means writing and testing the crypto ourselves.
3. *Keep app-level AES and say so.* What exists today. Honest, already working, and the thing
   §7's grant-forward workflow cannot be built on.

The choice is really between (1) before the deadline and (3) with a clear-eyed slide. (2) is
the best design and the worst use of the remaining days.

**Postage is solved, and is now a clock.** The drive credential means we sign our own stamps
against our own batch (§4) — "we pay for our own storage" is no longer future work. What
replaced it is an expiry date: the batch runs out around 2026-09-16, and topping it up is an
on-chain action against the batch, not something the gateway will do for us.

**Claims as feeds rather than as new entities.** Right now every claim is a fresh Arkiv
entity with a fresh Swarm blob. A Swarm feed gives "static addresses for your mutable
content", addressable by owner address plus topic id
(`GET /feeds/{owner}/{topic}`, `Swarm.yaml:1086`;
https://docs.ethswarm.org/docs/develop/tools-and-features/feeds/). A task could then have one
stable address whose latest update is its current state, with Arkiv holding only the
expiring lease over it. This is cleaner, and it is also a larger change than it sounds —
feed updates need chunk signing, and the docs are explicit that doing it by hand "can involve
a little data juggling and crypto magic."

**The server still holds every agent's key.** Per-agent signers fixed `owner`, but not who
is allowed to ask. `agentId` is a plain field in the request body, so anything that can reach
`POST /api/memory` can write as Nova by typing "nova" — the server checks that a signer
exists, never that the caller is entitled to it. The honest description today is a trusted
server with three identities, not three independent agents.

Closing it means the key moves to the agent: each agent process builds its own wallet client
and calls `createEntity` directly, leaving the server as a read and broadcast surface only.
That is the version where "the only thing connecting them is the public index" is literally
true, and it costs the demo its single point of observation — worth weighing before the
recording.

**Scoping reads by owner.** `app` is self-asserted exactly like `agent_id` was: anything can
write the constant and appear in the index. Now that the agent addresses are known and fixed,
reads can be scoped to that set, and `app` drops back to being a convenience rather than a
boundary.

---

## 9. What to ask mentors

1. **The batch expires around 2026-09-16.** Does it top up, or do we need a second drive?
   Every other Swarm question is downstream of this one.
2. ACT needs either our own Bee node or our own implementation of the grantee manifest
   (§8) — the public gateway 404s `/grantee` and the library that does it client-side is
   browser-only. Which is the right call with the time left?
3. Now that each agent signs for itself, no agent can release or renew another's claim —
   the engine gates both on ownership. Is "lapsing is the only way abandoned work frees up"
   the strongest version of the argument, or does a mentor read it as a missing feature?
4. The advisory-lease race (§7): present it as a stated limitation with a known fix, or
   spend the twenty lines on the tie-break so the question never comes up?
5. Feeds for mutable task state: worth the signing complexity inside the remaining time, or
   is "one entity per state change, expiring" the honest primitive to show?
6. For the Arkiv feedback report — the four findings in `feedback.md` all reproduce. The
   Swarm side now has one of the same shape: `POST /bytes` returns 201 for a valid batch id,
   an invalid one, and none at all, so a caller cannot tell whether their own postage was
   spent. Worth filing?

---

## Appendix: how to verify any claim above

| Claim                                     | Check                                                                |
| ----------------------------------------- | -------------------------------------------------------------------- |
| Expiry is exact, applied value can differ | `node --env-file=.env scripts/demo-expiry.mjs`                     |
| A claim lapses with nothing watching      | `node --env-file=.env scripts/watch-claim.mjs nova`                |
| All four Arkiv findings                   | `npm run feedback:repro` (exit 0 = reproduced)                     |
| Gateway ignores the postage header        | the three`POST /bytes` calls in §4                                |
| A locally stamped chunk uploads           | the`Stamper` / `uploadChunk` sequence in §4                      |
| Each agent signs as itself                | the three addresses in §7, on any block explorer for Tiramisu       |
| SDK behaviours                            | the cited paths under`node_modules/@arkiv-network/sdk/src/`        |
| Bee endpoint contracts                    | `openapi/Swarm.yaml` in `ethersphere/bee`, line numbers as cited |
