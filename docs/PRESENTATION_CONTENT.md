# Hydra — presentation content

Raw material for slides. Each section is self-contained; lift directly. ETHRome 2026, targeting
the Arkiv and Swarm sponsor bounties.

## 1. The one-line pitch

**Three AI agents fix an incident without a server coordinating them, and without trusting a
central place with what the incident actually was.**

Elevator pitch: Multi-agent systems today assume a coordinator — a queue, a database, a process
that's up. That coordinator is also the single thing that takes the whole system down with it,
and the one place holding everything the agents said to each other, including the incident's
actual contents. Hydra removes both assumptions. Coordination lives on Arkiv, a chain where every
row expires on its own — a lease that isn't renewed just stops existing, no server watching the
clock. Content lives on Swarm, encrypted before it ever leaves the agent that wrote it, so the
storage layer never sees what it's storing.

## 2. The problem

- If mass infrastructure fails — the kind of event that takes out a company's servers *and* its
  database with them — an agent that can still reach Arkiv and Swarm can still coordinate a fix.
  An agent that depends on one company's database can't.
- A security incident report is not something you want sitting in one company's database in the
  first place. Hydra encrypts it before upload, so the storage layer holds ciphertext it can't
  read regardless of who operates it.
- Neither system is a coordinator anyone can take down to stop the work; neither is a party
  anyone has to trust with the incident's contents.

## 3. How it works

Two systems, split by what they're good at:

- **Arkiv** (Tiramisu testnet) — small, typed, queryable rows that expire on their own.
- **Swarm** — the actual content, arbitrary size, encrypted, not queryable.

Arkiv attribute values cap at 128 bytes, so content can't live there: Arkiv holds a 64-hex Swarm
reference plus searchable metadata; Swarm holds the encrypted bytes.

**The five entity roles**, all one `agent_memory` type on Arkiv, differing only by `memory_type`
and sharing one `tag` per incident:

| Role     | `memory_type` | TTL                              | Written by                             |
| -------- | --------------- | -------------------------------- | -------------------------------------- |
| incident | `event`       | 600 blocks                       | reporting agent                        |
| claim    | `claim`       | 12 blocks, renewed while working | working agent                          |
| lane     | `lane`        | 600 blocks                       | each agent, once, on first Swarm write |
| done     | `done`        | 600 blocks                       | finishing agent                        |
| verdict  | `verdict`     | 600 blocks                       | reporting agent, after checking        |

Claims expire on their own; everything else persists — the incident's full history survives even
after every claim on it has lapsed.

**Per-agent lanes**: append-only feeds on Swarm, address *derived*, not content-addressed —
`topic = hash('hydra/' + tag)`, `address = hash(owner wallet, topic, index)`. Anyone holding a
wallet address and the tag can compute the address; decrypting what's there needs a roster key.
Only the wallet's own key can write at its index. A worker publishes intermediate findings to its
lane before finishing, so a successor can resume from them instead of restarting.

**Deterministic tie-break**: query-then-write isn't atomic, so two agents can race to claim the
same incident. After writing a claim, wait for its transaction's block plus one, re-query; if
more than one claim exists, the lowest `entityKey` wins and every other holder deletes its own
claim and retries with backoff. A second confirmation round (one more block, re-query again) runs
before finalizing, to catch a rival whose write landed a block later.

**The lifecycle** (live, on the real testnet) — a double hand-off, not just one:

```
incident/42 filed
        │
        ├─ atlas claims (12-block lease)
        ├─ atlas publishes diagnosis → atlas's lane, index 0
        ├─ atlas renews claim + heartbeat
        ✗  atlas dies — claim lapses, heartbeat lapses
        │
        ├─ nova: query claim/42 → none
        ├─ nova: query lane/42 → atlas's wallet
        ├─ nova reads atlas's lane, resumes from the diagnosis instead of restarting
        ├─ nova claims, publishes a partial fix → nova's lane, index 0
        ├─ nova renews claim + heartbeat
        ✗  nova dies too — claim lapses, heartbeat lapses
        │
        ├─ sol: query claim/42 → none
        ├─ sol: query lane/42 → TWO wallets now, atlas's and nova's
        ├─ sol checks both: claims lapsed AND heartbeats lapsed → both confirmed dead,
        │  not just slow (a lapsed claim alone can mean "behind", not "gone" — heartbeat
        │  lapsing too is the second, independent signal that closes that gap)
        ├─ sol reads nova's lane — the latest, not atlas's stale diagnosis — and resumes
        │  from nova's partial fix
        ├─ sol claims, finishes the fix, writes done/42
        └─ sol is now the only agent standing — the protocol won't let a finisher verify
           its own fix, so no verdict/42 is written until atlas or nova comes back online
```

The mechanism for this needs no new code beyond what's already built: `takeOver` already queries
*every* `lane` row for a tag, not just the most recent worker's, so a third agent arriving after
two deaths gets both atlas's and nova's lane content back and has to pick the latest one itself.
Heartbeats add the second confirmation signal — claim-lapse alone was always advisory, not proof
of death; claim-lapse *and* heartbeat-lapse together is real corroborating evidence, not a guess.
The self-verification exclusion is a deliberate rule, not a gap: a fix isn't "checked" if the
only agent left to check it is the one that just wrote it.

Nothing here is simulated in front of a mock — every step is a real write against a live testnet
and a live Swarm gateway.

## 5. The live demo

A control-room UI already exists, mapping the three agents to three data centers:

