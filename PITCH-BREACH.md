# Agent Memory Mesh: the 3-minute video

The shooting script. One video, three minutes, four unbroken clips. Everything said is written
out below, next to what has to be on screen while it's said. Evidence a judge might want to
check (block heights, transaction hashes, the `deleteEntity` count) lives in `README.md` and
`feedback.md`, so the video only has to be convincing, not exhaustive.

The scenario throughout is one incident. A payments vendor has a credential leak touching four
of its customers. The vendor's security agent has to notify one of those customers inside the
contractual window, tell them enough to act, name none of the other three, and prove months
later that it did all of that — to an insurer, a regulator and outside counsel who are not in
the room on the night and cannot be given an account on anybody's portal in advance.

Judging weights, and where each one is earned:

| Weight | Criterion                                                                                             | Clip |
| ------ | ----------------------------------------------------------------------------------------------------- | ---- |
| 30%    | Why Arkiv / Web3 database. Needs the capability, the query, and the trade-off against a Web2 database | 1    |
| 25%    | Technical execution. Needs a working flow beginning to end, with the Arkiv reads and writes behind it | 2    |
| 20%    | Usefulness and adoption. Needs the users, their problem, and a route to the first 100                 | 3    |
| 25%    | Arkiv feedback. Needs specific observations, what worked, and reproducible problems                   | 4    |

## Code changes this script depends on

Three edits, all cosmetic, none touching the write or query path. Make them before recording.

- `scripts/agent-chat.mjs`: add `incident` and `impact` to the `memoryType` enum in both the
  `remember` and the `recall` tool schemas.
- `scripts/run-demo.mjs`: replace the two prompts with the incident and impact prompts used in
  clip 2 below.
- `public/index.html`: add `incident` and `impact` to the `memoryType` select.

Atlas (`atlas-ethrome26.eth`) plays the vendor's security agent. Nova (`nova-ethrome26.eth`)
plays the customer bank's. The names aren't semantic and the script never pretends they are.

## Before recording

- `npm start` running, wallet funded on Tiramisu, one memory already written so the feed isn't
  empty on the first frame.
- Record natively at 1920x1080. Terminal on the left at about 40% width, font 18 to 20pt. The
  browser on the right, page zoomed to roughly 125%.
- Notifications off, bookmarks bar hidden, clean shell prompt.
- Devtools open in the browser window on the Network tab, filtered to WS.
- Second terminal tab ready with `node --env-file=.env scripts/demo-expiry.mjs`. Start it
  before clip 2 rolls, because clip 2 comes back to it after the lease has already lapsed.
- Record clip 2 three times and keep the best one. The agent picks its own wording each run.
- Cut only between clips. A splice inside clip 2, between the write and the panel updating, is
  the one edit that would cost us the whole argument.
- Record the screen with live narration as a guide track, then re-record the voiceover to
  picture so it lands at 3:00 without drifting.

Clip 0

Hey, I'm Lev, and I built a memory layer for agents that belong to organisations that don't
trust each other.

## Clip 1, 0:00 to 0:36, why Web3 / Arkiv

Show: the visualisation.png.

Say:

> Two-forty in the morning, a payments vendor confirms a credential leak. Their agent has to
> notify a customer bank's agent inside twenty-four hours, hand over indicators of compromise,
> and name none of the three other customers affected. The vendor's own portal is the natural
> place to log all this, except the vendor is the party under suspicion, so its logs are worth
> nothing in the argument that follows.
>
> Arkiv gives us the one thing that dispute needs. The index is public and queryable — agent
> id, memory type incident, importance over eight, on typed attributes — while the body stays
> encrypted on Swarm. So an insurer can prove the notification existed at a given block and
> still not be able to read it. More parties can check that a record matched than are allowed
> to open it, and that asymmetry is the whole product.
>
> The trade-off is honest: block-time writes and gas per record. This is tens of records per
> incident, each carrying legal weight, not a million chat turns. For the million chat turns,
> use Postgres.

## Clip 2, 0:36 to 2:12, the demo

Show: terminal left, mission-control page right, both in frame the entire time. Never
full-screen the terminal. The right half moving on its own is the point of this clip.

About 67 seconds, so roughly 29 seconds of the window is commands running. Four beats, one
continuous take.

