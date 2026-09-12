# Hydra — pitch deck outline

## Feedback log

1. **Need a concrete use case** (company, who it serves, how it makes money). Addressed:
   slides 2, 3 and 8.
2. **Audit claim on the Swarm slide was wrong.** Swarm chunks are content-addressed only:
   no query, no history. The queryable audit trail is Arkiv (`queryByTag` /
   `queryByTagAndType`). Addressed: moved to slide 5, Swarm slide reworded.

3. **Slide 3 and 7 described only a single hand-off and claimed no liveness tracking exists.**
   Both are now stale: the demo does a double hand-off (two agents die in sequence), and
   heartbeats — the same expiring-lease trick as claims — are the liveness signal. Addressed:
   slide 3 speaker note and slide 7 reworded.

Open: `src/swarm.mjs` talks to one public gateway (`api.gateway.ethswarm.org`). If a judge
asks "isn't that a single point of failure?", the honest answer is that it is for the demo,
and a production deployment points each data center at its own Bee node or a different
gateway.

Each slide: on-slide content, then a speaker note (what you say, not what's written).
Format target: PPTX.

---

## 1. Title

**On slide:**

- Hydra
- Secure and meltdown-immune knowledge layer for autonomous agents

**Speaker note:** Cut one head off, another grows back. Kill an agent mid-task, another
one picks the task back up.

---

## 2. The problem: the fixer dies with the outage

**On slide:**

- When a data center or network goes down, the tools meant to fix it often go down too.
- Monitoring, watchdogs and recovery agents run on the same infrastructure they protect.
- A cron job or a check on the same machines is exposed to the same failure.
- The bigger the outage, the fewer responders are left to notice and act.

**Speaker note:** If the thing that responds to a failure lives where the failure is, it
fails too.

---

## 3. The customer: a hosting provider

**On slide:**

- A mid-size hosting provider: a few thousand servers across 3–4 data centers.
- One watchdog agent per data center that detects dead servers and recovers them.
- The story:
  1. **Atlas** (DC-1) sees a rack go dark and files the incident.
  2. DC-1 loses power. Atlas dies with it. The incident is still open.
  3. **Nova** (DC-2) finds the unclaimed incident, claims it and starts recovery.
  4. Nova's region fails mid-fix. Its claim expires on its own.
  5. **Sol** (DC-3) takes over and finishes.

**Speaker note:** This is the demo you're about to see. Every agent proves it's alive with the
same trick a claim already uses — a lease that expires unless renewed — so "is Atlas still up?"
is a query, not a separate monitoring system. No agent had to be told the others died; each one
noticed on its own.

---

## 4. The split

**On slide:**

- Two different needs, two different stores:
  - Small, typed, queryable, must expire on its own → **Arkiv**
  - The incident itself (topology, out-of-band access, affected customers), arbitrary
    size, must stay private → **Swarm**
- Joined by one pointer: Arkiv holds a 64-hex reference to the Swarm blob.
- Neither is hosted by the provider, so neither goes down with it.

**Speaker note:** Arkiv values are capped at 128 bytes. An incident report doesn't fit, so
Arkiv is the index and Swarm is the content.

---

## 5. Why Arkiv

**On slide:**

- Claims expire by block height. A dead agent's claim lapses without anyone acting.
- No agent registry to run, which would itself be a single point of failure.
- One typed, queryable index every data center's agent can read.
- The audit trail: query the full event → claim → done → verdict sequence for any
  incident, on-chain.

**Speaker note:** Why not a replicated database? Because you'd be running it on your own
infrastructure, or trusting one vendor to stay up. Runs live on Tiramisu; the feedback
report has reproducible findings.

---

## 6. Why Swarm

**On slide:**

- Recovery details can be fetched from any surviving data center, not stored in the one
  that failed.
- Encrypted to the agent roster: no gateway or vendor ever sees plaintext, including us.
- Content-addressed, not queryable. It doesn't need to be, because Arkiv is the index.

**Speaker note:** The data an agent needs to fix the outage can't live on the machines
that are down, and it's too sensitive to hand to a third party in the clear.

---

## 7. The protocol (the Hydra mechanic)

**On slide:**

- Claim → work → done / verdict
- Tie-break handling when two agents claim at once.
- Orphaned claims are closed automatically.
- Every agent also renews its own heartbeat — the same expiring-lease mechanism, reused for
  "am I alive" instead of "am I working this."
- A peer confirms death two ways at once: the claim lapsed *and* the heartbeat lapsed. Either
  alone could just mean "running slow" — both together means gone.
- Any agent can pick up a lapsed claim and keep going, even from a second agent that also died
  mid-recovery.

**Speaker note:** This slide is where the name pays off. Walk through the double hand-off: one
agent dies mid-fix, a second picks it up from exactly where the first left off, and that second
agent dies too — the third has to find both their trails and prove both are actually gone before
finishing the job itself.

---

## 8. Business model

**On slide:**

- Customer: hosting, cloud and edge providers' SRE teams.
- Price: per protected server, per month.
- Hydra provides the SDK, the dashboard, and pays the Arkiv gas and Swarm postage, so the
  customer never touches tokens.
- The provider resells it as a premium tier: "auto-recovery even during a regional outage."
- If Hydra the company disappears, customers' agents keep working. The data is on Arkiv
  and Swarm, not with us.

**Speaker note:** That last point answers "why would I trust a startup with my
break-glass layer": you don't have to.
