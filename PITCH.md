# Pitch prep — Agent Memory Mesh

Working notes for the live ≤3-minute demo/pitch. Submission-facing file: `README.md`.
Technical reference: `NOTES.md`. Ordered by judging weight.

## 1. Why Arkiv / Web3 database — 30%

Opening line: "Agent memory needs three things a normal database fakes: whose it is
across apps, when it should disappear, and how another process learns it changed. Arkiv
gives us the first two natively — expiry with no delete call — and the same websocket
gives us the third."

Target: ~25s

## 2. Technical execution — 25%

`npm run demo` runs this whole sequence (mission-control page open in the browser):

1. Atlas remembers — a real Claude session decides to call `remember`; the live feed and
   event log update over the real websocket as it happens.
2. Nova recalls, an independent session — decides to query `agentId: atlas` and finds
   what Atlas stored: cross-agent, cross-session, live.
3. Compound query: `agent_id = X AND memory_type = Y AND importance >= N`.
4. The memory disappears from that same query on its own — no delete call anywhere
   (Mission 02); requested vs. applied expiry visible from the receipt.

Not automated, point at it manually: one irrelevant chain event that doesn't touch the
live panel — the code that proves the filter is real.

- [ ] rehearse `npm run demo` once beforehand — model wording varies run to run
- [ ] two windows side by side, or switch between terminal/browser on one screen?

Target: ~90–110s

## 3. Usefulness and adoption — 20%

Full paragraph lives in `README.md`, "Who this is for." Spoken version: "We're solving
this for ourselves first — Agent Memory Mesh is the memory layer for the AI agentic
deployment we're building at the HPE & NVIDIA hackathon in Geneva, two days from now,
open-sourced so any agent builder there, on any framework, can point at it directly."

Target: ~30s

## 4. Arkiv feedback — 25%

Line: "We filed 5 Arkiv findings and 4 Swarm reproductions this build, each with a
runnable script — full report in `feedback.md`."

Headline finding to say out loud: the nonce-manager gap — 1/6 concurrent writes from one
wallet landed without it, 6/6 with it. Second choice if there's time: the typed-wrapper
read/write asymmetry (write takes `str()`/`u64()`, read hands back `{type, value}`).

This criterion scores from `feedback.md` itself — naming it out loud just claims credit
for otherwise-invisible work.

Target: ~15–20s

## Timing budget (≤3:00)

| Section | Target |
|---|---|
| Why Arkiv | 0:00–0:25 |
| Technical demo | 0:25–2:15 |
| Usefulness/adoption | 2:15–2:40 |
| Arkiv feedback | 2:40–3:00 |

## Gaps to discuss

- **Undocumented Arkiv finding:** `select('*')` silently omits `owner` on the live
  Tiramisu node even though the SDK correctly requests it — found and fixed today in
  `src/arkiv.mjs`. Strong, fresh, verified-live finding. Worth adding to
  `feedback.md`/`scripts/feedback/` before submission? That directory is a separate
  active workstream, flagging it here instead of editing it directly.
- **Physical setup:** two windows/screens vs. switching on one, for the terminal + browser
  beats.
- **Who presents which section.**
- **`hub.arkiv.network/ethrome` has changed mid-event before** (noted in `NOTES.md`) —
  worth one more check before judging.
