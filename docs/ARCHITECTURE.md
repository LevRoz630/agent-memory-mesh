# Hydra — architecture

What the code in this repo does today, why each piece is there, and where the claims come
from. Every behavioural claim below is followed by its source: a file and line in this repo,
a file and line in a dependency's shipped source, a line in Bee's OpenAPI spec, or a live
request with its response. Nothing here is from a blog post or from memory.

Sections 1 to 6 are what the code does today. Section 7 is the workflow being built toward;
its last subsection says which parts of it are verified and which are not.

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
        ├──────────────► src/swarm.mjs   AES-256-GCM → stamped POST /chunks → reference
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

**Schema.** Six attributes on every row, snake_case, defined once in `src/arkiv.mjs:23-30`,
plus one that only verdict rows carry:

| Attribute       | Type    | Values                                                                                            |
| --------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `app`         | `str` | `hydra` — the only value; written by every participant so the index can be selected |
| `agent_id`    | `str` | `atlas` / `nova` / `sol`                                                                    |
| `memory_type` | `str` | `event` / `claim` / `lane` / `done` / `verdict` — the five workflow roles, nothing else (§7)         |
| `tag`         | `str` | `incident-<id>` — the thread key every row of one piece of work shares                          |
| `importance`  | `u64` | 0–10, supports `gte` filtering                                                                  |
| `swarm_ref`   | `str` | the 64-hex Swarm reference                                                                        |
| `outcome`     | `str` | `fixed` / `reopened` — on `verdict` rows only (§7)                                          |

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

Nothing in this repo calls `deleteEntity` today. That is the claim being demonstrated: rows
leave by block height, not by anyone acting. The one place §7's workflow does delete is a
worker releasing *its own* claim on finishing, which is an optimisation over waiting for the
lapse, never a way to free someone else's. `scripts/demo-expiry.mjs` writes an 8-block row and
polls the same query until it returns zero rows; `scripts/watch-claim.mjs` does the same for
a claim written by someone else.

**Queries.** `queryMemories` composes `eq` / `gte` / `startsWith` under `and`
(`src/arkiv.mjs:115-122`). Two constraints shaped this:

- Arkiv rejects a predicate-free query, so "show me everything recent" is a single
  `eq(app, 'hydra')` (`src/arkiv.mjs:126-128`) rather than an unfiltered scan.
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

**What the code does.** A random content key is generated for each memory; the content is encrypted with AES-256-GCM and packed as `[12-byte IV][16-byte auth tag][ciphertext]` into one blob. The content key is wrapped per roster recipient via ECIES (ECDH over secp256k1 + HKDF), using each agent's `ARKIV_PRIVATE_KEY_<AGENT>` as their decryption identity — the same key that signs their Arkiv transactions (`src/swarm.mjs:8-10`). There is no shared secret. The wrapped blob is POSTed to `${SWARM_GATEWAY}/chunks`, default `https://api.gateway.ethswarm.org`, as a stamped chunk (`src/swarm.mjs:165-190`). Download attempts decryption with each configured agent's private key until one successfully unwraps the content key, then decrypts the content (`src/swarm.mjs:192-197`). An 8-second timeout exists because a gateway that accepts the connection and then stalls leaves a bare `fetch()` pending forever, hanging whichever route awaits it (`src/swarm.mjs:26-28`).

