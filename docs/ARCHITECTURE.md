# Agent Memory Mesh — architecture

What the code in this repo does today, why each piece is there, and where the claims come
from. Every behavioural claim below is followed by its source: a file and line in this repo,
a file and line in a dependency's shipped source, a line in Bee's OpenAPI spec, or a live
request with its response. Nothing here is from a blog post or from memory.

Read this before the design questions at the end. Those are the parts that are not settled.

---

## 1. The problem the split solves

Two agents that never call each other. Atlas detects an incident, Nova claims it and works
it. If Nova's process dies mid-fix, the claim must lapse without anything having to notice.

That produces two different storage needs, and they pull in opposite directions:

| Need | Shape | Where it goes |
| --- | --- | --- |
| "Is there an open task tagged for remediation, importance ≥ 7?" | small, typed, queryable by many parties, must expire on its own | Arkiv |
| The incident itself — log excerpts, affected endpoints, the reasoning | arbitrary size, not queryable, must stay private | Swarm |

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

**Schema.** Six attributes, snake_case, defined once in `src/arkiv.mjs:23-34`:

| Attribute | Type | Purpose |
| --- | --- | --- |
| `app` | `str` | constant `agent-memory-mesh` — written by every participant, see below |
| `agent_id` | `str` | who wrote it — `atlas` or `nova` |
| `memory_type` | `str` | `fact` / `task` / `preference` / `event` / `claim` |
| `tag` | `str` | topic |
| `importance` | `u64` | 0–10, supports `gte` filtering |
| `swarm_ref` | `str` | the 64-hex Swarm reference |

`claim` is a first-class type, not a tag convention: it is what an agent writes to take a
task another agent filed, and it is the only type the demo TTL clamp applies to
(`src/app.mjs:52`). A lease that an agent has to spell correctly in a tag is not a lease.

`app` exists so the index can be selected as a whole. It replaced an `or` across hard-coded
agent ids, which did not survive a third agent, and it is also what the live watcher tests to
decide whether a chain event is ours (`src/arkiv.mjs:106-110, 120-128`).

snake_case is not style. The SDK's client-side `isValidAttributeName` accepts `agentId` and
`AGENT`; the engine rejects both on-chain (`feedback.md:43-56`). The payload itself is empty
— `stringToPayload('')` — because the entity is an index row, not a container
(`src/arkiv.mjs:48`).

**Expiry is the feature.** `ExpirationTime.fromBlocks(n)` takes a positive integer, exact, no
rounding — verified in the shipped source at
`node_modules/@arkiv-network/sdk/src/utils/expirationTime.ts:106-114`, and in the SDK's own
test at `src/entity/expiry.test.ts:55-57`. But the value `createEntity` returns is resolved
against whichever block the transaction actually lands in, so requested and applied differ.
Both are recorded and returned rather than one being assumed
(`src/arkiv.mjs:44-58`, `src/memory.mjs:9`).

Nothing in this repo calls `deleteEntity`. That is the claim being demonstrated: rows leave
by block height, not by anyone acting. `scripts/demo-expiry.mjs` writes an 8-block row and
polls the same query until it returns zero rows; `scripts/watch-claim.mjs` does the same for
a claim written by someone else.

**Queries.** `queryMemories` composes `eq` / `gte` / `startsWith` under `and`
(`src/arkiv.mjs:75-82`). Two constraints shaped this:

- Arkiv rejects a predicate-free query, so "show me everything recent" is a single
  `eq(app, 'agent-memory-mesh')` (`src/arkiv.mjs:106-110`) rather than an unfiltered scan.
- `select('*')` silently omits `owner` on the live node, so fields are listed explicitly
  (`src/arkiv.mjs:91-92`).

**Reads come back shaped differently from writes.** Writes take `str('atlas')`; reads return
`{ type: 'str', value: 'atlas' }`. Unwrapped in one place so nothing downstream has to know
(`src/arkiv.mjs:63-65`); filed as finding 1 in `feedback.md`.

**Concurrency.** Six concurrent `createEntity` calls from one signer: 1 of 6 land without
viem's `nonceManager`, 6 of 6 with it, and the error text never says "nonce"
(`feedback.md:68-84`). Applied at `src/arkiv.mjs:34`. This is the finding most likely to
bite another team, and it is reproducible: `scripts/feedback/03-nonce-manager.mjs`.

**Live view.** `watchEntityEvents` delivers `{ entityKey, owner, expiresAt }` and nothing
else — confirmed in the SDK's own JSDoc example at
`node_modules/@arkiv-network/sdk/src/actions/public/watchEntityEvents.ts:78-79`. So every
event must be read back to find out whether it is ours; anything without `agent_id` is
dropped silently so unrelated chain traffic never reaches the UI (`src/arkiv.mjs:99-118`).
Two things are easy to get wrong here and are handled: the watch needs its own
`webSocket()`-transport client or it degrades to polling (`src/arkiv.mjs:37-39`), and viem
reconnects the socket without restoring the subscription behind it, so the watch is re-armed
on error (`server.mjs:41-65`).

