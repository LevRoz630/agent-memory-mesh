# Agent Memory Mesh

ETHRome 2026 submission, built for the Arkiv, Swarm, and ENS bounties.

An AI agent's memory, split across three systems instead of stuffed into one database:

- Identity is an ENSv2 name on Sepolia, the thing other systems resolve to find the agent.
  Registered as flat top-level names (`atlas-ethrome26.eth`, `nova-ethrome26.eth`) rather
  than subnames under one parent; Component 3 explains why.
- Content is encrypted, content-addressed blobs on Swarm. What the agent knows, what it was
  told, what it decided. Where this is headed: any client holding the decryption key reads
  straight from Swarm, with no app code in the middle.
- Index is typed, queryable, expiring records on Arkiv. A pointer to the content plus enough
  metadata to search it, filter it, and decide when it should disappear.

Two agent instances demonstrate it. One writes a memory, and the other's view of the world
updates without a refresh, over a live websocket subscription. A short-lived memory then
drops out of queries by itself, because its lease ran out rather than because anything
deleted it.

Arkiv feedback report: [`feedback.md`](feedback.md).

## Why this shape

Most AI agent products solve memory with one bucket: a vector DB, a JSON blob, a table. That
bucket can't answer the questions agent memory actually runs into. Who does this belong to
once the host app changes? What happens to memory that shouldn't outlive the task that
created it? And how does a second process notice a change without asking every second,
forever?

The three primitives the ETHRome sponsors put on the table this year answer those directly:

- ENS's own suggested direction: "profiles for AI agents inside an agent controlled
  namespace." Detail in Component 3.
- Swarm's own suggested direction: "portable AI memory that moves between assistants." If
  memory is content-addressed and sits off any single vendor's infrastructure, any client
  with the reference can read it.
- Arkiv's stated pattern for its expiry mechanic: "let an entity lapse and treat its absence
  as the signal." Most memory systems delete explicitly, through a cron job or a TTL index
  that someone still has to build a cleanup path for. Here the record stops matching queries
  when its lease is up, and nothing else has to run.

Swarm has no query language; it stores encrypted blobs. Arkiv's own docs call it an index,
which is the role it plays here: metadata and expiry, no bulk storage. ENS resolves a name to
something and holds no data of its own. The product lives in the seam between the three,
which is also why no single sponsor's brief covers it alone.

## Who this is for

Teams building multi-agent AI systems for enterprises hit this exact wall: agent memory
locked to one framework's session store, no native expiry, no identity separate from an API
key. It's a live problem for us specifically. We're building an AI agentic deployment for
enterprises at the HPE & NVIDIA Agentic AI Hackathon (HPE Geneva Customer Innovation Center,
Sept 14 2026, part of Swiss {ai} Weeks), presenting to the companies in the room, and Agent
Memory Mesh is the memory layer underneath it.

Path to the first 100 users: the repo is public now, so that event's own agent builders can
point at it directly. The pattern doesn't care which framework you're on, because an ENS name
plus a Swarm reference reads from any client, which suits LangChain, CrewAI, and
AutoGen-style builders equally. And we keep reusing it ourselves at every hackathon after
this one.

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
    -> event fires the moment something is written, without polling or a refresh
    -> the event itself carries change metadata only (e.g. owner), NOT attributes/payload
    -> use that metadata as an initial relevance filter (not authentication)
    -> bounded follow-up getEntity read on the entity key to fetch swarm_ref etc.
    -> fetches + decrypts the content from Swarm
    -> renders it
  (an irrelevant event must NOT trigger this chain; demo that)

READ PATH (queried)
  compound filter over Arkiv attributes, e.g.:
    agent_id = "atlas" AND memory_type = "task" AND importance >= 7
    agent_id = "atlas" AND tag STARTSWITH "proj"

EXPIRY
  a memory's $expiresAt is set short for working/task memory
  when the lease runs out, the entity stops matching queries (no delete call issued)
  querying the same filter before and after the boundary returns a different row count
