# Claim-takeover protocol, per-agent envelope encryption, deterministic tie-break — design

Finishes ARCHITECTURE.md §7 (currently: identity is built, the protocol is not). Revised after an
adversarial review found the first draft would silently regress to gateway-paid postage, blow the
4KB budget, and specify a tie-break that never converges. Every decision below responds to a
specific finding from that review; the finding is named so it can be traced back.

## Scope

One orchestrator process drives all three agents (atlas, nova, sol) as concurrent async loops,
each signing with its own existing wallet key. Single process, not three, so the Swarm `Stamper`'s
in-memory bucket state is never split across processes (resolves the multi-process collision risk
that three separate OS processes would introduce).

## 1. Lane writes (`src/lane.mjs`, new)

- `writeToLane(agentPrivateKey, tag, index, content)`:
  - `topic = Topic.fromString('agent-memory-mesh/' + tag)`
  - address = `getFeedUpdateChunkReference(ownerAddress, topic, index)` (bee-js's own helper —
    do not hand-roll the keccak formula)
  - stamp that address with the **same shared `Stamper`** instance `src/swarm.mjs` already holds
    (not a batch ID passed to `uploadPayload` — passing a bare batch ID silently takes the
    gateway-paid `/bytes`-equivalent path instead of honoring our locally-signed stamp)
  - call `bee.feed.makeWriter(topic, agentPrivateKey).uploadPayload(envelope, content, { index })`
    with the index **explicit** — `uploadPayload` re-derives the index over the network if omitted,
    which can stamp one address and write a different one and get rejected
  - payload is capped at 4096 bytes, same check as `uploadMemory`
  - payload carries a small header so a successor can tell content apart:
    `{ kind: 'diagnosis' | 'fix' | 'verification', tag, index }`
- `readLane(ownerAddress, tag, index)`:
  - use `makeFeedReader(...).downloadPayload({ index })`, never `.download()` — `uploadPayload`
    writes no timestamp prefix, but the non-payload reader defaults to expecting one and silently
    strips 8 real content bytes
  - a 404 means a clean, unwritten index — not an error

## 2. Per-agent envelope encryption (`src/swarm.mjs`, replaces the global `MEMORY_ENC_KEY` scheme)

Binary framing, not JSON — JSON-encoding (plus hex/base64 ciphertext) was measured to cost ~60% of
the 4KB budget; binary framing with one shared ephemeral keypair costs ~245 bytes for 3 recipients:

```
[1 byte nRecipients]
[33 bytes ephemeral pubkey, compressed]
per recipient (61 bytes): [1 byte agent index][12 iv][16 tag][32 wrapped content-key]
[12 iv][16 tag][ciphertext]
```

- One random 32-byte content key per memory, content encrypted with it via AES-256-GCM (as today).
- For each agent on the roster: ECDH (`crypto.createECDH('secp256k1')`) between one shared
  ephemeral keypair and the recipient's public key (derived from their existing
  `ARKIV_PRIVATE_KEY_<AGENT>` — confirmed to match viem's derivation live, 3/3 keys checked).
  Run the raw ECDH secret through `hkdfSync('sha256', secret, salt, info, 32)` before using it as
  an AES key — using the raw ECDH output directly is not real ECIES.
- Agent index is position in `AGENT_IDS` (`['atlas','nova','sol']`), not a string, to save bytes.
- `downloadMemory` does **not** take a "requesting agent" parameter. It tries every agent key the
  server has configured against `wrappedKeys` until one unwraps successfully. This is a deliberate
  simplification, not an oversight: the server already holds every agent's private key in this
  deployment, so there is no requester identity to plumb through `/api/recent` or the live
  WebSocket push (neither carries one today), and per-request identity would not add real
  isolation while one process holds every key anyway.

**Honesty note, to fix in ARCHITECTURE.md alongside this build:** this is a demonstrated
per-agent-sealing mechanism, not enforced access control, as long as one process holds all three
private keys. §7's current wording ("the roster... is the set of wallets that can decrypt the
report at all") should be corrected to say so explicitly. Real isolation would require agents as
separate processes with separate key custody — noted as future work, not built now.

