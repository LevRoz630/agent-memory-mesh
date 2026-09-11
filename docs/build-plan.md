# build-plan.md — Agent Memory Mesh

## The pitch, one sentence

An AI agent's memory is a typed, queryable, self-expiring index on Arkiv, with the actual
content stored portably and content-addressed on Swarm, under an ENSv2 subname identity —
so when one agent writes a memory, any other agent or app holding that identity can see it
update live, and short-term memory disappears from queries when it's supposed to, instead
of living forever in someone's database.

Maps onto language each sponsor used unprompted in their own brief: Swarm's
"portable AI memory that moves between assistants," ENS's "profiles for AI agents inside
an agent controlled namespace," Arkiv's own "extend on activity" / "let an entity lapse"
patterns.

## Bounties targeted — and the one skipped

- **Arkiv** — Mission 02 (Built to expire), Mission 03 (Live wire), Best Use overall.
  **Skip Mission 01** — no pre-existing indexer exists to decommission; inventing one to
  turn off is against the brief's own guidance.
- **Swarm** — real upload/retrieval via Swarm ID (gateway, no Bee node).
- **ENS** — ENSv2 beta on Sepolia, subname = agent identity, resolver = agent profile.
- **Team1 — not pursued.** Wrong network (Fuji/Avalanche) for this product; forcing it in
  would dilute the demo for no clean narrative fit.

## Architecture

