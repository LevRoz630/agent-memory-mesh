# Hydra — walkthrough video plan

Hard cap 3:00. About 400 words of voiceover.

The video only shows what works. The written submission carries the rest: why Arkiv and Swarm, feedback,
evidence, limitations. So no slides of arguments, no code tour, no feedback segment.

Demo: http://46.225.217.63:8787/control.html (no password).

## Timeline

### 0:00–0:15 · On camera

> Hi I am Lev and it's 4am haha, I have built Hydra - secure infrastructure behind agents that notice when a system goes down and finish the repair even if the previous agent has gone dark with it: liveness and claims on Arkiv, work log and reports on Swarm.
>
> Hydra is for autonomous agents that look after servers or databases. Usually the agent watching a machine runs on that same machine, so when the machine goes down, the agent goes down with it and no help comes. With Hydra, agents on different machines watch each other. When one goes quiet, another one picks up its work.

### 0:15–0:30 · The setup, over the control room

- Three agents, three data centers, each agent its own process with its own wallet with wallet address being published on Arkiv such that other agents can share infomation through Swarm.
- Arkiv holds heartbeats and claims as rows that expire on their own as a feature adn those are used to monitor the health of the agents and the progress on the  tasks.
- Swarm holds each agent's encrypted work log and records of actions.

### 0:30–2:30 · One real run

Recorded in one take; waits sped up 2–4x with a visible speed badge. Say the mission name when it appears.

1. **0:30 Rack failure.** Click *Simulate rack failure in DC-1*. Atlas files the incident, the agents
   race for the claim, and the winner starts working. Open the claim entity on the explorer and point at its TTL.
2. **0:55 Cut power** on the claim holder's data center. Its process is killed; nothing is announced.
   Its lease bar drains and *Live from Arkiv* shows "heartbeat expired on its own". Open the heartbeat
   entity: create and extends, no delete. **Built to expire. Live wire.**
3. **1:15 Takeover.** A peer notices the lapse, files the outage, reads the dead agent's lane on Swarm
   and resumes after the steps already done. Open the lane chunk on the gateway.
4. **1:35 Second cut** on the new worker mid-fix. The last agent resumes from the furthest step and
   finishes, while working both outages.
5. **1:55 Revival.** The survivor powers the dead data centers back on; their agents boot and a
   revived agent verifies the fix. The finisher can't verify its own work.
6. **2:15 Receipt.** Open the public receipt on Swarm. *Open as Sol* decrypts; *Open as an outsider*
   gets ciphertext.

### 2:30–3:00 · Close, on camera

> So in summary we have a distributed maintanance system that monitors it's  own health through heartbeat as well as the health of the servers. Not to mention  that your sensitive security incident reports are not stored on some big companies server and are not exposed to  centralised downtime risk. And you don't event need to clean up the todos as they expire automatically.

## Before recording

- Nobody else should run the demo, a local run or `npm run verify:*` during the take: they share
  the agent wallets, and a live heartbeat from one hides a kill in the other. The demo has no
  password now, so record at a quiet time.
- A raw run is well over 90 s; record it whole and edit the waits down.
- Cut the first agent's power only after the claim shows in the timeline, or DC-1 goes dark
  before it files and no rack incident appears.
- Write down the final video timestamps and put them in the Arkiv form's reproduction answer.