## 3. Schema and query additions (`src/arkiv.mjs`)

- Add `outcome` as a seventh, optional attribute on `createMemory` (only `verdict` rows set it).
- `memory_type` is validated against a whitelist of the five roles
  (`event`/`claim`/`lane`/`done`/`verdict`) — today any string is accepted silently, and a typo in
  a worker becomes an invisible claim nobody else can see.
- Every entity always gets a real `swarm_ref` — including `claim`, which uploads a trivial `{}`
  payload. This avoids a null-content special case in `readMemoryContent` for roles that don't
  need real content.
- New query: `queryByTagAndType(pub, { tag, memoryType, limit })` — `and(eq(app), eq(tag),
  eq(memory_type))`. Needed by `tryClaim`, the tie-break re-query, and `verify`'s `done` poll;
  neither existing query (`queryByTag`, scoped only to tag; `queryMemories`, scoped to a single
  `agent_id`) covers this combination.

## 4. Protocol state machine (`src/protocol.mjs`, new)

- `tryClaim(agentId, tag)`:
  1. Query `verdict` → `done` → `claim` for this tag, in that order (cheapest to honor first —
     matches ARCHITECTURE.md's existing rationale).
  2. If clear, write a `claim` (12-block lease, up from 8 — see tie-break below for why).
  3. **Settle wait**: fetch the claim tx's receipt block, then poll `getBlockNumber()` until head
     is at least one block past it. (Without this, two racers can each see only their own claim
     row and both conclude they won — the original design's re-query had no wait at all.)
  4. Re-query `claim` rows for this tag via `queryByTagAndType`. If more than one comes back, the
     lowest `entityKey` wins; every other holder deletes its own claim and retries from step 1
     after a random 200–500ms backoff.
- `renewClaim(agentId, entityKey)`: `extendEntity` on a timer at ~1/3 of the lease (~4 blocks).
  A rejection specifically for "would not move the expiry later" is treated as a no-op success,
  not a failure — the SDK throws on this rather than silently accepting it. Timer is driven off
  `getBlockNumber()`, not the receipt's `expiresAt`, since that value is documented as an estimate.
- `takeOver(tag)`: when `claim` is absent but `lane` rows exist, read each lane owner's latest
  written index (via `fetchLatestUpdate`/walk-until-404) and resume from its `kind` header rather
  than restarting.
- `finish(agentId, tag)`: write lane content → write the `lane` row (once ever, not per update) →
  write `done` → delete own claim, in that exact order. (Matches the crash-safety property already
  established for `src/memory.mjs`: a crash between any two of these leaves the safer of the two
  possible states, never a worse one — confirmed by tracing all three crash windows.)
- `verify(tag)`: the reporting agent polls for a `done` row via `queryByTagAndType`, reads the
  finishing agent's lane, and writes a `verdict` row carrying `outcome`.

## 5. Live view (`src/arkiv.mjs`'s `watchMemories`, extended)

Add `onExpiryExtended` and `onEntityDeleted` handlers alongside the existing `onEntityCreated` —
today only creation is wired, so the demo's most important visual (a lease being renewed, then
silently lapsing) has no event path feeding it.

## Explicitly deferred (documented as known limitations, not built)

- Multi-chunk splitting for memories over 4KB.
- Real per-agent key custody (would need agents as separate processes) — the actual fix for the
  encryption honesty gap noted in §2.
- Lane content ordering across multiple historical owners beyond the `lane` row's shared 600-block
  TTL as an ordering proxy.
- `Stamper.fromState` persistence — sidestepped by keeping this to one process for the demo.

## Testing

Following this repo's existing convention (`scripts/feedback/`, Bash-runnable, `pass()/fail()`
style, no jest): a new `scripts/verify-lane.mjs` proves the stamped-envelope lane write/read round
trip live against the gateway before the protocol is built on top of it — this is the piece the
review flagged as previously asserted "verified" with no reproducer in the repo. A second script
exercises the tie-break with two concurrent claim attempts against the same tag.