**Which SDK, and why not the other one.** `@ethersphere/bee-js` is a dependency and works
server-side. `@snaha/swarm-id` — the library behind Swarm's drive UI, and the one that
implements ACT as plain functions — does not: importing it under Node fails with
`window is not defined`, because its single bundle touches browser globals at module scope.
Its published `exports` map offers one entry point, so there is no server-safe subpath to
reach past it. That is the constraint that rules out Bee's own ACT for us: the library that implements it as plain functions cannot be loaded here.

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
GET  /chunks/9bfa8221…      → "hydra: locally stamped chunk, no bee node"
```

`Stamper.fromBlank(signerKey, batchId, depth)` from `@ethersphere/bee-js` produces the
envelope; `bee.uploadChunk(envelope, chunk.data)` sends it. The credential lives in `.env` as
`SWARM_SIGNER_KEY` and `SWARM_POSTAGE_BATCH_ID`; the signer address is the batch's on-chain
owner, which is what makes the stamp valid.

**This is the difference between renting and owning.** On `/bytes` the durability of what we
store is a stranger's decision. On the chunk path it is ours, bounded by the batch — and the
batch is the live constraint: **depth 23, ~3.9 days of TTL, expiring around 2026-09-16.**
Nothing else in this document has a deadline attached to it.

**Wired.** `src/swarm.mjs` uploads stamped chunks and reads them back; `SWARM_SIGNER_KEY`
and `SWARM_POSTAGE_BATCH_ID` live in `.env`, with `SWARM_BATCH_DEPTH` defaulting to the
drive's 23. Two limits are deliberate rather than solved:

- **4 KB per memory.** One stamp covers exactly one chunk, so a larger payload needs splitting
  with a stamp each. Instead of splitting, `uploadMemory` refuses:
  `encrypted content is 4139 bytes; one stamped chunk holds 4096`.
- **The stamper's bucket counters are in memory only.** One `Stamper` outlives the process's
  uploads, so it never hands out a slot twice — but a restart resets the counts, and
  `Stamper.fromState` exists precisely to persist them. Until it is used, a long-running
  redeploy can eventually re-stamp a filled bucket and get `Bucket is full`.

---

## 5. The three paths through the system

**Write.** `POST /api/memory` → validate all six fields, rejecting non-integer importance and
TTL before they reach the SDK → select the signer for `agentId`, refusing an unknown one (§7)
→ clamp the TTL if this is a `claim` (§6) → `writeMemory` →
encrypt, stamp, upload the chunk, get its address → `createEntity` with that reference and
the five metadata attributes beside it → return `{ entityKey, txHash, swarmRef, appliedTtlBlocks, appliedExpiresAt, requestedTtlBlocks, ttlClamped }` (`src/app.mjs:36-74`).

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

This is the shape the project was built toward, and it's now built: three funded wallets, each
signing its own writes, and the full claim lifecycle below — renewal, takeover, finishing, and
verification — implemented in `src/protocol.mjs` and exercised end to end by
`scripts/orchestrator.mjs`.

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

### The five entity roles

All five are ordinary `agent_memory` entities. The role is carried by `memory_type`; the tag
says which piece of work it concerns.

| Role     | `memory_type` | `tag`           | TTL                             | Written by                                  |
| -------- | --------------- | ----------------- | ------------------------------- | ------------------------------------------- |
| incident | `event`       | `incident-<id>` | 600 blocks                      | the reporting agent                         |
| claim    | `claim`       | `incident-<id>` | 8 blocks, renewed while working | the working agent                           |
| lane     | `lane`        | `incident-<id>` | 600 blocks                      | each agent, once, on its first Swarm write  |
| done     | `done`        | `incident-<id>` | 600 blocks                      | the finishing agent                         |
| verdict  | `verdict`     | `incident-<id>` | 600 blocks                      | the reporting agent, after checking the fix |

All five share one tag per piece of work and differ only by type, so every query in the
protocol is an equality match on two attributes. Nothing parses a built string.

The asymmetry is the design: **claims clean themselves up, everything else persists.** Expiry
is the default, and survival is what costs effort.

`lane` is the one role that exists to answer a question none of the others can. A claim says
who is working *now* and is required to vanish. A `done` row is only ever written by an agent
that finished. Neither records that Nova touched the incident and then died — and that is
precisely the fact the takeover needs. So `lane` is written once, the first time an agent puts
anything on Swarm for this incident, and it is long-lived on purpose. Its `owner` is the
provenance.

### The Swarm side: one lane per agent

Nothing on Swarm is appended to or edited. Every write is a new immutable chunk at a new
address, so work in progress cannot be a growing document — it is a sequence of separate
objects, and the whole problem is how another agent finds them without being told.

Two kinds of address solve it. An ordinary blob's address *is* the hash of its bytes, so it
cannot be guessed; you have to be handed it. A feed chunk's address is derived from **who
wrote it and what it is about** instead:

```
address = hash( owner wallet , topic , index )
topic   = Topic.fromString('hydra/' + tag)
```

The address therefore exists before the content does, and anyone holding the tag and a wallet
address can compute it. An agent publishing work does two writes: the content as a stamped
chunk, and a small signed feed chunk at the next index of its own lane pointing at it. One
lane per wallet, one topic per incident:

```
topic = hash('hydra/incident-42')

