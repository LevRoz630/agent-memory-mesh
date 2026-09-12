# Pitch prep — Agent Memory Mesh

Working notes for the live ≤3-minute demo/pitch, not the submission-facing file (that's
`README.md`) or the technical reference (`NOTES.md`). Ordered by what's actually weighted
in judging, not chronologically — see the scoring table in `NOTES.md`.

## Structure, ordered by judging weight

### 1. Why Arkiv / Web3 database — 30% — open here

Talking point: multi-agent memory needs to answer three things a Web2 DB fakes — who owns
this memory across host apps, what happens to memory that shouldn't persist forever
(without a cron job), and how a second process learns something changed without polling.
Arkiv answers the second natively (real expiry, no delete call); the websocket layer
answers the third.

- [ ] tighten this to one sentence for the opening line
- Target: ~25–30s

### 2. Technical execution — 25% — the live demo

Beats (full script in `NOTES.md`):
0. Terminal on one side, mission-control page open on the other. `npm run agent -- atlas
   "remember that I prefer dark mode and 24-hour time"` — a real Claude session decides
   to call `remember`, the panel's live feed and event log update on the real websocket
   as it happens. This is the beat that answers "does an actual agent use this" — not
   asserted, shown: a model deciding to call a tool, not a human clicking a button.
1. Fresh process: `npm run agent -- nova "..."` — Nova's independent session decides to
   query `agentId: atlas` and recalls what Atlas just stored — cross-agent, cross-session,
   proving the "portable memory" claim rather than stating it.
2. Compound query live in the browser: `agent_id = X AND memory_type = Y AND importance
   >= N`.
3. Short-lived memory disappears from that same query, no delete call in the code shown
   (Mission 02) — show requested vs. applied expiry from the receipt.
4. One irrelevant event that does *not* update the live panel — proves the filter is real.

- [ ] decide: two browser tabs side by side, or two separate windows/screens for the
      browser-driven beats?
- [ ] rehearse the agent commands once beforehand — model wording varies run to run
- Target: ~90–110s

### 3. Usefulness and adoption potential — 20% — currently the weakest section, nail this

Draft answer (from working session, needs a read-through before it's final):

> Teams building multi-agent AI systems for enterprises hit this exact wall — agent memory
> locked to one framework's session store, no native expiry, no identity separate from an
> API key. We're not guessing at that problem: we're building an AI agentic deployment for
> enterprises at the **HPE & NVIDIA Agentic AI Hackathon** (HPE Geneva Customer Innovation
> Center, Sept 14 2026, part of Swiss {ai} Weeks), presenting to the companies in the room
> as part of the solution — Agent Memory Mesh is the memory layer for that deployment. Path
> to the first 100: open-source now so that event's own agent builders can point at it
> directly, publish the pattern into framework-agnostic agent communities (LangChain/
> CrewAI/AutoGen-style builders — the ENS+Swarm reference is readable by any client, not
> tied to one runtime), and reuse it ourselves at every hackathon after this one.

- [ ] confirm comfort naming HPE/NVIDIA explicitly before this goes in `README.md` or on camera
- [ ] one sentence, not the whole paragraph, for the spoken version
- Target: ~30s

### 4. Arkiv feedback — 25% — close

- Name it explicitly: "we filed N reproducible findings against the SDK during this build —
  full report in `feedback.md`."
- Pick 1–2 headline findings worth saying out loud (candidates as of now: the nonce-manager
  gap on concurrent writes from one wallet, the typed-wrapper read/write asymmetry).
- This criterion is scored from the file, not the video — saying it out loud just claims
  credit for work that's otherwise invisible in a 3-minute clip.
- Target: ~15–20s

## Timing budget (≤3:00)

| Section | Target |
|---|---|
| Why Arkiv | 0:00–0:25 |
| Technical demo (now includes the agent beats) | 0:25–2:15 |
| Usefulness/adoption | 2:15–2:40 |
| Arkiv feedback | 2:40–3:00 |

## Open items

- [ ] rehearse once against the deployed URL, not localhost, before recording
- [ ] decide who presents which section
- [ ] finalize the usefulness paragraph above and copy the agreed version into `README.md`
- [ ] re-check `hub.arkiv.network/ethrome` once more before judging — noted in `NOTES.md`
      as a page that's changed mid-event before
