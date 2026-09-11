# Agent Memory Mesh

ETHRome 2026 submission. Built for the Arkiv, Swarm, and ENS bounties.

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

Full product and technical reference: [`docs/PRODUCT.md`](docs/PRODUCT.md).
Build schedule, cut lines, qualification checklists: [`docs/build-plan.md`](docs/build-plan.md).

## Setup

```bash
npm install
```

## Status

Work in progress — built live during ETHRome 2026 (11–13 September, Rome).
