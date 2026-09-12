# Peer-symmetric maintenance agents — design

Today: atlas monitors and never fixes; nova and sol are identical workers. Only atlas's own
outage is detectable (it's the one thing that hand-writes the incident in `src/demo.mjs`) and
only nova/sol can claim and fix it. If nova's or sol's DC goes down instead, nothing notices.

Goal: any of the three agents can detect a peer's outage, claim it, fix it, and verify the fix —
so which agent plays which role on a given incident is decided by who's alive and who claims
first, not by a fixed identity.

## What's already generic (no change needed)

`tryClaim`, `renewClaim`, `finish`, and `takeOver` in `src/protocol.mjs` already take an arbitrary
`agentId` and place no assumptions on which agent that is. The asymmetry is exactly two things:

1. `verify()` hardcodes `signers.get('atlas')` (`src/protocol.mjs:163`).
2. `src/demo.mjs`'s orchestration only spawns a worker loop for `['nova', 'sol']` and only ever
   files one hardcoded incident, about atlas's own DC.

## Detection: reuse the expiring-lease mechanism, don't invent a new one

A claim's lapse is already "silence noticed by a watcher" — exactly what's needed to detect a
dead peer. Add a `heartbeat` role:

- Each agent renews a short-TTL row for itself while alive: `memory_type: 'heartbeat'`,
  `tag: 'agent-<agentId>'` (not incident-scoped — a heartbeat is about the agent, not a specific
  incident). Content is trivial, same as a `claim`.
- Every agent runs a peer-watch loop alongside its own heartbeat renewal, checking the *other*
  two agents' heartbeat tags on an interval.
- If a peer's heartbeat row is absent (lapsed) and no incident already exists for that peer's
  outage, the watcher files one: `memory_type: 'event'`, `tag: 'outage-<peerId>'` — a stable tag,
  not timestamped, so two watchers noticing the same lapse converge on the same incident instead
  of filing duplicates (the existing `incidentIsSpokenFor` check in `tryClaim` already handles
  the rest: whoever claims first wins, same as any other incident).

## Changes required

**`src/arkiv.mjs`** — add `'heartbeat'` to `MEMORY_TYPES`. No schema/attribute changes; a
heartbeat is an ordinary `agent_memory` row like everything else.

**`src/protocol.mjs`**:
- `verify(ctx, verifierAgentId, tag)` — take the verifier's id as a parameter instead of hardcoding
  `'atlas'`. The `atlasSigner` local becomes `signer = signers.get(verifierAgentId)`, same guard.
- New: `renewHeartbeat(ctx, agentId, shouldContinue)` — same shape as `renewClaim` but against a
  `heartbeat` row on `tag: 'agent-<agentId>'`, using a TTL short enough to detect an outage
  quickly without spamming writes (e.g. 8 blocks, renewed every ~3 — matches the existing claim
  lease's ratio).
- New: `watchForPeerOutages(ctx, watchingAgentId, onOutageDetected)` — polls the other agents'
  heartbeat tags; on a lapse with no existing incident for `outage-<peerId>`, files the `event`
  row and calls `onOutageDetected(peerId, tag)`.

**`src/demo.mjs`** — replace the fixed roster split with: every agent runs its heartbeat loop, its
peer-watch loop, and the existing claim/work loop (unchanged). `kill(agentId)` stops only that
agent's heartbeat renewal — detection, filing, claiming, fixing, and verifying all fall out of the
generic peer machinery already described, rather than being scripted per scenario. The verifier
for a given incident is whichever surviving agent's watch loop is the one that notices the `done`
row first (naturally decided by polling timing, no coordination needed — a duplicate verdict
write is harmless since `verify`'s own `incidentIsSpokenFor`-equivalent check for verdicts already
guards against re-verifying).

## Explicitly out of scope

- Real infrastructure health checks — heartbeats are a liveness signal within this system, not a
  probe of the simulated data center itself.
- Byzantine-fault handling (a lying peer). Every agent already writes with its own key; a peer
  falsely claiming another is alive or down is not addressed here, same as the rest of this
  project's stated trust model.
