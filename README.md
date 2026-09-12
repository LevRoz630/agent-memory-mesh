# Agent Memory Mesh

ETHRome 2026 submission. Built for the Arkiv, Swarm, and ENS bounties.

An AI agent's memory, implemented as three separate concerns instead of one database:

- **Identity** — an ENSv2 name on Sepolia: the thing other systems resolve to find the
  agent. (Registered as flat top-level names —
  `atlas-ethrome26.eth`, `nova-ethrome26.eth` — rather than subnames under one parent; see
  `NOTES.md` Component 3 for why.)
- **Content** — encrypted, content-addressed blobs on Swarm. The actual memory: what the
  agent knows, what it was told, what it decided.
- **Index** — typed, queryable, expiring records on Arkiv: a pointer to the content plus
  enough metadata to search, filter, and decide when it should disappear.

Two agent instances demonstrate it: one writes a memory, the other's view of the world
updates without a refresh, over a live websocket subscription. A short-lived
memory expires from queries on its own, with no delete call, because its lease ran out.

Full architecture, schema, evidence (addresses, tx hashes), and demo script:
[`NOTES.md`](NOTES.md).
Arkiv feedback report: [`feedback.md`](feedback.md).

## Who this is for

Teams building multi-agent AI systems for enterprises hit this exact wall: agent memory
locked to one framework's session store, no native expiry, no identity separate from an
API key. This is a live problem for us specifically — we're building an AI agentic
deployment for enterprises at the HPE & NVIDIA Agentic AI Hackathon (HPE Geneva Customer
Innovation Center, Sept 14 2026, part of Swiss {ai} Weeks), presenting to the companies in
the room, and Agent Memory Mesh is the memory layer for that deployment.

Path to the first 100 users: the repo is public now, so that event's own agent builders
can point at it directly; the pattern is framework-agnostic — an ENS name plus a Swarm
reference reads from any client, fitting LangChain, CrewAI, or AutoGen-style builders
equally; and we reuse it ourselves at every hackathon after this one.

## Setup

```bash
npm install
```

Needs two environment variables, both secrets — never commit them, never paste them
anywhere public. Put them in a local `.env` (already gitignored):

```
ARKIV_PRIVATE_KEY=0x...   # a Tiramisu-funded wallet
MEMORY_ENC_KEY=...        # 32-byte hex (64 hex chars) — encrypts memory content before it goes to Swarm
```

Generate a fresh `MEMORY_ENC_KEY`: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## Run locally

```bash
npm start
```

Opens on `http://localhost:3000` — a write form plus a live feed that updates over a real
websocket the moment any agent writes a memory (open two browser tabs to see it). This is
the actual Mission 03 artifact; see `NOTES.md` for a recorded proof.

## Scripts

- `npm run demo` (`scripts/run-demo.mjs`) — the one-command version: chains Atlas
  remembering, Nova's cross-agent recall, a compound query, and the expiry demo below.
  Needs `npm start` running in another terminal.
- `npm run demo:expiry` (`scripts/demo-expiry.mjs`) — Mission 02 evidence, reproducible:
  writes a short-lived memory, queries it (present), waits past its expiry block, queries
  again (gone), with no `deleteEntity` call anywhere.
- `npm run feedback:repro` (`scripts/feedback/`) — runs every finding in
  [`feedback.md`](feedback.md) against the live network and prints the observed values. Add
  `-- 03` to run a single one. Each script exits 0 when its finding reproduced.
- `npm run ens:register -- <label>` (`scripts/ens-register.mjs`) — registers a flat ENSv2
  name on Sepolia (commit-reveal flow). Needs `PRIVATE_KEY` (a Sepolia-funded wallet) in the
  environment.
- `npm run ens:set-text -- <label> "<text>"` (`scripts/ens-set-text.mjs`) — attempts a
  profile text record on a registered name. Blocked by a real `PublicResolverV2`
  limitation; see `NOTES.md`.
- `npm run agent -- <atlas|nova> "<message>"` (`scripts/agent-chat.mjs`) — talks to the
  mesh through a real Claude session with `remember`/`recall` tools, instead of a human
  filling out the write form. Needs `npm start` running in another terminal and
  `ANTHROPIC_API_KEY` set; see `NOTES.md`.

## Deploy

Live at **https://agent-memory-mesh.vercel.app**.

```bash
vercel deploy --yes -e ARKIV_PRIVATE_KEY=... -e MEMORY_ENC_KEY=...
```

(`vercel login` first if not already authenticated.) The deployed version has no
persistent websocket (Vercel's serverless functions can't hold one) — the frontend
automatically falls back to polling `/api/recent` every 3 seconds instead. The real
subscription mechanism is demonstrated locally; see `NOTES.md`. Note: the deployment-hash
URL Vercel prints after deploying is behind Vercel's own SSO wall by default — use the
plain project-alias URL above instead.
