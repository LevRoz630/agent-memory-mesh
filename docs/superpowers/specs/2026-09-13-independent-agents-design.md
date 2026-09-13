# Independent agent processes — design

Addresses the blockers in `docs/EVALUATION.md`: agents sharing one process, keys, stamper and
memory; spoofable queries; scripted claim order; self-attested verification.

## Goal

atlas, nova and sol each run as their own OS process holding only their own key. Everything one
agent learns about another comes from Arkiv or Swarm. The server launches processes, simulates the
data centers' out-of-band power API, and relays agent telemetry to the control room. It makes no
protocol decisions.

## Components

### `src/infra.mjs` — simulated data centers
In-memory state: `dcs: { atlas|nova|sol: { power: 'on'|'off' } }`, `racks: { R12: { dc: 'atlas', state: 'up'|'down' } }`.
`reset()` powers every DC on and sets R12 down. Mounted by the server:

- `GET  /infra/status` → `{ dcs, racks }`
- `POST /infra/dc/:id/power` body `{ state: 'on'|'off' }` → calls the fleet's `powerOff`/`powerOn`
- `POST /infra/rack/:id/power-cycle` → rack `up` (only if its DC has power)

These routes stand in for IPMI/Redfish. Agents call them over HTTP; they are unauthenticated and
bound to the same server, which is acknowledged as a demo stand-in.

### `src/fleet.mjs` — launcher and aggregator (server side)
- `start()`: SIGKILLs any running children, `infra.reset()`, new `runId`, forks
  `scripts/agent.mjs` three times.
- Each child's env is a whitelist: `PATH`, `ARKIV_HTTP_URL`, `SWARM_GATEWAY`, `SWARM_SIGNER_KEY`,
  `SWARM_POSTAGE_BATCH_ID`, `SWARM_BATCH_DEPTH`, `HYDRA_AGENT_ID`, `HYDRA_RUN_ID`,
  `HYDRA_INFRA_URL`, and only `ARKIV_PRIVATE_KEY_<SELF>`.
- `powerOff(id)`: SIGKILL, DC power off, agent `alive=false,status='dead'`, timeline entry.
- `powerOn(id)`: DC power on, fork the child again with the same `runId`, `alive=true`.
- Child IPC messages are folded into a state object with the shape `public/control.html` already
  renders (`id, tag, phase, report, stepsDone, agents, timeline, receiptRef, incidents`).
- `decrypt(as, ref)`: asks child `as` over IPC to download and decrypt; rejects if it is not running.

The Swarm postage signer key is still shared by all children: it pays for storage, it does not
identify an agent. Keys living in the launcher's `.env` is the provisioning stand-in.

### `scripts/agent.mjs` + `src/agent.mjs` — one agent
`createAgent({ agentId, runId, ops, send, timings })` runs, for itself only:

- **Heartbeat loop** and **profile publish** (unchanged protocol calls).
- **Peer watch** (`watchForPeerOutages`), which files outage `event` rows.
- **Rack monitor** (atlas only, since R12 is in its DC): polls `GET /infra/status`; when R12 is
  down and no `incident-<runId>` event exists on Arkiv, files it.
- **Incident discovery**: polls Arkiv `event` rows for `incident-<runId>` and
  `outage-<peer>-<runId>-` for each peer; starts a worker for every tag not yet `done` whose
  subject is not itself. No incident is ever handed over in memory.
- **Worker**: claim → renew → steps → finish, as today. Steps call the infra API:
  - rack: `diagnose R12` (GET status), `power-cycle R12` (POST), `confirm R12 up` (GET, throws if down)
  - outage of peer P: `ping P's DC` (GET), `power on P's DC` (POST on), `confirm P's DC has power` (GET)
- **Verify loop**: for every discovered `done` tag it did not finish, calls protocol `verify` with a
  probe that checks infra status itself (rack up / DC powered). Outcome `fixed` only if the lane has a
  `fix` entry **and** the probe passes, else `reopened`. A `reopened` verdict is recorded; reopening
  the work itself is out of scope.
- **Receipt**: the finisher publishes the SVG receipt from its own events for that tag.
- Sends `{ type: 'event'|'status'|'report'|'receipt'|'incident', ... }` to the parent. Events
  include the entity key or Swarm ref where one exists.
- Handles `{ type: 'decrypt', id, ref }` by decrypting with its own key only.

No startup stagger: all live agents race on a claim and the tie-break decides.

`src/demo.mjs` is removed; its controller logic moves into `src/agent.mjs`. `src/demo-ops.mjs`
loses the hard-coded atlas signer and gains infra and discovery ops.

### `roster.json` + `src/roster.mjs`
`scripts/roster.mjs` writes `{ <agentId>: { address, publicKey } }` from the keys in `.env`,
committed. `sealForRoster` encrypts to these public keys; decryption only ever uses keys present in
the process's own env (in a child, just its own). `readProfile` resolves peer addresses from the
roster, not from `ctx.signers`.

### Owner filtering — `src/arkiv.mjs`
`runQuery` drops every row whose `owner` is not a roster address.

### Partitioned, persisted stamping — `src/swarm.mjs`
When `HYDRA_AGENT_ID` is set, stamping uses core-sdk's `stamp(signer, batch, address, slot)` with
`slot = count[bucket] * 3 + agentIndex`, refusing past `2^(depth-16)`. `count` is a `Uint32Array(65536)`
loaded from and written to `data/stamper-<agentId>.bin` after each stamp. Three processes share one
batch without colliding, and a restarted agent never reuses a slot. Without `HYDRA_AGENT_ID` the
existing `Stamper` is used (live test scripts).

### On-chain dedup
`verify` returns early if a `verdict` row already exists for the tag. Two verdicts in the ~2-block
visibility window remain possible and are accepted.

### Server
`server.mjs` wires fleet + infra. `/api/demo/start`, `/api/demo/kill/:id` (→ `powerOff`) and
`/api/demo/report` all require `DEMO_PASSWORD`. `?as=<agent>` goes through `fleet.decrypt`; the
outsider path keeps its random-key demonstration. The server holds no agent signer.

`scripts/orchestrator.mjs` drives the fleet headless with the same `agent@seconds` kill syntax.

## Error handling
- A child that exits on its own (crash) is shown as `status: 'error'` with its exit code; the launcher
  does not auto-restart it — its peers must notice and power its DC back on, same as a kill.
- Infra calls time out after 5s and throw, so the worker's existing retry path handles them.
- Unknown IPC message types are ignored.

## Testing
- Unit, fake ops (no network): port `demo-controller` and `demo-double-outage` scenarios to
  `src/agent.mjs` with three agent instances sharing one fake chain — takeover after a kill,
  resume from lane progress, outage filed by a peer, powered back on, verified by a non-finisher.
- Unit: stamper slot partition (three agents never produce the same bucket/slot; state survives a reload).
- Unit: roster owner filter drops foreign owners.
- Live: `tests/live/fleet.mjs` (`npm run verify:fleet`) boots the server, cuts DC-1 after the rack
  incident is filed, and asserts on Arkiv: outage event, `done` for the outage, DC-1 powered on and
  beating again, a verdict by a non-finisher.

## Out of scope
Separate hosts, network-partition simulation and fencing tokens, reopening work after a `reopened`
verdict, splitting content over 4 KB.