- `atlas` → DC-1 Frankfurt
- `nova` → DC-2 Amsterdam
- `sol` → DC-3 Milan

The demo: an incident hits a rack (8 servers unreachable, top-of-rack switch silent). Atlas claims
it and starts working through real remediation steps (diagnose the rack, power-cycle via IPMI,
confirm servers back online), publishing progress to its lane as it goes.

The version worth showing on camera is the double hand-off, not a single one: cut power to atlas
mid-fix — its lease lapses, its heartbeat lapses. Nova notices no claim, finds atlas's lane, and
resumes from its progress instead of restarting. Cut power to nova too, partway through its own
fix. What's left is sol, which has to notice that **two** agents have now gone dark, find **both**
their lanes, confirm both are actually dead (not just slow — a lapsed claim alone is ambiguous, a
lapsed claim *and* a lapsed heartbeat together isn't), resume from whichever lane has the latest
progress, and finish the job itself. Sol then can't write the verdict alone — verification waits
for atlas or nova to come back online. Once the fix lands, the data centers come back online.

The peer-symmetric work above is what makes this possible at all: today the demo can only show
DC-1 (atlas) going down once, with DC-2/DC-3 recovering it. Once wired in, any of the three data
centers can be cut — including a worker's own DC, including a second one mid-recovery — and
detected and recovered by whichever agent is left standing.

## 6. Security and audit

**Encryption**: every memory and lane payload gets a random 32-byte content key, AES-256-GCM over
the content, the content key wrapped per roster recipient via ECIES (ephemeral ECDH over
secp256k1 + HKDF). Each agent's own signing key doubles as its Swarm decryption identity — no
shared secret, no shared password. This is real per-recipient cryptography, not access-control
theater.

**The honest caveat**: in this deployment, one process holds all three agents' keys. That makes
the roster a *demonstrated* mechanism today, not an *enforced* boundary between adversarial
parties — splitting the agents into genuinely separate processes with separate key custody is the
next step, and the crypto doesn't change to get there, only who holds which key.

**Audit export**: Arkiv rows and the Swarm postage batch both expire, and Swarm has no bulk-list
or export API of any kind — retrieval is strictly by known reference. So there's no later point
at which the full history can be pulled in bulk. The only mechanism is continuous export as
events happen: a dedicated script subscribes to the same live event stream the app itself uses
and appends every created/renewed/released event, decrypted, to a durable log — before either
side ages out.

The exporter uses a fourth, separately-custodied roster recipient: an auditor's *public* key gets
added to every seal at write time; the exporter process holds only the corresponding *private*
key — no agent key, no Swarm write credentials, so it can read and decrypt but can't write to
Arkiv or spend postage. This only covers memories written after the auditor key is added to the
roster; Arkiv's own metadata (who claimed what, when) needs no key at all, since it's already
public.

## 7. What's real vs. what's future work

**Built and live-verified against the real testnet and gateway:**

- The full claim → lane → takeover → finish → verify lifecycle
- The deterministic tie-break, including its settle-window fix for cross-block race conditions
- Per-agent lanes with resumable work (a successor genuinely reads a dead worker's progress)
- Roster-scoped envelope encryption (real ECIES, not a shared key)
- The continuous audit-export mechanism with a separately-custodied auditor identity
- Heartbeat-based peer liveness and outage detection (any agent, not just atlas, can notice a
  peer going down)

**Explicitly deferred, stated plainly rather than glossed over:**

- Memories over 4KB — one postage stamp covers exactly one chunk; larger content is refused, not
  split. Splitting across multiple stamped chunks with a manifest is the fix, not yet built.
- Real per-process key custody — today one process holds every key (three agents' and the
  auditor's). Genuine isolation between them needs separate processes, which isn't built.
- The Swarm `Stamper`'s bucket counters are in-memory only; a restart can eventually re-stamp a
  filled bucket. `Stamper.fromState` exists to fix this and isn't wired up.
- The claim tie-break narrows the race window but doesn't eliminate it under arbitrary network
  skew — a worker that goes slow rather than dying can still lose its lease mid-work.
- Peer-symmetric detection is built and tested at the mechanism level; wiring it into the live
  demo controller so it's demonstrable end-to-end is the one remaining step.

## 8. Key numbers and facts

- **Chain**: Tiramisu testnet, ~2-second blocks.
- **Claim lease**: 12 blocks (~24s), renewed every ~4 blocks (~8s) while working.
- **Heartbeat lease**: 8 blocks (~16s), renewed every ~1/3 of that.
- **Long-lived rows** (event/lane/done/verdict): 600 blocks (~20 minutes).
- **Content cap**: 4096 bytes per memory (one postage stamp = one chunk).
- **Postage batch**: depth 23, multi-day TTL, spent locally — never routed through a Bee node.
- **Encryption**: AES-256-GCM content, ECIES (ECDH secp256k1 + HKDF) per-recipient key wrapping.
- **Arkiv schema**: one entity type, seven possible attributes, five `memory_type` values plus
  `outcome` on verdicts.
- **Arkiv SDK friction found and reproduced**: 4 issues (read/write attribute shape asymmetry,
  contradictory name validation, missing nonce manager for concurrent writes, identical error for
  a never-created vs. an expired entity) — each with a live, runnable reproducer.
- **Bounty fit**: Arkiv (schema draft at `arkiv/schema.md`, friction report, expiry-as-mechanism,
  live-wire subscription over `watchEntityEvents`) and Swarm (genuine chunk-path uploads with a
  locally signed postage stamp, a real reason for decentralized storage, not just "because we can").
