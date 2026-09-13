# Hydra — architecture

## 1. Overview

Three agents coordinate incident response using two storage systems:

- **Arkiv** (Tiramisu testnet) — small, typed, queryable rows that expire on their own.
- **Swarm** — the actual content (arbitrary size, encrypted, not queryable).

Arkiv attribute values are capped at 128 bytes, so content can't live there. Arkiv holds a
64-hex Swarm reference plus searchable metadata; Swarm holds the encrypted bytes.

```
public/control.html           control room: start a run, cut an agent's power
scripts/orchestrator.mjs      the same run headless, with scheduled kills
        │
        ▼
server.mjs                    REST app (src/app.mjs) + /api/demo/* + WebSocket push on /live
        │
        ▼
src/demo.mjs                  peer-symmetric controller: per agent, heartbeat + peer watch +
                              claim/work + verify loops
src/demo-ops.mjs              binds the controller to the protocol and storage below
        │
        ▼
src/protocol.mjs              claim / renew / takeover / finish / verify, heartbeats, outage watch
src/lane.mjs                  per-agent append-only feeds on Swarm
src/memory.mjs                joins the two legs: upload to Swarm, then index in Arkiv
        ├──────────────► src/swarm.mjs      encrypt → stamp → upload → reference
        └──────────────► src/arkiv.mjs      createEntity{ attributes incl. swarm_ref }

scripts/agent-chat.mjs        a Claude session with two tools: remember / recall (via REST)
scripts/audit-exporter.mjs    continuous export of every event to a durable log
```

A Swarm upload that fails leaves no Arkiv row behind — a row must never point at content that
doesn't exist.

---

## 2. Arkiv schema

Chain: Tiramisu. One entity type, `agent_memory`, seven possible attributes (snake_case,
`str`/`u64`). Full detail in `docs/ARKIV_SCHEMA.md`.

| Attribute       | Type    | Values |
| --------------- | ------- | ------ |
| `app`         | `str` | `hydra` — constant |
| `agent_id`    | `str` | `atlas` / `nova` / `sol` |
| `memory_type` | `str` | `event` / `claim` / `lane` / `done` / `verdict` / `heartbeat` |
| `tag`         | `str` | `incident-<run>` or `outage-<agent>-<run>-<n>` for incident rows; `agent-<agent>` for a heartbeat |
| `importance`  | `u64` | 0–10 |
| `swarm_ref`   | `str` | 64-hex Swarm reference |
| `outcome`     | `str` | `fixed` / `reopened` — `verdict` rows only |

Queries compose `eq`/`gte`/`startsWith` under `and`; Arkiv rejects a predicate-free query, so
"everything" is `eq(app, 'hydra')`.

**Identity.** Four wallets: a funder plus one signer per agent (`ARKIV_PRIVATE_KEY_ATLAS/NOVA/SOL`).
Each agent signs its own writes; `owner` on a row is enforced by the chain, not asserted. An
unconfigured `agentId` is refused. `extendEntity`/`deleteEntity` are owner-gated — no agent can
renew or release another's claim or row.

**Expiry.** `ExpirationTime.fromBlocks(n)` is exact; the applied value is resolved against
whichever block the transaction lands in, so requested and applied can differ (both are
returned). No `deleteEntity` call is needed for a row to disappear — it just stops existing at
its expiry block. There is no expiry event: a watcher holds `{entityKey → expiresAt}` from
`EntityCreated`, updates it on `ExpiryExtended`, drops it on `EntityDeleted`, and infers a lapse
by comparing against the current block.

**Live view.** `watchEntityEvents` delivers `{entityKey, owner, expiresAt}` only; each event is
read back to check `app` before being treated as ours. The watch needs a `webSocket()`-transport
client; a client that can't hold one open falls back to polling `/api/recent`.

**Demo clamp.** `DEMO_MAX_TTL_BLOCKS`, applied only to `claim` writes made through
`POST /api/memory`, caps a claim's requested TTL for recorded demos. The response reports
requested/applied/clamped separately.

---

## 3. Swarm storage and encryption

Every memory and lane payload: a random 32-byte content key, AES-256-GCM over the content, the
content key wrapped per roster recipient via ECIES (ephemeral ECDH over secp256k1 + HKDF). Each
agent's `ARKIV_PRIVATE_KEY_<AGENT>` doubles as their Swarm decryption identity — no shared secret.
Binary framing: `[recipient count][33-byte ephemeral pubkey][per recipient: 1-byte index + 12 iv +
16 tag + 32 wrapped key][12 iv][16 tag][ciphertext]`.

Upload: `POST /chunks` with a locally signed postage stamp (`Stamper.fromBlank`), never
`POST /bytes` — the chunk path is the one that actually spends this project's own postage batch
rather than the gateway's. One stamp covers one chunk, capping content at 4096 bytes total
(encrypted); larger content is refused rather than split.

