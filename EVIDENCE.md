# Evidence log

## Public deployment

**`https://agent-memory-mesh.vercel.app`** — permanent, deployed under the project owner's
own Vercel account (logged in via `vercel login` mid-build). Full write→Swarm→Arkiv→query
round trip verified live against it.

One gotcha worth recording: the deployment-hash URL Vercel prints after `vercel deploy`
(`agent-memory-mesh-<hash>-leviticus.vercel.app`) returns a 302 to Vercel's own SSO login —
Deployment Protection is on by default for team/personal-account deployments. The stable
project-alias URL above (`agent-memory-mesh.vercel.app`, no hash, assigned automatically on
first production deploy) is **not** behind that wall and is the one to actually share.

To redeploy: `vercel deploy --yes -e ARKIV_PRIVATE_KEY=... -e MEMORY_ENC_KEY=...` from the
repo root (drop `--yes` if you want the interactive prompts). Before the login, an
anonymous `vercel deploy --temporary` path was used and also worked, but expires ~60
minutes after each deploy.

Getting a working deploy at all took two real fixes, both confirmed via
`.vercel/output/config.json` and live testing, not assumed:
1. First attempt failed outright (`FUNCTION_INVOCATION_FAILED` on every route, static
   files included) — Vercel's zero-config "express" framework detection had auto-wrapped
   `server.mjs` itself as a second function, and `server.mjs` calls `httpServer.listen()`
   and creates a `WebSocketServer`, neither valid inside a serverless function invocation.
   Fixed with `"framework": null` in `vercel.json`.
2. The deployment-hash URL's SSO wall, above.


Filled in as things actually happen, not reconstructed after the fact. Used for the
ETHRome submission form and Arkiv's Tally form, both of which ask for exact addresses and
transaction links, not a claim that something works.

## ENS — ENSv2 beta, Sepolia

Two agent identities, flat top-level names (see `docs/PRODUCT.md` Component 3 for why
flat names instead of a parent+subname hierarchy — true subname creation needed deploying
a custom subregistry, which didn't fit inside the 60-minute cap).

Owner (both): `0x0Ef440b8C9Ce507Ce5f84c6b9EA7FB8b2C11a006`

| Name | Register tx | Block |
|---|---|---|
| `atlas-ethrome26.eth` | [`0xe9c7380f9e07c85a2120f17df787891d088ba58ccadc8e8b9ba9f5a2c4abaa63`](https://sepolia.etherscan.io/tx/0xe9c7380f9e07c85a2120f17df787891d088ba58ccadc8e8b9ba9f5a2c4abaa63) | 11683692 |
| `nova-ethrome26.eth` | [`0xc7e9fa2fe1d25a026ef8fa8b4e15ca9d2a6cf159463f2d6e686f8cfea798b432`](https://sepolia.etherscan.io/tx/0xc7e9fa2fe1d25a026ef8fa8b4e15ca9d2a6cf159463f2d6e686f8cfea798b432) | 11683703 |

Contracts used (Sepolia ENSv2 beta, from `docs.ens.domains/learn/deployments`):
`ETHRegistrar` `0xa88553f454b77203b0d036a05c894d555eaaa2cc`,
`MockUSDC` `0x768f42455a2d082e23ceef7d51e5787c82d67a39`,
`PublicResolverV2` `0xe7b9a25607e02da8145e4eb1836ca539e53f11f7` (set as resolver at
registration).

Still open: setting a text record on each name. Attempted and blocked by a real limitation
in `PublicResolverV2` — see `friction.md` and the commit `87fe227` message for the
on-chain-confirmed root cause. Registration itself already satisfies "does real work" /
"end-to-end on live testnet data" without this.

## Arkiv — Tiramisu

Creator/owner wallet: `0x9F5997ecB905211a464F29090900468BDBa286C1`

**Write path**, live, `agent_memory` entities created via `src/memory.mjs`'s `writeMemory`
(encrypt → Swarm → Arkiv entity), e.g. entity
[`0xb762042b49aa288cb27f1084ccef3f234629a618812a8d4ecf93104d806a154a`](https://tiramisu.explorer.arkiv.network/)
via tx `0xb015b269f43680c96d0a927d5f137166f3db9190b01bf3cebe14803f38bd99a5`.

**Mission 02, Built to expire** — `scripts/demo-expiry.mjs`, run live:

| | |
|---|---|
| Entity key | `0x4cb58a281dc35289f6c0ec97b82e849799d52685155d6a637be056f9ea3c2fb1` |
| Creation tx | `0x1dd2c53a001667a26623e01d93540432a380d88e1de965836a997e1580ef4120` |
| Requested lifetime | 8 blocks |
| Applied expiry (from receipt) | block 323562 |
| Written at | block 323552 |
| Query before expiry | 1 row |
| Query after expiry (block 323565) | 0 rows |
| `deleteEntity` calls made | 0 |

Requested (8) and applied (10 blocks' worth, 323562−323552) differ, exactly as
`ExpirationTime.fromBlocks`'s own docs say they can — the tx landed a couple blocks after
the head was captured.

**Mission 03, Live wire** — `server.mjs` + `src/arkiv.mjs`'s `watchMemories`, live
end-to-end test: a `POST /api/memory` write triggered a real `EntityCreated` websocket
event, a bounded `getEntity` follow-up read, a Swarm fetch+decrypt, and a push to a
connected client over `/live` — no polling, no refresh, verified with
`scripts/ws-test-client.mjs` receiving the decrypted content within ~6s of the write.

## Swarm

Gateway: `api.gateway.ethswarm.org`, no postage stamp, no Bee node (see `src/swarm.mjs` and
`friction.md`/`docs/PRODUCT.md` for why `@snaha/swarm-id` wasn't used — it's browser-iframe
auth, no fit for a server writing memories programmatically).

Content is app-level AES-256-GCM encrypted before upload — the gateway never sees
plaintext. Example reference from a live write:
`0246bf131185b1c5829616bb4932194734bbbf50ec91a976a5bdcd8612e11e6b` (64 hex, plain reference
— app-level encryption means Swarm's own `Swarm-Encrypt` header and its 128-hex-ref
behavior aren't used here). Round-trip verified byte-for-byte via `src/swarm.mjs`'s live
test and again through every write in the full product flow.
