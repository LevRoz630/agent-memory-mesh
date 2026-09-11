# build-plan.md — Agent Memory Mesh

## The pitch, one sentence

An AI agent's memory is a typed, queryable, self-expiring index on Arkiv, with the actual
content stored portably and content-addressed on Swarm, under an ENSv2 name as identity —
so when one agent writes a memory, any other agent or app holding that identity can see it
update live, and short-term memory disappears from queries when it's supposed to, instead
of living forever in someone's database.

Maps onto language each sponsor used unprompted in their own brief: Swarm's
"portable AI memory that moves between assistants," ENS's "profiles for AI agents inside
an agent controlled namespace," Arkiv's own "extend on activity" / "let an entity lapse"
patterns.

## Bounties targeted

- **Arkiv** — Mission 02 (Built to expire), Mission 03 (Live wire), Best Use. Skipping
  Mission 01 — no pre-existing indexer to decommission.
- **Swarm** — real upload/retrieval, gateway, no Bee node.
- **ENS** — ENSv2 beta on Sepolia, name = agent identity.
- **Team1 — not pursued.** Wrong network (Avalanche) for this product.

## Architecture

```
Agent writes a memory
  → encrypt content
  → upload to Swarm → get content ref
  → create Arkiv entity: { agent_id, memory_type, tag, importance, swarm_ref, $expiresAt }

Second panel / process (the other "agent")
  → watchEntityEvents(webSocket transport, NO fromBlock)
  → sees the new entity the instant it's written, no refresh, no polling
  → resolves swarm_ref, fetches + decrypts from Swarm
  → renders it
```

Arkiv holds the index only. Swarm holds the content. That split is the answer to Arkiv's
own "not file storage, it's the index over your data" framing.

### Schema (`/arkiv/schema.md`)

| Attribute | Type | Purpose |
|---|---|---|
| `agent_id` | str | which agent (matches the ENS name's label) |
| `memory_type` | str | `fact` \| `task` \| `preference` \| `event` |
| `tag` | str | short topic string |
| `importance` | u64 | 0–10, range queries |
| `swarm_ref` | str | pointer to Swarm content, not the content |
| `$expiresAt` | native | TTL |

Demo queries: `agent_id=X AND memory_type=Y AND importance>=N`, `agent_id=X AND tag startsWith 'proj'`.

### ENS

Planned a parent name plus a subname per agent. Built instead: two flat top-level names,
`atlas-ethrome26.eth` and `nova-ethrome26.eth` — true subname creation needed a custom
subregistry contract, didn't fit the time budget. Registered clean after fixing a wrong ABI
(a doc summary had `duration` as `uint256`; the real contract takes `uint64`). Profile text
records are blocked by a real `PublicResolverV2` limitation, not pursued further — see
`docs/PRODUCT.md` Component 3 for the root cause.

## Cuts, in order, if time runs short

1. ENS entirely — weakest line of the three, costs a share of a $500 pool.
2. The "extend on activity" lease pattern — keep only "let it lapse" for Mission 02.
3. ENSv2 resolver depth (roles/delegation, text records) — registration alone still
   qualifies.
4. Swarm ID → plain gateway `fetch()` if it has rough edges.
5. Never cut: the live two-panel update (Mission 03 and the product demo, same artifact),
   or the public deployment (Arkiv's Tally form asks for a URL, not just a local demo).

## Demo content

Make the demo memories concrete and human-legible — an agent remembering a specific user
preference or task detail, not `{memory_type: "fact", tag: "x"}`. Free, and it's what makes
the cold 3-minute judge's first ten seconds land.

## Schedule (Europe/Rome)

| When | Status | Artifact |
|---|---|---|
| Fri 18:00 | Repo created, SDKs installed | |
| Fri 18:30 | Opening ceremony | |
| Fri 19:00 | Arkiv workshop | |
| Fri 19:30–20:30 | **Done** — both ENS names registered | `EVIDENCE.md` |
| Fri 21:00–22:30 | **Done** — schema + entity helpers | `arkiv/schema.md`, `src/arkiv.mjs` |
| Fri 22:30–00:00 | **Done** — Swarm integration | `src/swarm.mjs` |
| — | **Done** — write path | `src/memory.mjs` |
| — | **Done** — live subscription + full app | `server.mjs`, `public/index.html` |
| — | **Done** — expiry demo | `scripts/demo-expiry.mjs`, `EVIDENCE.md` |
| — | **Done** — friction report | `friction.md` |
| — | **Done** — public deployment | `agent-memory-mesh.vercel.app` |
| Sat | Sleep, then: final redeploy, rehearse the demo, re-check Arkiv/Swarm evidence | |
| Sun 09:00–09:45 | Fresh end-to-end run against the deployed URL, record the demo video (≤3 min, face on camera) | |
| Sun 09:45–10:00 | Submit both forms — ETHRome Google Form + Arkiv's Tally form | |
| Sun 10:30 | Judging | |

Everything through the Friday-night block finished a full day ahead of schedule; Saturday
is genuine slack, not catch-up.

## Corrected against `guides/ethrome-current`

Queried live via the arkiv-ethrome MCP mid-build — supersedes the hacker-manual text where
they conflict:

- No mandatory Saturday conversation with Arkiv.
- No hard schema.md gate — useful documentation, not a mandatory artifact.
- Arkiv's Tally form wants a public deployment URL, not just a local demo.
- Mission 02: use block-based expiration; record requested vs. applied duration separately
  (they can differ) — no websocket required for this mission.
- Mission 03: `watchEntityEvents` carries no attributes/payload, only change metadata —
  needs a bounded follow-up `getEntity` read.
- Mission 03 evidence should also show an irrelevant event *not* triggering a UI update,
  and disconnect/reconnect behavior.
- Evidence to prepare: creator wallet address, entity keys mapped to creation transactions,
  requested vs. applied expiry.
- Currency: hacker manual says USDC, MCP guidance says EUR — going with USDC.

## Qualification checklists

**Arkiv:** tick Arkiv + name missions · public repo · public deployment URL · `friction.md`
· creator wallet + entity key/tx evidence.

**Swarm:** public repo · short README · a demo · one line on future direction.

**ENS:** official ENSv2 beta contracts on Sepolia · real work, not decorative · end-to-end
on live testnet data, no hardcoded results · Sepolia names/addresses/tx links · demo +
architecture explanation at judging.

**ETHRome minimums:** open source · contract addresses for anything deployed · ≤3-minute
demo video, works logged out.

## Demo video script (3 minutes)

1. Who you are, what this is, one sentence each.
2. Agent A remembers something → encrypt, land on Swarm, index on Arkiv.
3. Agent B's screen updates with no refresh — the live-wire moment.
4. Fast-forward: a short-TTL memory disappears from a query, no delete call.
5. One line each on the ENS identity and why content lives on Swarm, not Arkiv.
