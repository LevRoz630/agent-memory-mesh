# Agent Memory Mesh

ETHRome 2026 submission. Built for the Arkiv, Swarm, and ENS bounties.

An AI agent's memory, implemented as three separate concerns instead of one database:

- **Identity** — an ENSv2 name on Sepolia. The agent's name is not a display string, it's
  the thing other systems resolve to find the agent. (Registered as flat top-level names —
  `atlas-ethrome26.eth`, `nova-ethrome26.eth` — rather than subnames under one parent; see
  `docs/PRODUCT.md` Component 3 for why.)
- **Content** — encrypted, content-addressed blobs on Swarm. The actual memory: what the
  agent knows, what it was told, what it decided.
- **Index** — typed, queryable, expiring records on Arkiv. Not the memory itself, a pointer
  to it plus enough metadata to search, filter, and decide when it should disappear.

Two agent instances demonstrate it: one writes a memory, the other's view of the world
updates without a refresh, over a live subscription, not a polling loop. A short-lived
memory expires from queries on its own, with no delete call, because its lease ran out.

Full product and technical reference: [`docs/PRODUCT.md`](docs/PRODUCT.md).
Build schedule, cut lines, qualification checklists: [`docs/build-plan.md`](docs/build-plan.md).
Real addresses, transaction hashes, deployment URL: [`EVIDENCE.md`](EVIDENCE.md).
Bugs and rough edges hit along the way: [`friction.md`](friction.md).

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
node --env-file=.env server.mjs
```

Opens on `http://localhost:3000` — a write form plus a live feed that updates over a real
websocket the moment any agent writes a memory (open two browser tabs to see it). This is
the actual Mission 03 artifact; see `EVIDENCE.md` for a recorded proof.

## Scripts

- `scripts/demo-expiry.mjs` — Mission 02 evidence, reproducible: writes a short-lived
  memory, queries it (present), waits past its expiry block, queries again (gone), with no
  `deleteEntity` call anywhere.
- `scripts/ens-register.mjs <label>` — registers a flat ENSv2 name on Sepolia (commit-reveal
  flow). Needs `PRIVATE_KEY` (a Sepolia-funded wallet) in the environment.
- `scripts/ens-set-text.mjs` — attempts a profile text record on a registered name. Blocked
  by a real `PublicResolverV2` limitation; see `friction.md`.

## Deploy

```bash
vercel deploy --temporary --yes -e ARKIV_PRIVATE_KEY=... -e MEMORY_ENC_KEY=...
```

No login needed for a temporary (60-minute) deployment; `vercel login` first for a
permanent one. The deployed version has no persistent websocket (Vercel's serverless
functions can't hold one) — the frontend automatically falls back to polling
`/api/recent` every 3 seconds instead. The real subscription mechanism is demonstrated
locally; see `docs/PRODUCT.md`'s architecture section and `EVIDENCE.md`.

## Status

Built live during ETHRome 2026 (11–13 September, Rome). See `docs/build-plan.md` for
where things stand against the schedule.