hash(atlas_addr, topic, 0) → the incident report
hash(nova_addr,  topic, 0) → partial diagnosis        (Nova then dies)
hash(sol_addr,   topic, 0) → the fix
hash(sol_addr,   topic, 1) → verification note
```

Only Nova's key can write at `hash(nova_addr, topic, i)`, so a lane's owner is proof of
authorship — nothing rests on the self-asserted `agent_id`. Everyone can read every lane,
because the addresses are computable. And because Swarm has no expiry, a lane outlives both
the agent that wrote it and every Arkiv row around it.

### Discovery: two questions, two systems

An agent arriving at an incident asks two different questions, and each goes to the system
that can answer it. Neither is a scan.

**"Is anyone alive on this?"** — Arkiv, and it is a live-or-gone answer:

```
and( eq(app, 'hydra'), eq(tag, 'incident-42'), eq(memory_type, 'claim') )
→ zero rows: free to take. one row: its owner holds it, provably.
```

**"Who has ever worked this, and what did they produce?"** — Arkiv for the *who*, Swarm for
the *what*:

```
and( eq(app, …), eq(tag, 'incident-42'), eq(memory_type, 'lane') )
→ the owner of each row is a wallet that wrote to Swarm for this incident
```

Then, for each of those wallets only, walk its lane from index 0 until a read 404s. Two
wallets come back, not fifty, and the cost is one transaction per agent per incident no matter
how many lane updates follow. Probing the whole fleet's lanes instead would be both O(agents)
and slow — each lane probe is a walk to find the latest index, at an 8-second timeout each.

The roster in the incident's envelope bounds this a second time — in principle: each memory is
sealed to a roster of agent public keys (§2's envelope encryption), so it is *shaped* like a
bound on who could ever decrypt it. In this deployment that bound is not actually enforced,
because one process holds all three agents' private keys and does both the sealing and the
opening — any party with server access can decrypt everything regardless of roster. What's real
today is a demonstrated per-agent sealing mechanism; what would make the bound real is splitting
the agents into separate processes with separate key custody, which is future work.

### Resume rather than re-do

Because a lane update is a separate object rather than an edit, a worker can publish
intermediate findings cheaply and a successor can pick them up. That is the difference between
the demo showing a *resume* and showing a *restart*:

- Nova publishes a partial diagnosis to its lane at index 0 and writes its `lane` row.
- Nova dies. Its claim lapses; its lane and `lane` row do not.
- Sol queries `lane` rows, finds Nova's wallet, reads Nova's lane from index 0, and continues
  from the root cause rather than rediscovering it.

An agent that publishes nothing before dying loses its work — that is a consequence of the
storage being immutable, not a bug to fix. Publishing intermediate state is what buys
resumability, and it costs one chunk plus, once, one Arkiv row.

### Closing the loop: verification

`done` means "I believe I fixed it", not "it is fixed". The reporting agent is the one that
detected the incident, so it is also the one positioned to check:

1. Atlas's poll on `and(eq(tag, 'incident-42'), eq(memory_type, 'done'))` returns a row it did
   not write — owned, provably, by Sol.
2. Atlas reads Sol's lane, decrypts the verification note, and re-checks the signal that
   opened the incident in the first place.
3. Atlas writes a `verdict` row carrying `outcome` (`fixed` or `reopened`) as a queryable
   attribute, with its reasoning in an encrypted chunk on its own lane.

`reopened` needs no cleanup: every claim from the previous round has already lapsed, so the
incident is simply takeable again. Nothing in the protocol is ever edited — the state of an
incident is the set of rows that exist for its tag, and the only thing that changes state
without anyone acting is time.

This is also why the design needs no `patchEntity`. It exists and works — verified live, and
owner-gated exactly like `extendEntity` and `deleteEntity`, rejecting a non-owner with
`entity 0x… is owned by 0x…, not 0x…` — but a protocol in which every row is created by its
own owner and never modified has nothing to patch. `changeOwnership` is likewise deliberately
unused: handing a row to another agent would hand it to one that can also crash, and there is
nothing a transfer buys that a second row does not.

### The lifecycle

```
atlas                    nova                       sol
  │                        │                          │
  ├─ swarm: report → lane index 0                     │
  ├─ event/incident-42 ───►│                          │
  │  (600 blocks)          │                          │
  │                        ├─ query verdict/42 → none │
  │                        ├─ query done/42    → none │
  │                        ├─ query claim/42   → none │
  │                        ├─ claim/42 (8 blocks) ───►│ query claim/42 → held, backs off
  │                        ├─ swarm: diagnosis → lane index 0
  │                        ├─ lane/42 (600 blocks)    │
  │                        ├─ extend every ~3 blocks  │
  │                        ✗  process dies            │
  │                           (no tx, no event)       │
  │                        ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
  │                        lease lapses at its block  │
  │                                                   ├─ query claim/42 → none
  │                                                   ├─ query lane/42  → nova's wallet
  │                                                   ├─ read nova's lane from index 0
  │                                                   ├─ claim/42 ─────────────►
  │                                                   ├─ swarm: the fix → lane index 0
  │                                                   ├─ lane/42 (600 blocks)
  │                                                   ├─ done/42 (600 blocks)
  │                                                   └─ delete its own claim
  │◄─ query done/42 → sol's row ──────────────────────┤
  ├─ read sol's lane, re-check the original signal    │
  └─ verdict/42 outcome=fixed (600 blocks)            │
