# Hydra — pitch deck outline

Concept-test outline for tonight. 8 slides, ~3 min spoken, matched to ETHRome's video cap.
Each slide: on-slide content, then a speaker note (what you say, not what's written).
Format target: Google Slides / PPTX, built from this outline.

---

## 1. Title

**On slide:**

- Hydra
- Secure and metldown-immune knowledge layer for autonomous agents

**Speaker note:** Say the name is a Hydra — cut one head off, another grows back. That's
the whole pitch in one image: kill an agent mid-task, another one picks the task back up.

---

## 2. The problem

**On slide:**

- We have Atlas who is monitoring some system's health/performance
- Atlas detects an incident, files Arkiv issue with expiry date that is published and is accessible to development agents.
- Nova or Sol claims it and works the fix recording that they are working and worked on it.
- A cron  job or a regualr check from the same machine would be exposed to the same risk as the agent

**Speaker note:** This is the failure mode of every "one agent handles it" design: single
point of failure, silent stalls, no one left even to notice something dropped.

---

## 3. The split

**On slide:**

- Two different needs, two different stores:
  - Small, typed, queryable, must expire on its own → **Arkiv**
  - The incident itself (logs, reasoning, sensitive detail), arbitrary size, must stay private → **Swarm**
- Joined by one pointer: Arkiv holds a 64-hex reference to the Swarm blob.

**Speaker note:** Arkiv values are capped at 128 bytes — an incident report doesn't fit, so
Arkiv is the index, Swarm is the content. That's the entire architecture in one sentence.

---

## 4. Why Arkiv

**On slide:**

- Claims expire by block height, not by any process remembering to clean up.
- No cleanup job required as a dead agent's claim lapses on its own.
- Typed, queryable index shared across all development agents.
- Easy to reference pointers to Swarm provisions

**Speaker note:** Map this straight to their judging weights: technical execution (it
actually runs against Tiramisu live) and the feedback report we filed — reproducible
findings, not vague complaints.

---

## 5. Why Swarm

**On slide:**

- Sensitive incident detail shouldn't sit on someone else's servers.
- Decentralized storage means a fix can still be found and applied even if your servers or majority of the world's infrastructure melted down.
- Clear trace of the issue history and fixes for auditability.
- History of agent failures with clear marks for agent-workflow debugging.

**Speaker note:** This is the resilience argument, not just the privacy one — the whole
point of decentralizing is that losing your own infrastructure doesn't mean losing the
ability to respond to what caused the loss.

---

## 6. The protocol (the Hydra mechanic)

**On slide:**

- Claim → work → done / verdict
- Tie-break handling when two agents claim at once.
- Orphaned claims are closed automatically.
- Any agent can pick up a lapsed claim and keep going.

**Speaker note:** This slide is where the name pays off — walk through one claim getting
dropped and another agent picking it up, live, without anyone hand-holding the handoff.
