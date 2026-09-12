# Agent Memory Mesh: the 3-minute video

The shooting script. One video, three minutes, four unbroken clips. Everything said is
written out below, next to what has to be on screen while it's said. Evidence a judge might
want to check (block heights, transaction hashes, the `deleteEntity` count) lives in
`README.md` and `feedback.md`, so the video only has to be convincing, not exhaustive.

The scenario: Atlas is a monitoring agent on one framework, Nova is a remediation agent on a
different one. They share no database, no session store, no API key. Atlas detects an
incident and files it. Nova claims it and works it. If Nova's own process dies mid-fix, the
claim has to expire on its own, without a cron job or a human noticing — because the outage
that killed Nova could just as easily have killed whatever was supposed to clean up after it.

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

Hey, I'm Lev, and I built a memory layer for agents that don't share infrastructure with each
other, on top of Arkiv and Swarm.

## Clip 1, 0:00 to 0:36, why Web3 / Arkiv

Show: the visualisation.png

Say:

Two agents, two frameworks, no shared database. One detects an incident, the other claims it
and fixes it. The claim has to expire on its own if the second agent crashes mid-fix, or the
task is stuck "in progress" forever. A cron job could do that cleanup, except the same outage
that killed the agent can take the cron job down with it — it's on the same infrastructure.

Arkiv's expiry isn't a process. It's enforced by block height, so it keeps running even when
everything else is down. Same query before the lease lapses: one row. Same query after:
zero. Nobody deleted it, nothing swept it, no service had to be alive to make that happen.
That's the one thing a Postgres table with a TTL column can't promise you.

## Clip 2, 0:36 to 2:12, the demo

Show: terminal left, mission-control page right, both in frame the entire time. Never
full-screen the terminal. The right half moving on its own is the point of this clip.

Four beats, one continuous take.

Beat 1. Run `node --env-file=.env scripts/agent-chat.mjs atlas "API latency on
checkout-service just spiked to 4200ms p99, starting 02:11 UTC. File this as a task for
remediation, high priority, short-lived."`

> Atlas is a real Claude session with two tools, remember and recall, deciding for itself
> what to write. It picked memory type task, high importance, and a short lease.
>
> On the right, that's a websocket on watchEntityEvents picking up the write as it lands.
> The detail — the actual log excerpt, the affected endpoints — went encrypted to Swarm
> first, because it's too big for an Arkiv attribute to hold. Arkiv only gets the pointer,
> plus agent_id, memory_type, tag and importance.

Beat 2. Run `node --env-file=.env scripts/agent-chat.mjs nova "Anything flagged for
remediation right now?"`.

> Nova is a separate process, a different framework — it never talks to Atlas's app at all.
> It queried the shared index for anything tagged agent_id atlas, found the incident, and
> claimed it — its own entry, its own short lease, saying "I've got this." The detail itself
> came straight from Swarm by the pointer in that entry, so Nova never touched Atlas's
> server, only the public index and the public content store.

Beat 3. Cut to the second terminal tab, expiry output already complete.

> This is what happens if the agent holding a claim dies before finishing. I gave this one
> an eight-block lease instead of waiting on a real crash. Same query before: one row. Same
> query after: zero. Nothing deleted it, no cleanup job ran, and no other service had to be
> up to make that happen — the claim just stopped existing on schedule.

Beat 4. Said over the expiry output, still on screen.

> Once that claim is gone, any other agent can pick the task back up. Nothing here is
> mocked. Every write is live and traceable through the links, and neither agent ever had to
> trust the other's server with its own diagnostics.

## Clip 3, 2:12 to 2:40, who it's for

Show: the public deployment at `agent-memory-mesh.vercel.app`, then the repo.

Say:

> Who needs this: me, this week. Platform teams stitching together agents across LangChain,
> CrewAI and AutoGen hit this exact wall — memory locked to one framework's session store,
> coordination that only survives if every service involved stays up. On September 14th I
> present Agent Memory Mesh as the memory layer for an enterprise agent deployment at the
> HPE and NVIDIA hackathon in Geneva. The repo is public with setup docs, so the builders in
> that room are our first hundred users.

## Clip 4, 2:40 to 3:00, feedback

Overlay: `feedback.md · 4 findings · 4 runnable scripts`.

Say:

> Four findings in `feedback.md`, each with a script you can run yourself. The sharpest:
> Arkiv's concurrent writes silently drop without viem's nonce manager, one of six landed, no
> error mentioning a nonce. Wire in the nonce manager and it's six of six.

## Timing

| Clip            | Window     | Talking time |
| --------------- | ---------- | ------------ |
| 1, why Arkiv    | 0:00–0:36 | 0:36         |
| 2, demo         | 0:36–2:12 | 1:08         |
| 3, who it's for | 2:12–2:40 | 0:28         |
| 4, feedback     | 2:40–3:00 | 0:22         |
| Total           | 3:00       | 2:34         |

The other 26 seconds are commands executing in clip 2. If a take runs short, the spare
seconds belong to holding on the expiry output a beat longer.
