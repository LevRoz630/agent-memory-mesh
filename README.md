# Hydra

Hydra is three agents looking after three data centers. When one data center loses power in the middle of a repair, the other two notice, pick up the half-finished work and finish it. Nobody coordinates them. If there were a coordinator, it would sit in some data center too, and it could go dark in the same outage.

Coordination runs on [Arkiv](https://arkiv.network): heartbeats and work claims are rows that expire on their own. The work itself goes into an encrypted log on [Swarm](https://www.ethswarm.org) that outlives the agent that wrote it.

Live demo: http://46.225.217.63:8787/control.html

I built it at ETHRome 2026 (11–13 September).

## What happens in a run

1. A rack goes down in DC-1. Atlas, the agent there, files an incident: a row on Arkiv plus an encrypted report on Swarm.
2. The agents race to claim it. The winner holds a claim row that lasts 24 blocks and renews it while it works. Every step it finishes goes into its lane, an append-only feed on Swarm addressed from its own wallet.
3. You cut power to the winner's data center. Its process is killed (SIGKILL, no goodbye). It stops renewing its heartbeat, and after 16 blocks the row is gone. Nothing deleted it.
4. A peer's query for that heartbeat comes back empty twice in a row, so it files an outage. It reads the dead agent's location from a sealed profile feed, then reads its lane and resumes from the next unfinished step.
5. You can kill the new worker too. The last agent standing finds both lanes and continues from whichever got furthest.
6. The survivor powers the dead data centers back on through the power controller. A revived agent checks the rack and writes the verdict. The agent that finished the fix is never allowed to verify its own work.

The control room at `/control.html` shows all of this live from an Arkiv WebSocket subscription, with explorer links for every row.

### What's real and what isn't

Every Arkiv row is a real transaction on the Tiramisu testnet, and every lane entry and report is a real chunk on Swarm, stamped with our own postage batch. Killing an agent really kills its process, and peers find out only by querying Arkiv.

The rest is simulated. The power controller is an HTTP stub standing in for IPMI or Redfish. The repair steps are sleeps. All three agents run on one machine, although each is a separate process holding only its own key.

## Running it

You need Node 20 or newer, three funded Tiramisu wallets and a Swarm postage batch.

```sh
npm ci
cp .env.example .env
```

Fill in `.env`:

- `ARKIV_PRIVATE_KEY_ATLAS`, `ARKIV_PRIVATE_KEY_NOVA`, `ARKIV_PRIVATE_KEY_SOL` are the three agents' keys. Get testnet GLM for them from the [Arkiv faucet](https://hub.arkiv.network/faucet).
- `ARKIV_PRIVATE_KEY` is only used to top up the agents and by the live tests.
- `SWARM_SIGNER_KEY` and `SWARM_POSTAGE_BATCH_ID` are the key that owns your postage batch and the batch ID. Set `SWARM_BATCH_DEPTH` if the depth isn't 23.
- `DEMO_PASSWORD` is optional. If you set it, starting a run and cutting power ask for it. Leave it empty for a public demo.

If you changed the agent keys, regenerate the public roster, then start the server:

```sh
npm run roster
npm start
```

Open http://localhost:3000/control.html (or whatever `PORT` you set), press *Simulate rack failure in DC-1*, wait until a claim shows up in the timeline, and cut that data center's power.

To run it without the browser: `node --env-file=.env scripts/orchestrator.mjs atlas@14 nova@60` starts a run and kills atlas at 14 seconds and nova at 60.

Don't run two copies against the same wallets at once. A live heartbeat from one copy hides a kill in the other.

## Tests

`npm test` runs the unit tests. They don't touch the network.

The live tests spend Tiramisu gas and Swarm postage:

```sh
npm run verify:takeover       # a peer resumes a dead agent's lane
npm run verify:tie-break      # two agents claim at once, one wins
npm run verify:chain-watch    # the subscription sees a heartbeat renew and lapse
npm run verify:fleet          # a full run with real agent processes
node --env-file=.env tests/live/heartbeat-lapse.mjs
node --env-file=.env tests/live/claim-lapse.mjs
```

`npm run feedback:repro` reruns every issue from the Arkiv feedback report against the live network.

## Where things are

```
server.mjs              control room server and its live feed
public/control.html     the control room
scripts/agent.mjs       one agent process
src/agent.mjs           an agent's loops: heartbeat, peer watch, rack monitor, claim and work, verify
src/protocol.mjs        claims, renewals, heartbeats, outage detection, takeover, verification
src/arkiv.mjs           Arkiv reads and writes, filtered to roster wallets
src/chain-watch.mjs     the control room's WebSocket subscription
src/swarm.mjs           encryption, local stamping and uploads
src/lane.mjs            per-agent feeds on Swarm
src/fleet.mjs           starts, kills and revives agent processes
src/infra.mjs           the simulated power controller
arkiv-feedback/         feedback report and a repro script for each finding
docs/                   architecture and Arkiv schema
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the full design. [docs/ARKIV_SCHEMA.md](docs/ARKIV_SCHEMA.md) lists each row type, its TTL and the queries behind every decision.

## Why Arkiv and Swarm

Inside one company, etcd leases would do most of what Arkiv does here. Hydra is for the case where that breaks down: the thing holding the locks lives in the infrastructure that just failed, or the data centers belong to different operators who don't share a trusted database. On Arkiv, a claim expires at its block whether anyone is alive to clean it up or not. Only its owner can renew or release it, and everyone can check who filed, fixed and verified.

Swarm is there because the work log has to be readable after its writer is dead. A lane's address comes from the agent's wallet and the incident tag, so a peer can find it with no server on the other end. Reports can contain things like out-of-band management hosts, so everything is encrypted to the agent roster before upload, and the gateway only ever sees ciphertext.

## Known limitations

- No fencing. An agent only learns it lost its claim at the next renewal, which is fine for a sleep and not fine for a real power cycle.
- Detection takes a few blocks, since that's how long a lease lasts. Every renewal is a transaction, so cost grows with the number of agents.
- Uploads go through `/chunks` and are capped at 4 KB per item, because the public gateway won't take locally stamped `/bytes` uploads.
- Only the control room subscribes over WebSocket. The agents query instead, on purpose: expiry fires no event, and a dropped subscription shouldn't ever look like a dead peer.

## Prior work and third-party components

The repository started at ETHRome on 11 September 2026. The first commit was a README and planning notes, and all the code was written during the event. Nothing was carried over from an earlier project.

Third-party pieces:

- [`@arkiv-network/sdk`](https://www.npmjs.com/package/@arkiv-network/sdk) and the Arkiv Tiramisu testnet, RPC, explorer and faucet
- [`@ethersphere/bee-js`](https://www.npmjs.com/package/@ethersphere/bee-js) and the public Swarm gateway at `api.gateway.ethswarm.org`
- [`viem`](https://viem.sh) for accounts and transports
- [`express`](https://expressjs.com) and [`ws`](https://github.com/websockets/ws) for the control room server
- Node's built-in `crypto` for AES-256-GCM, ECDH and HKDF

I wrote the code with Claude Code, using the Arkiv MCP server and Arkiv Skills to look up docs and network details while building.

## License

MIT, see [LICENSE](LICENSE).
