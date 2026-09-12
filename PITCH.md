# Hydra

Three AI agents fix an incident without a server coordinating them, and without trusting a
central place with what the incident actually was.

## The problem

Multi-agent systems today assume a coordinator: a queue, a database, a process that's up. That
coordinator is also the single thing that takes the whole system down with it, and it's also the
one place holding everything the agents said to each other — including, in an incident-response
context, the details of the incident itself.

Hydra removes both assumptions at once. Coordination lives on Arkiv, a chain where every row
expires on its own — a lease that isn't renewed just stops existing, with no server watching the
clock. Content lives on Swarm, encrypted before it ever leaves the agent that wrote it, so the
storage layer never sees what it's storing. Neither system is a coordinator anyone can take down
to stop the work; neither is a party anyone has to trust with the incident's contents.

## What it actually does

Atlas watches for incidents and never fixes them. Nova and Sol are identical remediation
workers — neither is special, and that's the point: either can pick up what the other drops.

1. Atlas detects an incident and files it.
2. Nova claims it — an 8-to-12-block lease, the shortest-lived thing in the system on purpose.
3. Nova starts working and publishes its diagnosis to its own lane on Swarm: a per-agent,
   append-only feed that survives Nova regardless of what happens to Nova next.
4. Nova's process dies. Nothing notices. Nothing has to — the lease simply isn't renewed, and the
   chain stops answering for that claim at the block it was due to expire.
5. Sol queries for open claims, finds none, reads Nova's lane, and resumes from Nova's diagnosis
   instead of starting over. Sol finishes and publishes the fix.
6. Atlas checks Sol's fix against the original signal and writes a verdict: fixed, or reopened.

Every step above is a real write against a live testnet and a live Swarm gateway — nothing here
is simulated in front of a mock. Two agents racing to claim the same incident resolve
deterministically: both write, both wait for the write to actually be visible on-chain, and the
lower entity key wins while the other backs off and retries elsewhere.

## Why this needs decentralized storage specifically, not just a database

Swarm isn't a stylistic choice here. If mass infrastructure fails — the kind of event that takes
out both a company's servers and their database with it — an agent that can still reach Swarm and
Arkiv can still coordinate a fix. An agent that depends on a specific company's database can't. A
security incident report is also not something you want sitting in one company's database in the
first place: Hydra encrypts it before it's uploaded, so the storage layer is holding ciphertext it
can't read regardless of who operates it.

## What's real and what's demonstrated

Every agent signs with its own wallet — there's no shared identity, and the chain enforces that
only an agent can release or renew its own claim. Content is sealed per-recipient with real
ECIES (not a shared password), so a memory names exactly which agents can open it. In this
deployment, one process holds all three agents' keys — so today that's a demonstrated mechanism,
not an enforced boundary between adversarial parties. Splitting the workers into separate
processes with separate key custody is the next step, and the code is already shaped for it: the
crypto doesn't change, only who holds which key.

## Where we'd take it next

Split atlas/nova/sol into genuinely separate processes so the roster-based encryption becomes a
real trust boundary instead of a demonstrated one. Support memories over 4KB by splitting them
across multiple stamped chunks with a small manifest. Persist the Swarm stamper's bucket state
across restarts so a redeploy can't accidentally reuse a slot.