```

## Real-agent proof

The browser UI (write form plus live feed) proves the Arkiv/Swarm/ENS plumbing works, but a
human clicking "write memory" doesn't prove an AI agent would use it. `scripts/agent-chat.mjs`
settles that: it hands a real Claude session two tools, `remember` and `recall`, wired to the
same `/api/memory` and `/api/query` endpoints the browser uses, and lets the model decide
when to call them.

Run live, `npm run agent -- atlas "remember that I prefer dark mode and 24-hour time"` had
Atlas's session split that into two separate `remember` calls on its own, one per preference,
each with its own tag and a `ttlBlocks` value it chose for a durable preference. A second,
fully independent process, `npm run agent -- nova "..."`, had Nova's session check its own
agent id first (nothing there), then query `agentId: atlas`, retrieve both preferences, and
answer correctly. That's the portability claim tested across two processes rather than
argued. The server's `watchEntityEvents` watcher
logged both writes as they happened (`live: agent_memory written by 0x9F59...`), so the
mission-control page picks them up over the same websocket whether the write came from the
browser form or from an agent's own decision.

## Component 1: Arkiv (index)

Arkiv holds metadata only: which agent, what kind of memory, a tag, a numeric importance, a
pointer to the Swarm content, and a native expiry. Never the memory content itself.

The schema is one entity type, `agent_memory`, one entity per memory. No sub-types and no
separate entity per agent, since `agent_id` is a filterable attribute. The real product query
is always "this agent's memories of this kind," never "give me everything."

| Attribute | Type | Why it's an attribute |
|---|---|---|
| `agent_id` | `str` | Primary narrowing filter, always present in the write path's own query |
| `memory_type` | `str` | `fact` \| `task` \| `preference` \| `event`, equality filter |
| `tag` | `str` | Short topic string, `STARTSWITH`-filterable |
| `importance` | `u64` | 0–10 salience, range-filterable (`>= n`), which gives a query compound depth past a single equality lookup |
| `swarm_ref` | `str` | Pointer to the encrypted content on Swarm, never the content itself |
| `$expiresAt` | native | The lease |

Attribute names are lowercase snake_case only. The engine's charset excludes uppercase and
camelCase entirely (verified empirically; the SDK's client-side `isValidAttributeName`
disagrees with the engine and won't catch this).

Constraints verified against the live Tiramisu node:

- Working operators: `=`, `<`, `<=`, `>`, `>=`, `STARTSWITH`, `AND`, `OR`, `NOT`. The node
  rejects `!=`, `EXISTS()`, and `TYPEOF()` even though the SDK exports them.
- `extendEntity` is a true in-place lease: same entity key, same payload, same owner, and the
  expiry moves forward only. This schema deliberately doesn't use it, because working memory
  is meant to lapse on its own.
- Expiry emits no event, so nothing can watch for "this just expired." The demo polls a query
  across the expiry boundary instead.
- A live websocket subscription needs the `webSocket()` transport and no `fromBlock`
  argument. Passing `fromBlock` forces HTTP polling even with the socket open.
- `createEntity`'s returned `expiresAt` is a lower bound for `fromBlocks()`. The engine
  resolves the duration against whichever block the transaction lands in, so requested and
  applied can differ. Both get recorded (see `createMemory` in `src/arkiv.mjs`).
- `select('*')` silently omits `owner` on the live node even though the SDK requests it
  correctly. An explicit `select({ owner: true, ... })` gets it back. Fixed in `runQuery`,
  `src/arkiv.mjs`.

Mission mapping: Mission 02 (`Built to expire`) is the TTL memory, where the same query
before and after the expiry boundary returns a different row count and the trace contains no
delete call. Mission 03 (`Live wire`) is the cross-panel update, a websocket subscription with
no `fromBlock`, demonstrated live on two screens. Mission 01 isn't attempted, since there's no
pre-existing indexer this product replaces.

## Component 2: Swarm (content)

Memory content is AES-256-GCM encrypted in-process, then uploaded to a public gateway. There's
no Bee node and no postage stamp involved. `src/swarm.mjs`.

`@snaha/swarm-id` isn't used: `SwarmIdClient` is iframe-based browser auth, which a server
writing memories programmatically can't drive. Swarm's bounty brief explicitly allows the
plain gateway `fetch()` path.

Verified live: uploads with no batch header, an all-zero batch id, and a bogus batch id all
return 201. 1 MB and 5 MB round-trips come back byte-identical. The gateway stores ciphertext
only, since encryption happens before upload, confirmed by fetching a written reference back
and finding no plaintext in the raw bytes.

The one landmine is reference length. A plain reference is 64 hex chars. An encrypted one, via
Swarm's own `Swarm-Encrypt` header, is 128, which is exactly Arkiv's `MAX_STRING_BYTES`.
Prefixing `0x` makes 130 and `str()` rejects it. App-level encryption sidesteps this by
yielding plain 64-hex refs, but any switch to `Swarm-Encrypt` has to store refs without the
`0x` prefix.

What this isn't: durable. The gateway sponsors its own postage and may garbage-collect
content, and this build hasn't verified retention over time. Confidentiality is enforced
entirely by this app, which encrypts content before it reaches the gateway, so the gateway
never sees plaintext.

## Component 3: ENS (identity)

Two names, one per agent, `atlas-ethrome26.eth` and `nova-ethrome26.eth`, registered against
Sepolia's ENSv2 beta deployment. The original plan was one parent name plus a subname per
agent (`atlas.<parent>.eth`). These are flat top-level names instead, because subname creation
turned out to need a custom subregistry contract deployed, which didn't fit the time budget
this leg had. A registered ENSv2 name is a real agent identity either way, and the bounty
rewards depth of integration over any particular name shape.

A wallet address identifies a signer. A name identifies an agent other systems can look up,
independent of which key controls it at the moment. That's the "agent controlled namespace"
ENS's own brief asks for, and it's what makes the identity portable.

Registration path (`scripts/ens-register.mjs`): mint a test token, approve the registrar,
commit, wait for `MIN_COMMITMENT_AGE`, register. The first attempt reverted because a doc-page
summary had the registrar's `duration` parameter as `uint256` when the deployed contract takes
`uint64`. A different type means a different function selector, so it reverted silently and
told us nothing. Pulling the verified
ABI from Blockscout fixed it, and both names registered clean after that (tx hashes below).

Setting a profile text record is blocked, and it's a real architectural mismatch rather than a
bug on our side. `TextResolver.setText()` sits behind an `authorised(node)` modifier, which
calls `PublicResolverV2.isAuthorised()`, which calls `canModifyName()`. That function's first
step is `NAME_WRAPPER.names(node)`, a lookup against the ENSv1 NameWrapper contract, and it
returns `false` immediately when that comes back empty, before it ever checks real ownership.
Names registered natively through ENSv2's own `ETHRegistrar` never touch the v1 NameWrapper,
so the lookup returns `0x` for both names here (checked directly). The other resolver in the
Sepolia deployments table, `ENSV2Resolver`, is a read-only CCIP-read mirror that only forwards
lookups. Registration alone already satisfies "does real work" and "end-to-end on live testnet
data," so this wasn't pursued further.

## Evidence

The public deployment is `https://agent-memory-mesh.vercel.app`, permanent, under the project
owner's own Vercel account. The full write, Swarm, Arkiv, query round trip is verified live
there. The deployment-hash URL Vercel prints after `vercel deploy` 302s to Vercel's own SSO
login, since Deployment Protection is on by default, so the stable project-alias URL above is
the one to share.

