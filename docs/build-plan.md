# build-plan.md — Agent Memory Mesh

## The pitch, one sentence

An AI agent's memory is a typed, queryable, self-expiring index on Arkiv, with the actual
content stored portably and content-addressed on Swarm, under an ENSv2 subname identity —
so when one agent writes a memory, any other agent or app holding that identity can see it
update live, and short-term memory genuinely disappears from queries when it's supposed to,
instead of living forever in someone's database.

Maps directly onto language each sponsor used unprompted in their own brief: Swarm's
"portable AI memory that moves between assistants," ENS's "profiles for AI agents inside
an agent controlled namespace," Arkiv's own "extend on activity" / "let an entity lapse"
patterns.

## Bounties targeted — and the one skipped

- **Arkiv** — Mission 02 (Built to expire), Mission 03 (Live wire), Best Use overall.
  **Skip Mission 01** — no pre-existing indexer exists to decommission; inventing one to
  turn off is explicitly against the brief's own guidance.
- **Swarm** — real upload/retrieval via Swarm ID (gateway, no Bee node).
- **ENS** — ENSv2 beta on Sepolia, subname = agent identity, resolver = agent profile.
- **Team1 — not pursued.** Wrong network (Fuji/Avalanche) for this product; forcing it in
  would dilute the demo for no clean narrative fit.

## Architecture

```
Agent writes a memory
  → encrypt content
  → upload to Swarm (Swarm ID, gateway, no stamp/Bee node) → get content ref
  → create Arkiv entity: { agentId, memoryType, tag, importance, swarmRef, $expiresAt }
  → (short-lived memories: $expiresAt ~60-90s for the demo)

Second panel / process (the other "agent")
  → watchEntityEvents(webSocket transport, NO fromBlock)
  → sees the new entity the instant it's written, no refresh, no polling
  → resolves swarmRef, fetches + decrypts from Swarm
  → renders it
```

Arkiv holds the **index only** — small, typed, queryable, expiring. Swarm holds the
**content** — bulk, content-addressed, portable. This split is the actual answer to
Arkiv's own "not file storage, think of it as the index over your data" guidance, and
it's the headline of the Arkiv fit-and-trade-offs write-up.

### Draft schema (`/arkiv/schema.md`)

Entity type `agent_memory`:

| Attribute | Type | Purpose |
|---|---|---|
| `agentId` | str | which agent identity (matches the ENS subname label) |
| `memoryType` | str | `fact` \| `task` \| `preference` \| `event` |
| `tag` | str | short topic/category string |
| `importance` | u64 | 0–10 salience, enables range queries |
| `swarmRef` | str | Swarm content hash — the pointer, not the content |
| `$expiresAt` | native | TTL; short for "working memory," extended for anything durable |

Demo queries for the judging session (compound, not id lookup):
`agentId=X AND memoryType=Y AND importance>=N`, `agentId=X AND tag startsWith 'proj'`.

### ENSv2 leg

One parent name, two agent subnames (`atlas.<parent>.eth`, `nova.<parent>.eth`) on the
Sepolia beta deployment. Resolver text record on each holds a short agent profile string.
Depth-of-integration story: **the subname is the identity**, not a lookup.

**Known friction, front-load it:** registering a subname needs minting a test token,
approving the registrar, then registering — three transactions before you have a name,
and ENSv2's write flows are explicitly flagged by their own docs as "may still change
before mainnet." This is the one leg with zero prior validated code. Do it **first**, so
any beta surprise is absorbed early rather than discovered later on the critical path.

## Cuts, in order, if time runs short

1. **ENS entirely** — weakest EV line of the three (hard 60-min cap, drop if it resists).
   Losing it costs a share of a $500 pool; Arkiv+Swarm alone still makes a complete,
   judgeable product.
2. Drop the "extend on activity" long-term-memory lease pattern — keep only the
   "let it lapse" pattern for Mission 02. One pattern, well demonstrated, beats two half-done.
3. Drop ENSv2 resolver depth (roles/delegation) — a single subname + one text record still
   qualifies ("does real work," "end-to-end on live testnet data"), it's just not maximal.