Download: try each configured agent's private key until one unwraps the content key, then
decrypt. `openForAnyAgent` tries all three operational agents; `openForAuditor` decrypts with
only the auditor's key (§6), no fallback.

The postage batch has depth 23 and a multi-day TTL; expiry is independent of whatever Arkiv still
points at it.

---

## 4. The three-agent protocol

`atlas`, `nova`, `sol` are identical peers. Each runs the same loops: renew its own heartbeat,
watch its two peers' heartbeats for a lapse, claim/work any open incident, and verify incidents
someone else finished. Which agent detects an outage, which one fixes it, and which one verifies
the fix is decided by who's alive and who acts first — not by a fixed identity. An incident can be
filed two ways: an agent reports an external signal it noticed directly (atlas's rack failing, a
few seconds into a run), or a peer's watch loop detects that an agent's heartbeat has lapsed and
files the outage on its behalf.

### Entity roles

| Role      | `memory_type` | TTL | Written by |
| --------- | -------------- | --- | ---------- |
| incident  | `event`     | 600 blocks | reporting agent, or the peer that noticed an outage |
| claim     | `claim`     | 12 blocks, renewed every 4 while working | working agent |
| lane      | `lane`      | 600 blocks | each agent, once per incident, the first time it wins the claim |
| done      | `done`      | 600 blocks | finishing agent |
| verdict   | `verdict`   | 600 blocks | a verifying agent other than the finisher, after checking the fix |
| heartbeat | `heartbeat` | 8 blocks, renewed every 2 | each agent, about itself, tag `agent-<id>` |

Claims and heartbeats expire on their own; everything else persists. The first five roles share
one `tag` per incident and differ only by `memory_type`; a heartbeat's tag identifies the agent,
not an incident.

### Lanes

Per-agent append-only feeds on Swarm. Address is derived, not content-addressed:

```
topic   = hash('hydra/' + tag)
address = hash(owner wallet, topic, index)
```

Anyone holding a wallet address and the tag can compute the address; decrypting what's there
needs a roster key. Only the wallet's own key can write at its index. A worker publishes each
finished step to its lane, continuing from its own next free index, so a successor can resume
from it instead of restarting.

### Discovery

- **Is anyone alive on this incident?** `and(eq(app,'hydra'), eq(tag,…), eq(memory_type,'claim'))`
  — zero rows: the lease is free; one row: held, provably.
- **Who has worked it, and what did they produce?** query `memory_type='lane'` for the *who*;
  walk each owner's lane from index 0 until 404 for the *what*. This returns every owner who has
  ever touched the incident, not just the most recent one.
- **Is a peer still alive?** `and(eq(app,'hydra'), eq(tag,'agent-<id>'), eq(memory_type,'heartbeat'))`
  — zero rows on two consecutive polls: that agent is down, and the watching agent files the
  outage as a new incident.

### Outage incidents

An outage tag is `outage-<agent>-<run>-<n>`. `<run>` scopes it to one run, so rows an earlier run
left on chain never pass for this one's. `<n>` is the number of that agent's outages in this run
that already have a `done` row, read from the chain, so every watcher arrives at the same tag. A
dead agent only comes back by its outage being finished, so dying again after that is outage
`n+1`, a new incident.

Every live peer that sees an outage works it — whether it filed the row or found it already there —
so the incident survives its filer dying too. Finishing an agent's outage brings that agent back,
and a revived agent rejoins every incident still open. A worker that crashes on a Swarm or RPC error
stops renewing its claim and restarts after a short backoff, and a watcher survives a failed poll.

### Lifecycle

A double hand-off — two agents can die in sequence, and the third has to notice both:

```
  atlas                                nova                                  sol
  ├─ rack R12 fails → event/42          │                                     │
  ├─ claim/42 (12-block lease), lane/42 │                                     │
  ├─ swarm: diagnosis → lane index 0    │                                     │
  ├─ renew claim + heartbeat            │                                     │
  ✗  dies — claim lapses, heartbeat lapses
                                        ├─ query claim/42 → none
                                        ├─ query lane/42 → atlas's wallet
                                        ├─ atlas's heartbeat → lapsed: dead, not just slow
                                        ├─ claim/42, lane/42 ─────────────►
                                        ├─ read atlas's lane, resume after the diagnosis
                                        ├─ swarm: partial fix → lane index 0
                                        ├─ renew claim + heartbeat
                                        ✗  dies too — claim lapses, heartbeat lapses
                                                                              ├─ query claim/42 → none
                                                                              ├─ query lane/42 → atlas's AND nova's wallets
                                                                              ├─ both heartbeats lapsed →
                                                                              │  both confirmed dead
                                                                              ├─ claim/42, lane/42
                                                                              ├─ resume from the furthest
                                                                              │  step either lane reached
                                                                              └─ finish: fix → lane, done/42,
                                                                                 delete own claim
```