ENS, ENSv2 beta on Sepolia. Owner of both names: `0x0Ef440b8C9Ce507Ce5f84c6b9EA7FB8b2C11a006`.

| Name | Register tx | Block |
|---|---|---|
| `atlas-ethrome26.eth` | [`0xe9c7380f9e07c85a2120f17df787891d088ba58ccadc8e8b9ba9f5a2c4abaa63`](https://sepolia.etherscan.io/tx/0xe9c7380f9e07c85a2120f17df787891d088ba58ccadc8e8b9ba9f5a2c4abaa63) | 11683692 |
| `nova-ethrome26.eth` | [`0xc7e9fa2fe1d25a026ef8fa8b4e15ca9d2a6cf159463f2d6e686f8cfea798b432`](https://sepolia.etherscan.io/tx/0xc7e9fa2fe1d25a026ef8fa8b4e15ca9d2a6cf159463f2d6e686f8cfea798b432) | 11683703 |

Contracts (Sepolia ENSv2 beta): `ETHRegistrar` `0xa88553f454b77203b0d036a05c894d555eaaa2cc`,
`MockUSDC` `0x768f42455a2d082e23ceef7d51e5787c82d67a39`,
`PublicResolverV2` `0xe7b9a25607e02da8145e4eb1836ca539e53f11f7` (set as resolver at
registration).

Arkiv, Tiramisu. Creator/owner wallet: `0x9F5997ecB905211a464F29090900468BDBa286C1`.

Write path, live: `agent_memory` entities created through `writeMemory` in `src/memory.mjs`,
which encrypts, uploads to Swarm, then creates the Arkiv entity. For example, entity
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
says they can. The tx landed a couple of blocks after the head was captured.

Mission 03, `server.mjs` plus `watchMemories` in `src/arkiv.mjs`, tested live end to end. A
`POST /api/memory` write triggered a real `EntityCreated` websocket event, a bounded
`getEntity` follow-up read, a Swarm fetch and decrypt, and a push to a connected client over
`/live`. That client had the decrypted content within about 6 seconds of the write.

Swarm. Gateway `api.gateway.ethswarm.org`, no postage stamp, no Bee node. Example reference
from a live write: `0246bf131185b1c5829616bb4932194734bbbf50ec91a976a5bdcd8612e11e6b` (64 hex,
plain reference). The round trip came back byte for byte identical.

## Setup

```bash
npm install
```

Two environment variables, both secrets. Never commit them, never paste them anywhere public.
Put them in a local `.env`, which is already gitignored:

```
ARKIV_PRIVATE_KEY=0x...   # a Tiramisu-funded wallet
MEMORY_ENC_KEY=...        # 32-byte hex (64 hex chars), encrypts memory content before it goes to Swarm
```

Generate a fresh `MEMORY_ENC_KEY`: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## Run locally

```bash
npm start
```

Opens on `http://localhost:3000`: a write form plus a live feed that updates over a real
websocket the moment any agent writes a memory. Open two browser tabs to watch it happen.
This is the Mission 03 artifact, and Evidence above has a recorded proof of one run.

## Scripts

- `npm run demo` (`scripts/run-demo.mjs`) chains Atlas remembering, Nova's cross-agent
  recall, a compound query, and the expiry demo below into one run. Needs `npm start` running
  in another terminal.
- `npm run demo:expiry` (`scripts/demo-expiry.mjs`) is the reproducible Mission 02 evidence:
  writes a short-lived memory, queries it (present), waits past its expiry block, queries
  again (gone), with no `deleteEntity` call anywhere.
- `npm run feedback:repro` (`scripts/feedback/`) runs every finding in
  [`feedback.md`](feedback.md) against the live network and prints the observed values. Add
  `-- 03` to run a single one. Each script exits 0 when its finding reproduced.
- `npm run ens:register -- <label>` (`scripts/ens-register.mjs`) registers a flat ENSv2 name
  on Sepolia through the commit-reveal flow. Needs `PRIVATE_KEY`, a Sepolia-funded wallet, in
  the environment.
- `npm run ens:set-text -- <label> "<text>"` (`scripts/ens-set-text.mjs`) attempts a profile
  text record on a registered name. Blocked by a real `PublicResolverV2` limitation; see
  Component 3 above.
- `npm run agent -- <atlas|nova> "<message>"` (`scripts/agent-chat.mjs`) talks to the mesh
  through a real Claude session with `remember`/`recall` tools, instead of a human filling out
  the write form. Needs `npm start` running in another terminal and `ANTHROPIC_API_KEY` set;
  see Real-agent proof above.

## Deploy

Live at https://agent-memory-mesh.vercel.app.

```bash
vercel deploy --yes -e ARKIV_PRIVATE_KEY=... -e MEMORY_ENC_KEY=...
```

Run `vercel login` first if you aren't already authenticated. The deployed version has no
persistent websocket, because Vercel's serverless functions can't hold one open, so the
frontend falls back to polling `/api/recent` every 3 seconds. The real subscription mechanism
runs locally; Evidence above records one end to end. One gotcha: the deployment-hash URL
Vercel prints after deploying sits behind Vercel's own SSO wall by default, so use the plain
project-alias URL above instead.