```
Agent writes a memory
  → encrypt content
  → upload to Swarm (Swarm ID, gateway, no stamp/Bee node) → get content ref
  → create Arkiv entity: { agent_id, memory_type, tag, importance, swarm_ref, $expiresAt }
  → (short-lived memories: $expiresAt ~60-90s for the demo)

Second panel / process (the other "agent")
  → watchEntityEvents(webSocket transport, NO fromBlock)
  → sees the new entity the instant it's written, no refresh, no polling
  → resolves swarm_ref, fetches + decrypts from Swarm
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
| `agent_id` | str | which agent identity (matches the ENS subname label) |
| `memory_type` | str | `fact` \| `task` \| `preference` \| `event` |
| `tag` | str | short topic/category string |
| `importance` | u64 | 0–10 salience, enables range queries |
| `swarm_ref` | str | Swarm content hash — the pointer, not the content |
| `$expiresAt` | native | TTL; short for "working memory," extended for anything durable |

Demo queries for the judging session (compound, not id lookup):
`agent_id=X AND memory_type=Y AND importance>=N`, `agent_id=X AND tag startsWith 'proj'`.

### ENSv2 leg

One parent name, two agent subnames (`atlas.<parent>.eth`, `nova.<parent>.eth`) on the
Sepolia beta deployment. Resolver text record on each holds a short agent profile string.
Depth-of-integration story: **the subname is the identity**, not a lookup.

**Known friction, front-load it:** registering a subname needs minting a test token,
approving the registrar, then registering — three transactions before you have a name,
and ENSv2's write flows are flagged by their own docs as "may still change before
mainnet." This is the one leg with zero prior validated code. Do it **first**, so
any beta surprise is absorbed early rather than discovered later on the critical path.

## Cuts, in order, if time runs short

1. **ENS entirely** — weakest EV line of the three (hard 60-min cap, drop if it resists).
   Losing it costs a share of a $500 pool; Arkiv+Swarm alone still makes a complete,
   judgeable product.
2. Drop the "extend on activity" long-term-memory lease pattern — keep only the
   "let it lapse" pattern for Mission 02. One pattern, well demonstrated, beats two half-done.
3. Drop ENSv2 resolver depth (roles/delegation) — a single subname + one text record still
   qualifies ("does real work," "end-to-end on live testnet data"), it's just not maximal.
4. If Swarm ID has rough edges, fall back to a plain gateway `fetch()` — the brief allows
   this if you say why in the README.
5. Never cut: the live two-panel update (it's simultaneously Mission 03's exact ask and
   the whole product demo), and a public deployment of the app (Arkiv's own submission
   form asks for a deployment URL, not just a local demo).

## Demo content

Make the demo memories concrete and human-legible, not abstract placeholders. Not
`{memory_type: "fact", tag: "x"}` — something like an agent remembering a specific user
preference or a specific task detail that a viewer immediately understands the value of
losing/keeping. Costs nothing, keeps every mechanic identical, makes the cold 3-minute
judge's first ten seconds land.

## Schedule (Europe/Rome, all times from the official hacker manual)

| When | Do | Why now |
|---|---|---|
| Fri 18:00 | New public repo, `npm init`, install SDKs. Hacking clock starts. | |
| Fri 18:30 | **Opening ceremony** — attend, don't skip | bounties get explained live |
| Fri 19:00 | **Arkiv workshop** — attend | leaves you with schema.md draft, requirement 1 done in 20 min |
| Fri 19:30–20:30 | ~~ENSv2 registration, hard-capped at 60 min~~ **DONE** — `atlas-ethrome26.eth` + `nova-ethrome26.eth` registered on Sepolia, see `EVIDENCE.md`. First attempt hit a wrong ABI (doc-summary had `duration` as `uint256`; the real deployed contract takes `uint64`) — fixed against Blockscout's verified ABI, both names registered clean on the second try | weakest EV line of the three going in; came in well under the cap once the ABI was right |
| Fri 21:00–22:30 | ~~Finalize `/arkiv/schema.md`; write entity create/query helpers~~ **DONE** — `arkiv/schema.md` written and iterated against `check_schema`; `src/arkiv.mjs` verified against the SDK's shipped source, not docs | |
| Fri 22:30–00:00 | ~~Swarm integration~~ **DONE, ahead of schedule** — `src/swarm.mjs`, app-level AES-256-GCM before upload (`@snaha/swarm-id` turned out browser-only, gateway `fetch()` instead, justified in `friction.md`) | |
| — | ~~Write path~~ **DONE** — `src/memory.mjs`, full encrypt→Swarm→Arkiv round trip verified live | moved up from the planned Sat 09:00–13:00 slot, everything so far went faster than budgeted |
| — | ~~Live subscription leg + the whole app~~ **DONE** — `server.mjs` + `public/index.html`, real websocket push verified end-to-end with a test client (write via curl, decrypted content arrives over `/live` in ~6s) | moved up from the planned Sat 14:00–17:00 slot; this *is* Mission 03 and the product demo, same artifact |
| — | ~~Expiry demo~~ **DONE** — `scripts/demo-expiry.mjs`, run live: 1 row before the boundary, 0 after, zero `deleteEntity` calls, requested/applied expiry recorded in `EVIDENCE.md` | moved up from the planned Sat 17:00–19:00 slot; Mission 02 |
| — | ~~`friction.md`~~ **DONE**, written fresh with real findings from this session, not the pre-flight draft | moved up from the planned Sat 19:00–19:30 slot |
| — | ~~Deploy publicly~~ **DONE** — live on Vercel (`--temporary`, see `EVIDENCE.md` for the URL and the real deploy failure it took to get there), REST verified end-to-end against the deployed URL | moved up from the planned Sat 19:30–21:00 slot |
| Sat (whenever this lands) | Sleep, then: set ENS text records if time allows (currently blocked, see `friction.md`), redeploy/claim the Vercel deployment closer to Sunday since the temporary one expires, rehearse the demo | everything core is done a full day ahead of the original schedule — remaining time is slack, not catch-up |
| Sun 09:00–09:45 | Full fresh end-to-end run-through against the deployed URL; record demo video (≤3 min, landscape, face on camera) — optional for Arkiv's own form but required for ETHRome's general submission | |
| Sun 09:45–10:00 | Submit both forms: ETHRome Google Form (repo, video, contract addresses) and Arkiv's Tally form (repo, deployment URL, missions completed, creator wallet + entity keys/tx hashes, feedback.md link) | |
| Sun 10:30 | Judging — walk Arkiv + Swarm mentors and general judges through it | |

## Corrected against `guides/ethrome-current` (queried live via the arkiv-ethrome MCP,
mid-build — this supersedes the hacker-manual mission-page text above where they conflict)

- **No mandatory Saturday conversation.** The current guidance explicitly says not to
  restore "the compulsory Saturday conversation... old deadlines." Dropped from the
  schedule above.
- **No hard schema.md gate**, confirmed again — `arkiv/submission.md`/`schema.md` is
  "useful project documentation," not a mandatory artifact.
- **Public deployment required for Arkiv's own Tally form** — a deployment URL (their
  form suggests Vercel), not just a local demo. Video is optional *for that form* but
  still required for ETHRome's own general submission (Google Form).
- **Mission 02 correction:** use block-based expiration
  (`ExpirationTime.fromBlocks(n)`), and record the *requested* duration separately from
  the *applied* expiration height returned by the creation receipt — they can differ.
  Confirmed: Mission 02 does not itself require a websocket.
- **Mission 03 correction, architecturally real:** the `watchEntityEvents` callback does
  **not** carry entity attributes or payload — only change metadata (e.g. owner). Treat
  that as an initial relevance filter only, then do a bounded follow-up `getEntity` read
  to fetch the actual attributes (`swarm_ref`, etc.). The write path in this doc's
  architecture section needs that explicit read step added, not "receives the new entity"
  as if attributes ride along with the event.
- **Mission 03 demo, additional asks:** show an irrelevant change that does *not* trigger
  a UI update (proves the filter is real, not just "something happened"), and test/record
  disconnect + reconnect behavior, and stop the watcher on unmount.
- **Evidence to prepare:** public Tiramisu creator-wallet address(es), entity keys mapped
  to their creation transactions, and for Mission 02 both the requested and applied
  expiration values from the receipt.
- **Currency discrepancy, resolved by assumption:** hacker manual says USDC, MCP guidance
  says "EUR 2,500" — treating the EUR figure as the MCP doc's mistake, going with USDC
  per the manual (matches the confirmed Sept 3 rail). Not worth spending workshop time
  confirming; doesn't change anything about how the app gets built.

## Qualification checklists

**Arkiv:** tick Arkiv + name missions · public repo · public deployment URL · `friction.md`
(or `feedback.md`) linked · creator wallet + entity key/tx evidence.

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