Beat 1. Run `node --env-file=.env scripts/agent-chat.mjs atlas "We've confirmed a credential
leak on INC-4417. Record the indicators for the affected customer: source IPs 203.0.113.0/24,
token prefix sk_live_9f, first seen 02:40 UTC."`

> That's a real Claude session with two tools, remember and recall, deciding for itself what to
> write. It picked memory type incident, importance ten, and a lease of its own choosing.
>
> On the right, that's a websocket on watchEntityEvents, and it just picked the write up as it
> landed. The body went encrypted to Swarm first. The Arkiv entity holds the pointer plus agent
> id, memory type, tag and importance — and nothing that identifies the other three customers.

Beat 2. Run `node --env-file=.env scripts/agent-chat.mjs nova "Security just flagged something
on INC-4417 — is there anything from the vendor we should be acting on?"`

> Nova is the bank's agent. Separate process, never spoken to Atlas, no shared database. It
> checked its own memories, found nothing, ran the compound query against Atlas's, decrypted the
> indicators and wrote back its own impact record, signed under its own name. Two matched
> sessions, both blocked. The vendor now knows the blast radius at the bank without the bank
> shipping its logs into the vendor's tenant, during an incident about the vendor.

Beat 3. Cut to the second terminal tab, expiry output already complete.

> The contract says those log excerpts are purged in ninety days. I started this one earlier
> with a lease of eight blocks instead, so you can watch it inside a demo — the script prints the
> lease we asked for and the one Arkiv applied. Same query before: one row. Same query after:
> zero. Nothing deleted it and no cleanup job ran. The row stopped existing because its lease
> ran out.
>
> That matters because the party who benefits from keeping the evidence is the party who'd
> otherwise be running the cron job. An insurer can confirm the purge happened on its own, at
> two in the morning, with the vendor's servers dark.

Beat 4. Said over the expiry output, still on screen.

> One thing I won't oversell: the bank keeps its decryption key, so what expires is the
> authoritative discoverable record, not the secret. Nothing here is mocked. Every write is live
> on chain and traceable through the links.

## Clip 3, 2:12 to 2:40, who it's for and why the name

Show: the public deployment at `agent-memory-mesh.vercel.app`, then the repo.

Overlay, held for the ENS lines: `atlas-ethrome26.eth · nova-ethrome26.eth · ENSv2 beta,
Sepolia` with both registration transaction hashes and the owner address.

Say:

> Why a name and not just a public key. Because the people who need to verify this record
> aren't known on the night. The insurer turns up in week three, the regulator in week six,
> outside counsel after that. Nobody can issue them an API key in advance because nobody knows
> to. They get one string out of the contract and resolve it themselves.
>
> And the incident is a credential compromise, so the signing key is exactly the key you have to
> assume is burned. If identity is a public key, the identity is the thing that got stolen.
> With an ENSv2 name, the row was signed at the block the name pointed at that key, ownership
> history is on chain, and the vendor keeps operating under the same identity afterwards. Both
> names are registered on ENSv2 beta — hashes on screen.
>
> Between just these two companies, under contract, a cached public key would have been fine. It
> is the tail that needs the name.
>
> Who has this problem now: me, this week. On September 14th we present Agent Memory Mesh as the
> memory layer for an enterprise agent deployment at the HPE and NVIDIA hackathon in Geneva. The
> repo is public with setup docs, so the builders in that room are our first hundred users.

## Clip 4, 2:40 to 3:00, feedback

Overlay: `feedback.md · 4 findings · 4 runnable scripts`.

Say:

> Four findings in `feedback.md`, each with a script you can run yourself. The sharpest: Arkiv's
> concurrent writes silently drop without viem's nonce manager. One of six landed, no error
> mentioning a nonce. Wire the nonce manager in and it's six of six.

## Timing

| Clip                | Window    | Talking time |
| ------------------- | --------- | ------------ |
| 1, why Arkiv        | 0:00–0:36 | 0:36         |
| 2, demo             | 0:36–2:12 | 1:08         |
| 3, who it's for     | 2:12–2:40 | 0:28         |
| 4, feedback         | 2:40–3:00 | 0:18         |
| Total               | 3:00      | 2:30         |

The other 30 seconds are commands executing in clip 2. If a take runs short, the spare seconds
belong to holding on the expiry output a beat longer.