Meanwhile nova and sol each noticed atlas's heartbeat lapse and filed or joined atlas's outage;
sol noticed nova's. Sol is now the only agent standing, and `verify()` refuses to let a finisher
grade its own fix — so no verdict is written on incident 42 until an outage sol fixes brings atlas
or nova back online, and that agent checks sol's work. A single hand-off (one death, one successor,
a survivor free to verify) is the same mechanism with one fewer round.

Atlas can also be cut before it files anything. A dark data center reports nothing, so that run has
no rack incident — only atlas's outage, detected and worked by nova and sol like any other.

Write order in `finish`: lane content → `lane` row (if this agent has none yet) → `done` → delete
own claim. Check order before claiming: `verdict` → `done` → `claim` → prior workers' heartbeats.

### Dead, not slow

A lapsed claim alone can't tell a dead holder from a slow one. Before claiming, `tryClaim` reads
the `lane` rows (every agent that ever held the claim has one) and checks each prior worker's
heartbeat. If a prior worker's heartbeat is still live, it is slow rather than dead and keeps the
right to resume: a newcomer backs off. If several prior workers are alive, the first in
`atlas, nova, sol` order goes, so they never all wait on each other.

### Claim tie-break

Query-then-write is not atomic. After writing a claim, wait for its transaction's block plus one,
re-query; if more than one claim exists, the lowest `entityKey` wins and every other holder
deletes its own claim and retries with a random backoff. A second confirmation round (one more
block, re-query again) runs before finalizing, to catch a rival whose write landed a block later.
Any failure after writing a claim deletes it before returning.

### Verification

`verify(verifier, tag)` compares the chain-enforced `owner` of every `done` row on the tag with the
verifier's wallet and refuses (writes nothing) on a match. Otherwise it reads the finisher's lane
and writes `outcome: fixed` if its latest entry is a `fix`, `reopened` if not — a check that the
fix was published, not a re-run of it.

---

## 5. HTTP paths

**Write.** `POST /api/memory` → validate fields → select signer for `agentId` → clamp TTL if
`claim` → upload to Swarm, create Arkiv entity → return `{entityKey, txHash, swarmRef,
appliedTtlBlocks, appliedExpiresAt, requestedTtlBlocks, ttlClamped}`.

**Read.** `GET /api/query?agentId=…` → Arkiv predicate → fetch and decrypt each row's Swarm
content; a failed fetch degrades to `{error: 'content unavailable: …'}` on that row only.

**Live.** `watchEntityEvents` → read back → broadcast over `/live`: `memory` (new row),
`extended` (lease renewed), `deleted` (row released). Falls back to `/api/recent` polling where a
WebSocket can't stay open.

**Demo.** `POST /api/demo/start`, `POST /api/demo/kill/:agentId` (both behind `DEMO_PASSWORD` when
set), `GET /api/demo/state`, `GET /api/demo/report?as=<agent|outsider>`.

---

## 6. Audit export

Arkiv rows and the Swarm postage batch both expire — there is no later point at which the full
history can be pulled in bulk, and Swarm has no bulk-list or enumeration API of any kind
(retrieval is strictly by known reference). The only mechanism is continuous export as events
happen: `scripts/audit-exporter.mjs` subscribes to the same event stream `server.mjs` does, re-arms
the subscription after an error, and appends every `created`/`extended`/`deleted` event, decrypted,
to a local log. A row deleted before it could be read back is logged as `created-unreadable`, and a
dropped subscription as `watch-error`, so gaps are visible rather than silent.

Decryption uses a fourth, optional roster recipient: if `AUDITOR_PUBLIC_KEY` is set,
`sealForRoster` wraps a copy of the content key for it from the public key alone. The exporter
holds only `AUDITOR_PRIVATE_KEY` — no agent key, no Swarm write credentials, so it can read and
decrypt but not write to Arkiv or spend postage. `scripts/generate-auditor-key.mjs` generates the
pair.

This only covers memories written after the auditor's public key is added to the roster, and
Arkiv's metadata (who claimed what, when) needs no key at all — it's already public.

---

## 7. Known limits

- 4096 bytes per memory; no splitting for larger content.
- The Swarm `Stamper`'s bucket counters are in-memory only; a restart can eventually re-stamp a
  filled bucket.
- The claim tie-break narrows the race window but doesn't eliminate it under arbitrary network
  skew. A prior worker whose heartbeat is live but whose worker loop hangs (rather than throwing)
  holds newcomers off an incident until its heartbeat lapses.
- All three agents' keys and the auditor's key can sit in the same process/`.env`; real isolation
  between them requires separate processes with separate custody, which isn't built. The server
  holding the agent keys signs `POST /api/memory` for whichever `agentId` the caller names, and
  `GET /api/query`, `/api/recent` and `/api/demo/report?as=<agent>` return decrypted content to any
  caller — the encryption protects content on Swarm and at the gateway, not from this server's API.
