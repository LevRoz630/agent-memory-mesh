# Hydra — architecture

## 1. Overview

Three agents coordinate incident response using two storage systems:

- **Arkiv** (Tiramisu testnet) — small, typed, queryable rows that expire on their own.
- **Swarm** — the actual content (arbitrary size, encrypted, not queryable).

Arkiv attribute values are capped at 128 bytes, so content can't live there. Arkiv holds a
64-hex Swarm reference plus searchable metadata; Swarm holds the encrypted bytes.

```
scripts/orchestrator.mjs      drives atlas/nova/sol as concurrent loops
scripts/agent-chat.mjs        a Claude session with two tools: remember / recall
        │
        ▼
src/app.mjs                   REST surface
        │
        ▼
server.mjs                    same app + WebSocket push on /live
        │
        ▼
src/memory.mjs                joins the two legs: upload to Swarm, then index in Arkiv
        ├──────────────► src/swarm.mjs      encrypt → stamp → upload → reference
        ├──────────────► src/arkiv.mjs      createEntity{ attributes incl. swarm_ref }
src/lane.mjs                  per-agent append-only feeds on Swarm
src/protocol.mjs              claim / renew / takeover / finish / verify state machine
scripts/audit-exporter.mjs    continuous export of every event to a durable log
```

A Swarm upload that fails leaves no Arkiv row behind — a row must never point at content that
doesn't exist.

---

## 2. Arkiv schema

Chain: Tiramisu. One entity type, `agent_memory`, seven possible attributes (snake_case,
`str`/`u64`):

| Attribute       | Type    | Values |
| --------------- | ------- | ------ |
| `app`         | `str` | `hydra` — constant |
| `agent_id`    | `str` | `atlas` / `nova` / `sol` |
| `memory_type` | `str` | `event` / `claim` / `lane` / `done` / `verdict` |
| `tag`         | `str` | `incident-<id>` — shared by every row of one piece of work |
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

**Demo clamp.** `DEMO_MAX_TTL_BLOCKS`, applied only to `claim` writes, caps a claim's requested
TTL for recorded demos. The response reports requested/applied/clamped separately.

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

`atlas`, `nova`, `sol` are identical peers. Each runs the same three loops: renew its own
heartbeat, watch its two peers' heartbeats for a lapse, and claim/work/verify incidents. Which
agent detects an outage, which one fixes it, and which one verifies the fix is decided by who's
alive and who acts first — not by a fixed identity. An incident can be filed two ways: an agent
reports an external signal it noticed directly (e.g. a monitored system going quiet), or a peer's
watch loop detects that agent's own heartbeat has lapsed and files the outage on its behalf.

### Entity roles

| Role      | `memory_type` | TTL | Written by |
| --------- | -------------- | --- | ---------- |
| incident  | `event`     | 600 blocks | reporting agent |
| claim     | `claim`     | 12 blocks, renewed while working | working agent |
| lane      | `lane`      | 600 blocks | each agent, once, on first Swarm write |
| done      | `done`      | 600 blocks | finishing agent |
| verdict   | `verdict`   | 600 blocks | verifying agent, after checking the fix |
| heartbeat | `heartbeat` | 8 blocks, renewed every ~1/3 | each agent, about itself, tag `agent-<id>` |

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
needs a roster key. Only the wallet's own key can write at its index. A worker publishes
intermediate findings to its lane before finishing, so a successor can resume from them instead
of restarting.

### Discovery

- **Is anyone alive on this incident?** `and(eq(app,'hydra'), eq(tag,…), eq(memory_type,'claim'))`
  — zero rows: free to take; one row: held, provably.
- **Who has worked it, and what did they produce?** query `memory_type='lane'` for the *who*;
  walk each owner's lane from index 0 until 404 for the *what*. This returns every owner who has
  ever touched the incident, not just the most recent one.
- **Is a peer still alive?** `and(eq(app,'hydra'), eq(tag,'agent-<id>'), eq(memory_type,'heartbeat'))`
  — zero rows on two consecutive polls: that agent is down, and the watching agent files the
  outage as a new incident (`tag: outage-<id>`).

### Lifecycle

A double hand-off — two agents can die in sequence, and the third has to notice both:

```
                nova                                  sol                        atlas
  ├─ claim/42 (12-block lease)                          │                          │
  ├─ swarm: diagnosis → lane index 0                     │                          │
  ├─ lane/42, renew claim + heartbeat every ~1/3 lease   │                          │
  ✗  dies — claim lapses, heartbeat lapses               │                          │
                                                          ├─ query claim/42 → none
                                                          ├─ query lane/42 → nova's wallet
                                                          ├─ read nova's lane, resume from diagnosis
                                                          ├─ claim/42 ─────────────►
                                                          ├─ swarm: partial fix → lane index 0
                                                          ├─ lane/42, renew claim + heartbeat
                                                          ✗  dies too — claim lapses, heartbeat lapses
                                                                                    │
                                                                    ├─ query claim/42 → none
                                                                    ├─ query lane/42 → nova's AND sol's wallets
                                                                    ├─ check both: claim lapsed AND
                                                                    │  heartbeat lapsed → both confirmed
                                                                    │  dead, not just slow
                                                                    ├─ read sol's lane (the latest,
                                                                    │  not nova's stale diagnosis)
                                                                    ├─ claim/42, finish the fix
                                                                    ├─ lane/42, done/42, delete own claim
                                                                    └─ verdict/42 outcome=fixed
```

A single hand-off (one death, one successor) is the same mechanism with one fewer round — the
double case is what proves `takeOver` handling multiple prior owners, and heartbeat-plus-claim
together confirming death rather than either alone.

Write order in `finish`: lane content → `lane` row → `done` → delete own claim. Check order
before claiming: `verdict` → `done` → `claim`.

### Claim tie-break

Query-then-write is not atomic. After writing a claim, wait for its transaction's block plus one,
re-query; if more than one claim exists, the lowest `entityKey` wins and every other holder
deletes its own claim and retries with a random backoff. A second confirmation round (one more
block, re-query again) runs before finalizing, to catch a rival whose write landed a block later.
Any failure after writing a claim deletes it before returning.

---

## 5. HTTP paths

**Write.** `POST /api/memory` → validate fields → select signer for `agentId` → clamp TTL if
`claim` → upload to Swarm, create Arkiv entity → return `{entityKey, txHash, swarmRef,
appliedTtlBlocks, appliedExpiresAt, requestedTtlBlocks, ttlClamped}`.

**Read.** `GET /api/query?agentId=…` → Arkiv predicate → fetch and decrypt each row's Swarm
content; a failed fetch degrades to `{error: 'content unavailable'}` on that row only.

**Live.** `watchEntityEvents` → read back → broadcast over `/live`: `memory` (new row),
`extended` (lease renewed), `deleted` (row released). Falls back to `/api/recent` polling where a
WebSocket can't stay open.

---

## 6. Audit export

Arkiv rows and the Swarm postage batch both expire — there is no later point at which the full
history can be pulled in bulk, and Swarm has no bulk-list or enumeration API of any kind
(retrieval is strictly by known reference). The only mechanism is continuous export as events
happen: `scripts/audit-exporter.mjs` subscribes to the same event stream `server.mjs` does and
appends every `created`/`extended`/`deleted` event, decrypted, to a local log.

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
  skew; a worker that goes slow rather than dying can still lose a lease mid-work.
- All three agents' keys and the auditor's key can sit in the same process/`.env`; real isolation
  between them requires separate processes with separate custody, which isn't built.
