# Agent Memory Mesh: the 3-minute video

The shooting script. One video, three minutes, four unbroken clips. Everything said is
written out below, next to what has to be on screen while it's said. Evidence a judge might
want to check (block heights, transaction hashes, the `deleteEntity` count) lives in
`README.md` and `feedback.md`, so the video only has to be convincing, not exhaustive.

Judging weights, and where each one is earned:

| Weight | Criterion                                                                                             | Clip |
| ------ | ----------------------------------------------------------------------------------------------------- | ---- |
| 30%    | Why Arkiv / Web3 database. Needs the capability, the query, and the trade-off against a Web2 database | 1    |
| 25%    | Technical execution. Needs a working flow beginning to end, with the Arkiv reads and writes behind it | 2    |
| 20%    | Usefulness and adoption. Needs the users, their problem, and a route to the first 100                 | 3    |
| 25%    | Arkiv feedback. Needs specific observations, what worked, and reproducible problems                   | 4    |

## Before recording

- `npm start` running, wallet funded on Tiramisu, one memory already written so the feed
  isn't empty on the first frame.
- Record natively at 1920x1080. Terminal on the left at about 40% width, font 18 to 20pt.
  Two browser windows stacked on the right, page zoomed to roughly 125%.
- Notifications off, bookmarks bar hidden, clean shell prompt.
- Devtools open in the right-hand browser window on the Network tab, filtered to WS.
- Second terminal tab ready with `node --env-file=.env scripts/demo-expiry.mjs`. Start it before
  clip 2 rolls, because clip 2 comes back to it after the lease has already lapsed.
- Record clip 2 three times and keep the best one. The agent picks its own wording each run.
- Cut only between clips. A splice inside clip 2, between the write and the panel updating, is
  the one edit that would cost us the whole argument.
- Record the screen with live narration as a guide track, then re-record the voiceover to
  picture so it lands at 3:00 without drifting.

Clip 0

Hey so I am Lev and I decided to build a share-able memory mesh for agents based on the provided software

This is a storage system that uses Arkiv to idnex the memories written adn signed by agents stored on swarm.

## Clip 1, 0:00 to 0:36, why Web3 / Arkiv

Show: tthe visusalisation.png

Say, 89 words:


Every agent framework keeps memory in one bucket. A vector DB, a Postgres table, a JSON
blob. That bucket can't say whose memory it is once the host app changes, can't expire
anything without a cleanup job, and can't tell a second agent that something moved.

Arkiv does all three. Our whole product is one query: agent_id atlas, memory_type task,
importance over seven, on typed attributes.  So you can filter data as in Web2 databases if requried, with multi-agent workflows being facilited by agent signatures ont he memories that allow one agent to reference the toehr and leave a clear trace of what was written and by whom.

## Clip 2, 0:36 to 2:12, the demo

Show: terminal left, mission-control page right, both in frame the entire time. Never
full-screen the terminal. The right half moving on its own is the point of this clip.

161 spoken words, about 67 seconds, so roughly 29 seconds of the window is commands running.
Four beats, one continuous take.

Beat 1. Run `npm run agent -- atlas "remember that I prefer dark mode and 24-hour time"`.

> This is Atlas, a real Claude session with two tools, remember and recall. I've told it a preference, and it decided by itself to split that into two memories, one per preference, each with its own lifetime.
>
> So now on the right half we see a websocket. That's a websocket on watchEntityEvents, and it just picked up both writes as they landed. Each
> one went encrypted to Swarm first, and the Arkiv entity holds the pointer plus agent_id, memory_type, tag and importance.


Beat 2. 

> Now as we can see the second agent, Nova, a separate process that has never spoken to Atlas. It checked its own memories,
> found nothing, queried Atlas's, and answered correctly. It uses the compound query.

Beat 3. Now we write another memory that has a shorter expiry to check that it works.

> This one I started ninety seconds ago, with an eight block lease. Same query before: one row. Same query after: zero. Nothing deleted it, no cleanup job ran. The row stopped existing because its lease ran out.

Beat 4. Said over the expiry output, still on screen.

> Nothing here is mocked, all is live onchain and all writes can be traced through the links.

## Clip 3, 2:12 to 2:40, who it's for

Show: the public deployment at `agent-memory-mesh.vercel.app`, then the repo.

Overlay, three seconds: `atlas-ethrome26.eth · nova-ethrome26.eth · ENSv2 beta, Sepolia`
with both registration transaction hashes. ENS gets no spoken words, so this card is where
it earns its place.

Say, 66 words:

> Who needs this: us, this week. Our agents' memory is locked to one framework's session
> store, and an agent's identity is just an API key. On September 14th we present Agent
> Memory Mesh as the memory layer for an enterprise agent deployment at the HPE and NVIDIA
> hackathon in Geneva. The repo is public with setup docs, so the builders in that room are
> our first hundred users.

## Clip 4, 2:40 to 3:00, feedback

Show: `feedback.md` on GitHub, scrolled to finding 3, with the 1/6 versus 6/6 table visible.

Overlay: `feedback.md · 4 findings · 4 runnable scripts`.

Say, 54 words:

> Four findings in `feedback.md`, each with a script you can run yourself. The sharpest:
> Arkiv's concurrent writes silently drop without viem's nonce manager, one of six landed, no
> error mentioning a nonce. Wire in the nonce manager and it's six of six. Expiry behaved
> exactly as documented, every time we tested it.

## Timing

| Clip            | Window     | Spoken words | Talking time |
| --------------- | ---------- | ------------ | ------------ |
| 1, why Arkiv    | 0:00–0:36 | 89           | 0:37         |
| 2, demo         | 0:36–2:12 | 161          | 1:07         |
| 3, who it's for | 2:12–2:40 | 66           | 0:27         |
| 4, feedback     | 2:40–3:00 | 54           | 0:22         |
| Total           | 3:00       | 370          | 2:33         |

370 words at 145 a minute is 2:33 of talking. The other 27 seconds are commands executing in
clip 2. If a take runs short, the spare seconds belong to holding on the expiry output a beat
longer.
