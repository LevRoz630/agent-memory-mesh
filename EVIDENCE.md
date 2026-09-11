# Evidence log

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

Still open: setting a text record on each name (the agent profile string, per
`docs/PRODUCT.md` Component 3) — registration and records are separate steps per ENS's own
docs, not done yet.

## Arkiv — Tiramisu

Not yet written — next block in `docs/build-plan.md`.

## Swarm

Not yet written.