```

Six things in that diagram are decisions rather than mechanics:

- **Check in the order `verdict`, `done`, `claim`.** Each is cheaper to honour than to undo:
  a closed incident should not be reopened by a worker, and finished work should not be
  redone. The reverse order leaves a window for both.
- **Write the Swarm chunk before the `lane` row.** Same rule as `src/memory.mjs`: a row that
  points at content which failed to upload is worse than no row at all.
- **The `lane` row is written once, not per update.** It records that this wallet has content
  for this incident; how much content is a question for Swarm, not for the chain.
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

This is not fixed, and the reason is worth stating plainly: **the lease is
advisory, not exclusive** — the same guarantee etcd gives without fencing tokens. A
deterministic tie-break (re-query, lowest `entityKey` wins, losers back off) closes genuine
collisions in about twenty lines and no new primitive. It does not close the case of an agent
that goes slow rather than dying, whose lease lapses while it is still working. Fixing that
needs a resource that rejects stale writes, and there isn't one here.

### What of this is verified

| Claim                                                       | Status                                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| Per-agent lanes on one topic, written by separate wallets    | verified — nova and sol each wrote their own lane, same topic   |
| A third party can compute a lane's address from wallet + topic alone, but reading the content back needs a roster key | verified — the address needs no key, decrypting what's at it does (§2) |
| Lane history is recoverable after later updates exist        | verified — index 0 read back after index 1 was written          |
| An unwritten lane is a clean signal, not an error            | verified — `404 Not Found`, distinguishable from a failure      |
| Content chunks stamped with our own batch                    | verified — `/chunks` accepts a signed envelope, 25/25 uploads   |
| Feed chunks stamped with our own batch                        | verified — the stamp must cover the single-owner-chunk address, `keccak(keccak(topic‖index)‖owner)`; stamping the payload's returns `400 chunk write error` |
| The batch, not the gateway, pays for lane writes             | verified — a foreign signing key on the same feed write is rejected `400 chunk write error` |
| The tie-break converges under real cross-block skew           | verified — `scripts/verify-tie-break.mjs`, including a staggered-start run |
| A successor discovers a crashed worker's lane via `takeOver` | verified — `scripts/verify-takeover.mjs`                        |
| The full lifecycle runs end to end against the live network  | verified — `scripts/orchestrator.mjs`, repeated runs             |

Every mechanism §7 depends on is verified against the live gateway with our own postage, and so
is the protocol built on top of it: renewal, takeover, finishing, and verdict issuance are no
longer designed-but-unbuilt — see the scripts above.

---

## Appendix: how to verify any claim above

| Claim                                     | Check                                                                |
| ----------------------------------------- | -------------------------------------------------------------------- |
| Expiry is exact, applied value can differ | `node --env-file=.env scripts/demo-expiry.mjs`                     |
| A claim lapses with nothing watching      | `node --env-file=.env scripts/watch-claim.mjs nova`                |
| All four Arkiv findings                   | `npm run feedback:repro` (exit 0 = reproduced)                     |
| Gateway ignores the postage header        | the three`POST /bytes` calls in §4                                |
| Our own batch is the one being spent      | the wrong-key and fake-batch rejections in §4                        |
| A locally stamped chunk uploads           | `node --env-file=.env -e "import('./src/swarm.mjs').then(m=>m.uploadMemory({note:'probe'}).then(console.log))"` |
| Each agent signs as itself                | the three addresses in §7, on any block explorer for Tiramisu       |
| SDK behaviours                            | the cited paths under`node_modules/@arkiv-network/sdk/src/`        |
| Bee endpoint contracts                    | `openapi/Swarm.yaml` in `ethersphere/bee`, line numbers as cited |
| The tie-break converges, takeover works, the full lifecycle runs | `npm run verify:tie-break`, `npm run verify:takeover`, `npm run demo:protocol` |
| The auditor decrypts independently of the three agents    | `npm run generate:auditor-key`, then `node scripts/audit-exporter.mjs` against a live write (§8) |

---

## 8. Audit export

Nothing in this system retains data by default. `claim` rows expire in 12 blocks (24 seconds);
every other Arkiv row expires in 600 blocks (20 minutes); the Swarm postage batch itself expires
in days regardless of what Arkiv still points at. That's deliberate — expiry is the mechanism
§3 is built around — but it means there is no later point at which "export everything" is
possible. By the time someone asks for the audit trail, most of it is already gone.

**Swarm has no bulk export, list, or enumeration API of any kind** — confirmed against
`@ethersphere/bee-js`'s full surface (chunk, SOC, feed, and manifest methods) and against
`swarm.snaha.net/docs/api/`. Every retrieval is by a reference you already hold; nothing indexes
content back to a batch, an owner, or an app. A feed manifest (`createFeedManifest`) makes one
*known* feed's latest update reachable by a stable URL — a resolver convenience, not a discovery
mechanism, and it still requires knowing the owner and topic up front. Arkiv's own queries are
the only thing that indexes anything here, and Arkiv's index is exactly as ephemeral as the rows
in it.

The only mechanism that actually works is **continuous export as the events happen**, not a pull
run later: `scripts/audit-exporter.mjs` extends `watchMemories` (the same subscription
`server.mjs` already runs) and, on every `EntityCreated`/`ExpiryExtended`/`EntityDeleted` for this
app, immediately downloads and decrypts the referenced Swarm content and appends it to a durable
local log — before either side has a chance to age out.

### A separately-custodied auditor, not a fourth name for a key everyone already holds

Decryption still needs a key: every memory and lane payload is sealed to a roster (§2), so an
exporter with no key on that roster sees ciphertext it cannot open. The obvious shortcut — run
the exporter with one of atlas/nova/sol's own keys, since the default roster already includes all
three — works, but it's not a real audit boundary: it's the same single trust domain this
deployment already has, wearing a different script's name.

Instead, `sealForRoster` (`src/swarm.mjs`) accepts a fourth, optional recipient: if
`AUDITOR_PUBLIC_KEY` is set, every seal wraps a copy of the content key for it, from the *public*
key alone. The exporter takes only `AUDITOR_PRIVATE_KEY`, `openForAuditor` decrypts with it
directly (no fallback to trying the agents' keys, unlike `openForAnyAgent`), and the exporter
process never touches `ARKIV_PRIVATE_KEY_ATLAS/NOVA/SOL`, `SWARM_SIGNER_KEY`, or
`SWARM_POSTAGE_BATCH_ID` — it can read and decrypt, but it cannot write to Arkiv or spend the
postage batch. `scripts/generate-auditor-key.mjs` generates the pair and prints which half goes
where.

Verified live: a memory uploaded through the normal path, sealed to `[atlas, nova]` plus whatever
the writer's `.env` configures, was decrypted afterward using *only* the auditor's private key —
no agent key, no `.env` — against the real gateway.

**What this does and doesn't buy, stated plainly, matching this project's existing pattern
elsewhere in §7:**

- It's real ECIES with a real, independently-generated keypair — not a shared password, and not
  a key the writers can use to decrypt as the auditor.
- It's not retroactive. Adding `AUDITOR_PUBLIC_KEY` only affects memories written afterward; past
  incidents stay sealed to whoever was on the roster when they were written.
- It's a single high-value key for full audit visibility. If it leaks, everything ever sealed to
  it is exposed, and there's no revoking access to content already written — only to what gets
  written next.
- Real separation depends on where the private half actually lives. Generated fresh and handed
  only to whoever runs the exporter, on a machine that never sees the agents' keys, this is
  genuine defense in depth. Placed in the same `.env` as everything else, it's the same
  single-process trust boundary this deployment already has, just with an extra name on it.
- Arkiv's own metadata — who claimed what, when, and its full renew/release history — needs no
  key at all. It's already public to anyone with an RPC connection; only the Swarm content is
  gated.