4. If Swarm ID has rough edges, fall back to a plain gateway `fetch()` — the brief
   explicitly allows this if you say why in the README.
5. Never cut: the live two-panel update (it's simultaneously Mission 03's exact ask and
   the whole product demo), and the Saturday 20:00 Arkiv conversation (hard deadline,
   cannot move to Sunday).

## Demo content

Make the demo memories concrete and human-legible, not abstract placeholders. Not
`{memoryType: "fact", tag: "x"}` — something like an agent remembering a specific user
preference or a specific task detail that a viewer immediately understands the value of
losing/keeping. Costs nothing, keeps every mechanic identical, makes the cold 3-minute
judge's first ten seconds land.

## Schedule (Europe/Rome, all times from the official hacker manual)

| When | Do | Why now |
|---|---|---|
| Fri 18:00 | New public repo, `npm init`, install SDKs. Hacking clock starts. | |
| Fri 18:30 | **Opening ceremony** — attend, don't skip | bounties get explained live |
| Fri 19:00 | **Arkiv workshop** — attend | leaves you with schema.md draft, requirement 1 done in 20 min |
| Fri 19:30–20:30 | **ENSv2 registration, hard-capped at 60 min**: mint test token → approve → register parent + 2 subnames on Sepolia. If the 3-tx flow isn't through by 20:30, **stop and drop ENS** — ship Arkiv+Swarm only and reclaim the time | weakest EV line of the three (beta contracts, "may still change" warning, pool "splits up to five ways") — front-load it, but don't let it eat the night |
| Fri 21:00–22:30 | Finalize `/arkiv/schema.md`; write entity create/query helpers | |
| Fri 22:30–00:00 | Swarm ID integration; one encrypted upload/retrieval round trip | |
| Fri 00:00 | Commit, sleep | protect Sunday-morning judgment |
| Sat 09:00–13:00 | Write path: encrypt → Swarm upload → Arkiv entity with `$expiresAt` | |
| Sat 14:00–17:00 | **Live subscription leg** — websocket watcher, no `fromBlock`, second panel updates in real time | this *is* Mission 03 and the product demo, same artifact |
| Sat 17:00–19:00 | Expiry demo — short-TTL memory, query before/after boundary, no delete call | Mission 02 |
| Sat 19:00–19:30 | Bug buffer; write/date `friction.md` from what actually broke this weekend | |
| **Sat 19:30–20:00** | **Mandatory 10-min Arkiv conversation, hand over repo URL** | hard deadline, cannot slip |
| Sat 20:00–21:00 | Dinner | |
| Sat 21:00–00:00 | README, compound-query demo, schema.md trade-off writeup, resolver polish | |
| Sat 00:00 | Sleep | |
| Sun 09:00–09:45 | Full fresh end-to-end run-through; record demo video (≤3 min, landscape, face on camera) | |
| Sun 09:45–10:00 | Submit: tick Arkiv (name M02+M03), Swarm, ENS; repo link, video link, Sepolia + Tiramisu addresses/tx links | |
| Sun 10:30 | Judging — walk Arkiv + Swarm mentors and general judges through it | |

## Qualification checklists (from the live brief)

**Arkiv:** tick Arkiv + name missions · public repo · draft `/arkiv/schema.md` · `friction.md` ·
10-min conversation by Sat 20:00.

**Swarm:** public repo (open license appreciated) · short README · a demo · one line on
where you'd take it next.

**ENS:** talks to official ENSv2 beta contracts on Sepolia · does real work, not decorative ·
end-to-end on live testnet data, no hardcoded names/results · repo · Sepolia names/contract
addresses/tx links · working demo or video + architecture explanation at judging.

**ETHRome minimums (all projects):** open source · contract addresses for anything deployed
on chain · ≤3-minute demo video, works logged out.

## Demo video script (3 minutes)

1. One sentence on who you are, one sentence on what this is.
2. Agent A "remembers" something → show it encrypt, land on Swarm, index on Arkiv.
3. Agent B's screen updates **with no refresh** — this is the live-wire moment.
4. Fast-forward: a short-TTL memory disappears from a query with no delete call.
5. One line each on the ENS subname identity and why the content lives on Swarm, not Arkiv.