---

## 4. The Swarm leg

**What the code does.** `src/swarm.mjs` encrypts with AES-256-GCM, packs
`[12-byte IV][16-byte auth tag][ciphertext]` into one blob, and POSTs it to
`${SWARM_GATEWAY}/bytes`, default `https://api.gateway.ethswarm.org` (`src/swarm.mjs:10,
25-60`). Download reverses it (`src/swarm.mjs:62-70`). An 8-second timeout exists because a
gateway that accepts the connection and then stalls leaves a bare `fetch()` pending forever,
hanging whichever route awaits it (`src/swarm.mjs:11-13`).

**Why the plain gateway rather than an SDK.** `@snaha/swarm-id`'s client is an iframe-based
browser passkey flow. There is no browser here, so it cannot be driven from a Node server
(`src/swarm.mjs:1-3`).

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

**The postage question, which matters.** Bee's spec lists `swarm-postage-batch-id` as a
parameter of `POST /bytes` (`Swarm.yaml:175-182`), with `402 Payment Required` among the
documented responses (`Swarm.yaml:206`). This repo sends no such header. It works anyway,
verified live on 2026-09-12:

```
$ curl -i -X POST https://api.gateway.ethswarm.org/bytes \
    -H 'Content-Type: application/octet-stream' --data-binary 'agent-memory-mesh probe'
HTTP/1.1 201 Created
X-Powered-By: Express
swarm-tag: 23820
{"reference":"d88102d641dfeb598e71cef9029d691c8a8e654924b9059c8fdc5731af9abbd0"}

$ curl https://api.gateway.ethswarm.org/bytes/d88102d6…af9abbd0
agent-memory-mesh probe
```

