# Agent Memory Mesh: the 3-minute video

The shooting script. One video, three minutes, four unbroken clips. Everything said is
written out below, next to what has to be on screen while it's said. Evidence a judge might
want to check (block heights, transaction hashes, the `deleteEntity` count) lives in
`README.md` and `feedback.md`, so the video only has to be convincing, not exhaustive.

Judging weights, and where each one is earned:

| Weight | Criterion | Clip |
|---|---|---|
| 30% | Why Arkiv / Web3 database. Needs the capability, the query, and the trade-off against a Web2 database | 1 |
| 25% | Technical execution. Needs a working flow beginning to end, with the Arkiv reads and writes behind it | 2 |
| 20% | Usefulness and adoption. Needs the users, their problem, and a route to the first 100 | 3 |
| 25% | Arkiv feedback. Needs specific observations, what worked, and reproducible problems | 4 |

## Before recording

- `npm start` running, wallet funded on Tiramisu, one memory already written so the feed
  isn't empty on the first frame.
- Record natively at 1920x1080. Terminal on the left at about 40% width, font 18 to 20pt.
  Two browser windows stacked on the right, page zoomed to roughly 125%.
- Notifications off, bookmarks bar hidden, clean shell prompt.
- Devtools open in the right-hand browser window on the Network tab, filtered to WS.
- Second terminal tab ready with `npm run demo:expiry`. Start it before clip 2 rolls, because
  clip 2 comes back to it after the lease has already lapsed.
- Record clip 2 three times and keep the best one. The agent picks its own wording each run.
- Cut only between clips. A splice inside clip 2, between the write and the panel updating, is
  the one edit that would cost us the whole argument.
- Record the screen with live narration as a guide track, then re-record the voiceover to
  picture so it lands at 3:00 without drifting.

## Clip 1, 0:00 to 0:36, why Arkiv

Show: the mission-control page, idle, one window, nothing running.

Overlay: project name, lower third, first five seconds.

Say, 89 words:

> Every agent framework keeps memory in one bucket. A vector DB, a Postgres table, a JSON
> blob. That bucket can't say whose memory it is once the host app changes, can't expire
> anything without a cleanup job, and can't tell a second agent that something moved.
>
> Arkiv does all three. Our whole product is one query: agent_id atlas, memory_type task,
> importance over seven, on typed attributes. The trade-off is honest: a write costs gas and
> waits for a block, so Arkiv holds the index and Swarm holds the content.

## Clip 2, 0:36 to 2:12, the demo

Show: terminal left, mission-control page right, both in frame the entire time. Never
full-screen the terminal. The right half moving on its own is the point of this clip.

187 spoken words, about 77 seconds, so roughly 19 seconds of the window is commands running.
Five beats, one continuous take.

Beat 1. Run `npm run agent -- atlas "remember that I prefer dark mode and 24-hour time"`.

> This is Atlas, a real Claude session with two tools, remember and recall. I've told it a
> preference, and it decided by itself to split that into two memories, one per preference,
> each with its own lifetime.
>
> Watch the right half. I didn't refresh it. That's a websocket subscription on
> watchEntityEvents, no polling loop, and it just picked up both writes as they landed. Each
> one went encrypted to Swarm first, and the Arkiv entity holds the pointer plus agent_id,
> memory_type, tag and importance.

Overlay, as the panel updates: `watchEntityEvents · webSocket transport · no fromBlock`. Let
the devtools WS pane be readable here, with no repeating query requests next to it.

Beat 2. Run `npm run agent -- nova "what do you know about my display preferences?"`.

> Now Nova, a separate process that has never spoken to Atlas. It checked its own memories,
> found nothing, queried Atlas's, and answered correctly. That's the compound query.

Beat 3. Write an unrelated entity from the second wallet.

> Here's an entity from a different wallet that has nothing to do with us. The event arrives,
> our filter rejects it, and the panel doesn't move.

Beat 4. Bring up the second terminal tab, where `demo:expiry` has already passed its boundary.

> This one I started ninety seconds ago, with an eight block lease. Same query before: one
> row. Same query after: zero. Nothing deleted it, no cleanup job ran. The row stopped
> existing because its lease ran out.

Overlay: `8 block lease · written at 323552 · expired at 323562 · deleteEntity calls: 0`.

Beat 5. Said over the expiry output, still on screen.

> Writes, live reads, a compound query and expiry, all against Tiramisu, nothing mocked.

## Clip 3, 2:12 to 2:40, who it's for

Show: the public deployment at `agent-memory-mesh.vercel.app`, then the repo.

Overlay, three seconds: `atlas-ethrome26.eth · nova-ethrome26.eth · ENSv2 beta, Sepolia`
with both registration transaction hashes. ENS gets no spoken words, so this card is where
it earns its place.

Say, 69 words:

> Who needs this: teams putting multi-agent systems into enterprises, where memory is locked
> to one framework's session store and the agent's identity is just an API key. That's us,
> this week. On September 14th we present this as the memory layer for an enterprise agent
> deployment at the HPE and NVIDIA hackathon in Geneva. The repo is public, so the builders in
> that room are our first hundred users.

## Clip 4, 2:40 to 3:00, feedback

Show: `feedback.md` on GitHub, scrolled to finding 3, with the 1/6 versus 6/6 table visible.

Overlay: `feedback.md · 4 findings · 4 runnable scripts`.

Say, 47 words:

> Four findings, each with a script that reproduces it live. The best one: without viem's
> nonce manager, one of six concurrent writes from the same wallet landed. With it, six of
> six, and the error never mentions a nonce. Expiry, for its part, behaved exactly as
> documented.

## Timing

| Clip | Window | Spoken words | Talking time |
|---|---|---|---|
| 1, why Arkiv | 0:00–0:36 | 89 | 0:37 |
| 2, demo | 0:36–2:12 | 187 | 1:17 |
| 3, who it's for | 2:12–2:40 | 69 | 0:29 |
| 4, feedback | 2:40–3:00 | 47 | 0:19 |
| Total | 3:00 | 392 | 2:42 |

392 words at 145 a minute is 2:42 of talking. The other 18 seconds are commands executing in
clip 2. The budget is spent, so anything added has to push something out. If a take runs
short, the spare seconds belong to beat 3 and to holding on the expiry output a beat longer.
