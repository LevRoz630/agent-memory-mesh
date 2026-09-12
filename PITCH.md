# Pitch prep — Agent Memory Mesh

Working notes for the live ≤3-minute demo/pitch. Submission-facing file: `README.md`.
Technical reference, architecture, and evidence: `README.md`. Ordered by judging weight.

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

Two one-liners the ENS and Swarm bounties want said out loud at judging:
- ENS: the identity is a portable name — an agent other systems can look up independent
  of who currently controls the underlying key.
- Swarm: content lives on Swarm; Arkiv stays the index — metadata and expiry only, no
  bulk storage.

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

Line: "We filed 4 Arkiv findings this build, each with a runnable script — full report
in `feedback.md`."

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
  `src/arkiv.mjs`. Strong, fresh, verified-live finding. Worth adding to `feedback.md`?
  That workstream just trimmed it to 4 findings, so this is a call for whoever owns it.
- **`scripts/feedback/05` through `09` are now orphaned** — `feedback.md` was just
  trimmed to findings 1–4 (nonce manager, typed-wrapper, attribute validation,
  not-found ambiguity), but the reconnect/Swarm repro scripts (05–09) still exist and
  still run via `npm run feedback:repro`. Intentional cut, or worth restoring a line for
  each?
- **Physical setup:** two windows/screens vs. switching on one, for the terminal + browser
  beats.
- **Who presents which section.**
- **`hub.arkiv.network/ethrome` has changed mid-event before** — worth one more check
  before judging.
