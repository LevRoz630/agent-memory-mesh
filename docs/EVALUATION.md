# Hydra — strict evaluation (2026-09-13)

Reviewed against the working tree (uncommitted refactor), not `HEAD`. `npm test` was run; the
`verify:*` live tests were not (they spend Tiramisu gas and postage).

**Verdict:** the coordination layer is real and traceable, but it runs as three simulated peers in
one Node process. A solid hackathon MVP, not yet deployable across a network of servers.

Honest pitch framing: "the protocol runs live on Arkiv and Swarm, with three peers simulated in one
process" — not "deployed across data centers".

## 1. Real vs. staged in the demo

**Real and traceable**
- Every UI state change comes from `src/demo.mjs`; every protocol step is a real Arkiv transaction
  or Swarm chunk upload. The UI links the actual entity on the explorer and fetches the actual chunk.
- Killing an agent only stops its heartbeat renewals. Peers detect the outage purely by querying
  Arkiv and seeing the row lapse.
- Claims, lease lapse, and takeover by reading the previous holder's Swarm lane are all on-chain /
  on-Swarm.

**Staged**
- The work is fake: `WORK_STEPS` is `sleep(6000)` plus a lane write; `INCIDENT_REPORT` is a constant.
- Claim order is choreographed: `startDelayMs` ensures atlas wins, so the tie-break never has to decide.
- Revival is a shared-memory shortcut: `revive()` flips the dead agent's `alive` flag directly. No
  message crosses the wire.
- Verification only checks the worker's own claim: `verify()` returns `fixed` if the finisher's last
  lane entry is `kind: 'fix'`, which `finish()` itself writes.

## 2. Blockers for a multi-server deployment

1. **Every node needs every agent's private key.** `sealForRoster` derives recipient public keys
   from all three `ARKIV_PRIVATE_KEY_<AGENT>` values; `openForAnyAgent` tries all of them. This
   undoes the per-agent identity story. Fix: public-key roster, one private key per node.
2. **Liveness, claims and completion are spoofable.** No query filters `owner` against known agent
   addresses (`heartbeatIsLive`, `incidentIsSpokenFor`, `currentOutageTag`, `verify`, `takeOver`).
   Any Tiramisu wallet can fake a heartbeat, write `done` to halt work, or plant a lane row that
   makes `takeOver` throw. A spoofed heartbeat row can also break `startHeartbeat`'s extend.
   Fix: filter every result by roster owner address.
3. **Swarm stamper state is not persisted.** `Stamper.fromBlank` resets bucket counters on every
   start, so restarts or two hosts sharing a batch reuse stamp slots and can overwrite earlier
   chunks. Fix: persist stamper state; one batch (or bucket range) per node.
4. **Dedup lives in process memory.** `ctl.verified`, `ctl.ownFixes`, `ctl.working` and the
   watcher's `handled` set are per-process, so separate processes can double-verify and double-file.

## 3. Correctness issues even in one process

- **No fencing.** Lease loss is noticed only at the next renewal (~4 blocks). A holder keeps acting
  meanwhile — harmless for sleeps, dangerous for a real IPMI power cycle.
- **Tie-break can livelock.** Both claimants may delete and retry; after 10 attempts both give up
  until the worker loop retries.
- **Lane index reuse.** `nextFreeLaneIndex` treats a gateway 404 as free; a not-yet-propagated chunk
  also 404s.
- **Takeover is fragile and slow.** Any non-404 `readLane` error is fatal; lanes are walked from
  index 0 on every progress read with an 8s timeout per read.
- **Cost unmeasured.** An extend tx every ~2 blocks per agent, forever; heartbeat restarts also
  spend a stamp.
- **4 KB content cap.** Larger content is refused, not split.

## 4. Server and repo hygiene

- `GET /api/demo/report?as=<agent>` is not password-gated and returns plaintext decrypted with that
  agent's key (including the IPMI host/user) to anyone.
- `npm test` fails: `demo-controller.mjs` expects outage `location` and a "last beat from …"
  timeline entry the controller no longer produces.
- `@ethersphere/core-sdk` is imported directly but only present as a transitive dependency of bee-js.
- Unit tests use fake ops; only the `verify:*` scripts exercise the chain and Swarm, and they are not
  part of `npm test`.

## 5. MVP scorecard

| Claim | Status |
|---|---|
| Expiring index on Arkiv (claims, heartbeats, leases) | Real |
| Encrypted content on Swarm with own postage | Real (single process only) |
| Peer outage detection without a central announcer | Real |
| Takeover resumes from the dead agent's Swarm lane | Real |
| Independent peers on separate servers | No — shared keys, stamper, memory state |
| Resistant to outside writers | No — no owner filtering |
| Real remediation and verification | No — sleeps and self-attestation |

## 6. Minimum to honestly claim "runs on separate servers"

1. Public-key roster; each node holds only its own private key. *(small)*
2. Owner-address filtering on every query. *(small)*
3. Persisted stamper state, or a batch per node. *(medium)*
4. Move dedup from memory to on-chain checks. *(medium)*
5. Revival driven by the returning node's own heartbeat instead of `revive()`. *(medium)*
6. Gate or remove `?as=` on the report endpoint. *(small)*
7. Fix the failing unit test. *(small)*