`X-Powered-By: Express` is the tell: this is not a bare Bee node but a gateway proxy in front
of one, and per Swarm's own documentation a gateway can "optionally manage postage stamps on
behalf of the operator, including automatically buying new batches" and "monitoring batch
usage and expiration"
(https://docs.ethswarm.org/docs/develop/tools-and-features/gateway-proxy/).

**So the honest statement of the Swarm leg is:** we are an anonymous client of somebody
else's postage batch, on a gateway whose documentation page is marked for deprecation. It
works, it is genuinely content-addressed, the content is genuinely encrypted before it
leaves this process — and the durability of what we store is a third party's decision, not
ours. That is the single largest gap between what exists and what the design implies, and
§7 is mostly about closing it.

---

## 5. The three paths through the system

**Write.** `POST /api/memory` → validate all six fields, rejecting non-integer importance and
TTL before they reach the SDK → clamp the TTL if this is a `claim` (§6) → `writeMemory` →
encrypt, upload, get reference → `createEntity` with the reference and five metadata
attributes → return `{ entityKey, txHash, swarmRef, appliedTtlBlocks, appliedExpiresAt,
requestedTtlBlocks, ttlClamped }` (`src/app.mjs:36-69`).

**Read.** `GET /api/query?agentId=…` → Arkiv predicate → for each row, fetch and decrypt its
Swarm content. A failed fetch degrades to `{ error: 'content unavailable: …' }` on that row
rather than failing the request, so an expired or unreachable blob does not take the page
down (`src/app.mjs:16-24, 51-66`).

**Live.** `watchEntityEvents` → read back → broadcast over `/live` to every connected
browser (`server.mjs:41-65`). This path does not exist on Vercel; a serverless function
cannot hold a socket open, so the deployment falls back to `/api/recent` polling
(`src/app.mjs:1-2, 68-76`).

Error handling worth naming: Express's default handler serves stack traces including
filesystem paths, so malformed JSON and oversized bodies are caught before that
(`src/app.mjs:88-93`).

---

## 6. Uncommitted work in the tree

Two changes are not yet committed, both aimed at the recorded demo:

- `src/app.mjs`: a `DEMO_MAX_TTL_BLOCKS` clamp applied to `memory_type: 'claim'`
  (`src/app.mjs:33-34, 52-53`). Rationale: the agent picks its own TTL, and a claim it
  decides should live 1800 blocks cannot be shown lapsing inside a three-minute video. The
  response reports `requestedTtlBlocks`, `appliedTtlBlocks` and `ttlClamped` separately, so
  neither the agent nor the UI can mistake a clamped write for an honoured one
  (`src/app.mjs:59-64`).
- `scripts/watch-claim.mjs`: watches an existing claim lapse rather than writing one first,
  so the expiry demo can run against a claim Nova actually made.

---

## 7. How it ought to work — the parts that are design, not code

Everything below is unbuilt. It is written down so mentors can push back on the shape before
any of it costs a day.

**One decryption key is the load-bearing simplification.** Today the server holds a single
`MEMORY_ENC_KEY` and both agents go through it (`src/swarm.mjs:17-23`). The pitch already
concedes this out loud. But it means the mesh is not actually trustless between agents: Nova
can read Atlas's content because the same process decrypts both. Two ways out:

1. *Swarm ACT.* Bee ships access control natively: `POST /grantee` creates a grantee list,
   `PATCH /grantee/{address}` adds and removes grantees, and uploads and downloads carry
   `swarm-act` and `swarm-act-history-address` (`Swarm.yaml:31-170, 186-187`). Atlas
   publishes encrypted under its own key and grants Nova's public key. Revocation is a
   grantee-list update, not a key rotation. This is the version that makes "content
   addressed, publisher controlled" true rather than aspirational.
2. *Per-agent keys with out-of-band exchange.* Simpler, and worse — it pushes key
   distribution somewhere this project does not model.

ACT is the right answer if the gateway in front of us supports those endpoints. **That is
worth checking before anything else**, because it is the difference between a real design
and a slide.

**Our own postage batch.** Buying a batch (`POST /stamps/{amount}/{depth}`,
`Swarm.yaml:2197`) and sending `swarm-postage-batch-id` ourselves converts "it works on a
public gateway" into "we pay for our own storage with a stated TTL." It also makes the
durability story checkable: `GET /stamps/{batch_id}` reports batch usage and expiry
(`Swarm.yaml:2114`). Cost and depth are the open questions.

**Claims as feeds rather than as new entities.** Right now every claim is a fresh Arkiv
entity with a fresh Swarm blob. A Swarm feed gives "static addresses for your mutable
content", addressable by owner address plus topic id
(`GET /feeds/{owner}/{topic}`, `Swarm.yaml:1086`;
https://docs.ethswarm.org/docs/develop/tools-and-features/feeds/). A task could then have one
stable address whose latest update is its current state, with Arkiv holding only the
expiring lease over it. This is cleaner, and it is also a larger change than it sounds —
feed updates need chunk signing, and the docs are explicit that doing it by hand "can involve
a little data juggling and crypto magic."

**One wallet, two agents.** Both agents write from the same `ARKIV_PRIVATE_KEY`
(`server.mjs:13-19`), so `owner` is identical on every row and only the `agent_id` attribute
distinguishes them — which means an agent's identity is self-asserted, not proven. Separate
wallets per agent make `owner` meaningful and make the nonce-manager finding matter more, not
less.

**Discovery.** Done — this was an `or` across `['atlas', 'nova']` and is now a single
`eq(app, …)`. What remains open is that `app` is self-asserted like `agent_id`: anything can
write the constant and appear in the index. Scoping the feed to a set of known owner
addresses is the next step, and it depends on per-agent wallets below.

---

## 8. What to ask mentors

1. Does the public gateway support the ACT endpoints (`/grantee`, `swarm-act`)? If not,
   per-agent readable content needs our own Bee node, and that changes the demo's shape.
2. Is anonymous upload through `api.gateway.ethswarm.org` something to depend on for a
   judged submission, or should we buy a batch before the deadline regardless of cost?
3. Claims are now a `memory_type` the engine filters on, but an agent cannot renew or
   release another agent's claim — `extendEntity` and `deleteEntity` are owner-gated
   (`src/arkiv.mjs:67-81`), and both agents currently share one wallet. Is "lapsing is the
   only way a claim frees up" the right constraint to present, or a limitation to fix?
4. Feeds for mutable task state: worth the signing complexity inside the remaining time, or
   is "one entity per state change, expiring" the honest primitive to show?
5. For the Arkiv feedback report — the four findings in `feedback.md` all reproduce. Is
   there a Swarm-side equivalent worth filing, given the gap between what Bee's spec
   requires (a postage batch) and what the public gateway accepts (no header at all)?

---

## Appendix: how to verify any claim above

| Claim | Check |
| --- | --- |
| Expiry is exact, applied value can differ | `node --env-file=.env scripts/demo-expiry.mjs` |
| A claim lapses with nothing watching | `node --env-file=.env scripts/watch-claim.mjs nova` |
| All four Arkiv findings | `npm run feedback:repro` (exit 0 = reproduced) |
| Gateway accepts unstamped uploads | the two `curl` commands in §4 |
| SDK behaviours | the cited paths under `node_modules/@arkiv-network/sdk/src/` |
| Bee endpoint contracts | `openapi/Swarm.yaml` in `ethersphere/bee`, line numbers as cited |
