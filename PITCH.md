# Pitch prep: Agent Memory Mesh

Working notes for the live pitch, three minutes maximum. Everything submission-facing lives
in `README.md`: architecture, technical reference, evidence. Sections below run in order of
judging weight.

## 1. Why Arkiv / Web3 database (30%)

Opening line: "Agent memory needs three things a normal database fakes: whose it is across
apps, when it should disappear, and how another process learns it changed. Arkiv gives us
the first two natively, expiry without a delete call, and the same websocket gives us the
third."

Target: ~25s

## 2. Technical execution (25%)

`npm run demo` runs the whole sequence, mission-control page open in the browser:

1. Atlas remembers. A real Claude session decides to call `remember`, and the live feed and
   event log update over the websocket while it happens.
2. Nova recalls from an independent session. It decides to query `agentId: atlas` and finds
   what Atlas stored, from a different process it has never talked to.
3. Compound query: `agent_id = X AND memory_type = Y AND importance >= N`.
4. The memory drops out of that same query on its own, because its lease ran out. The receipt
   shows both the requested and the applied expiry.

One beat the script won't hit for us: the irrelevant chain event that never touches the live
panel. That's the code proving the filter is real, so point at it manually.

The ENS and Swarm bounties each want a sentence said out loud at judging:

- ENS: the identity is a portable name. Other systems can look the agent up without caring
  which key controls it right now.
- Swarm: content lives on Swarm and Arkiv stays the index, holding metadata and expiry only.

- [ ] rehearse `npm run demo` once beforehand, since the model's wording shifts run to run
- [ ] two windows side by side, or switch between terminal and browser on one screen?

Target: ~90–110s

## 3. Usefulness and adoption (20%)

Full paragraph is in `README.md` under "Who this is for." Spoken version: "We're solving
this for ourselves first. Agent Memory Mesh is the memory layer for the AI agentic
deployment we're building at the HPE & NVIDIA hackathon in Geneva, two days from now, and
it's open source so any agent builder there can point at it directly, whatever framework
they're on."

Target: ~30s

## 4. Arkiv feedback (25%)

Line: "We filed 4 Arkiv findings this build, each with a runnable script. Full report is in
`feedback.md`."

Headline finding to say out loud: the nonce-manager gap. 1 of 6 concurrent writes from one
wallet landed without it, 6 of 6 with it. Second choice if there's time, the typed-wrapper
asymmetry, where writes take `str()`/`u64()` and reads hand back `{type, value}`.

Judges score this criterion from `feedback.md` itself, so saying it out loud just claims
credit for work they'd otherwise page past.

Target: ~15–20s

## Timing budget (≤3:00)

| Section | Target |
|---|---|
| Why Arkiv | 0:00–0:25 |
| Technical demo | 0:25–2:15 |
| Usefulness/adoption | 2:15–2:40 |
| Arkiv feedback | 2:40–3:00 |

## Gaps to discuss

- An Arkiv finding we haven't filed: `select('*')` silently omits `owner` on the live
  Tiramisu node even though the SDK requests it correctly. Found and fixed today in
  `src/arkiv.mjs`. Fresh and verified live, but that workstream just cut `feedback.md` down
  to 4 findings, so adding a fifth is a call for whoever owns it.
- `scripts/feedback/05` through `09` are orphaned now. `feedback.md` was trimmed to findings
  1–4 (nonce manager, typed wrapper, attribute validation, not-found ambiguity), but the
  reconnect and Swarm repro scripts still sit there and still run under
  `npm run feedback:repro`. Deliberate cut, or do we restore a line for each?
- Physical setup: two screens, or one screen with switching, for the terminal and browser
  beats.
- Who presents which section.
- `hub.arkiv.network/ethrome` has changed mid-event before, so it's worth one more look
  before judging.
