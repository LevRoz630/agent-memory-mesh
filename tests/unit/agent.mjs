// Three independent agents against one fake chain and one fake power controller. They share nothing
// else: every incident, claim, heartbeat and verdict one agent learns about goes through the fake
// chain, and a "kill" stops an agent and cuts its DC's power, the way SIGKILL does. No network.
//
//   node tests/unit/agent.mjs

import { createAgent, rackTag } from '../../src/agent.mjs'
import { createInfra } from '../../src/infra.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const AGENTS = ['atlas', 'nova', 'sol']
const LEASE_MS = 150
const SILENCE_MS = 80
const TIMINGS = { stepMs: 30, retryMs: 20, failedStepBackoffMs: 40, pollMs: 20, watchStartDelayMs: 40, monitorStartDelayMs: 10 }

function createWorld() {
  const runId = String(Date.now())
  const infra = createInfra()
  const chain = { events: new Map(), claims: new Map(), done: new Map(), verdicts: new Map(), lastBeat: new Map() }
  const steps = []
  const log = []
  const agents = new Map()
  const timeline = []
  let nextKey = 1

  function boot(agentId) {
    const agent = createAgent({
      agentId, runId, ops: opsFor(agentId), timings: TIMINGS,
      send: (msg) => { if (msg.type === 'event') timeline.push(msg) },
    })
    agents.set(agentId, agent)
    agent.start()
  }

  function kill(agentId) {
    agents.get(agentId)?.stop()
    agents.delete(agentId)
    infra.setDcPower(agentId, 'off')
    log.push(['kill', agentId])
  }

  function opsFor(agentId) {
    return {
      async startHeartbeat(id, shouldContinue) {
        while (shouldContinue()) {
          chain.lastBeat.set(id, Date.now())
          await sleep(10)
        }
      },
      async publishProfile() {},
      watchForPeerOutages(id, scope, onOutage) {
        let stopped = false
        const handled = new Set()
        ;(async () => {
          while (!stopped) {
            for (const peer of AGENTS) {
              if (peer === id || Date.now() - (chain.lastBeat.get(peer) ?? 0) < SILENCE_MS) continue
              const n = [...chain.done.keys()].filter((t) => t.startsWith(`outage-${peer}-${scope}-`)).length
              const tag = `outage-${peer}-${scope}-${n}`
              if (handled.has(tag)) continue
              handled.add(tag)
              const filed = !chain.events.has(tag)
              if (filed) chain.events.set(tag, { tag, entityKey: `0x${nextKey++}`, swarmRef: 'ab'.repeat(32), by: id })
              onOutage(peer, tag, { filed })
            }
            await sleep(10)
          }
        })()
        return () => { stopped = true }
      },
      async reportIncident(id, tag) {
        const row = { tag, entityKey: `0x${nextKey++}`, swarmRef: 'ab'.repeat(32), by: id }
        chain.events.set(tag, row)
        log.push(['report', id, tag])
        return { entityKey: row.entityKey, swarmRef: row.swarmRef }
      },
      async listIncidents() {
        return [...chain.events.values()].map(({ tag, entityKey, swarmRef }) => ({ tag, entityKey, swarmRef }))
      },
      async tryClaim(id, tag) {
        await sleep(2)
        if (chain.done.has(tag)) return { held: false }
        const held = chain.claims.get(tag)
        if (held && held.expiresAt > Date.now()) return { held: false }
        chain.claims.set(tag, { agentId: id, expiresAt: Date.now() + LEASE_MS })
        log.push(['claim', id, tag])
        return { held: true, entityKey: `claim-${id}-${tag}` }
      },
      async renewClaim(id, _key, shouldContinue) {
        while (shouldContinue()) {
          await sleep(LEASE_MS / 3)
          if (!shouldContinue()) break
          for (const held of chain.claims.values()) if (held.agentId === id) held.expiresAt = Date.now() + LEASE_MS
        }
        return { lost: false }
      },
      async releaseClaim(id, key) {
        const tag = key.slice(`claim-${id}-`.length)
        if (chain.claims.get(tag)?.agentId === id) chain.claims.delete(tag)
        log.push(['release', id, tag])
      },
      async readProgress(tag) {
        return steps.filter((s) => s.tag === tag).length
      },
      async nextLaneIndex(id, tag) {
        return steps.filter((s) => s.agentId === id && s.tag === tag).length
      },
      async recordStep(id, tag, step, _laneIndex, action) {
        steps.push({ agentId: id, tag, step, action })
      },
      async finish(id, tag) {
        chain.done.set(tag, id)
        chain.claims.delete(tag)
        log.push(['finish', id, tag])
      },
      async isDone(tag) {
        return chain.done.has(tag)
      },
      async verify(id, tag, probe) {
        if (chain.done.get(tag) === id) return { refused: true }
        if (chain.verdicts.has(tag)) return { outcome: chain.verdicts.get(tag).outcome, alreadyVerified: true }
        const outcome = (await probe()) ? 'fixed' : 'reopened'
        chain.verdicts.set(tag, { by: id, outcome })
        return { outcome, entityKey: `verdict-${tag}` }
      },
      async publishReceipt() {
        return 'cd'.repeat(32)
      },
      async infraStatus() {
        if (infra.status().dcs[agentId].power !== 'on') throw new Error('no power')
        return infra.status()
      },
      async setDcPower(dcId, power) {
        infra.setDcPower(dcId, power)
        log.push(['power', agentId, dcId, power])
        if (power === 'on' && !agents.has(dcId)) boot(dcId)
      },
      async powerCycleRack(rackId) {
        infra.powerCycleRack(rackId)
        log.push(['rack-cycle', agentId, rackId])
      },
    }
  }

  return {
    runId, infra, chain, steps, log, timeline, agents, boot, kill,
    stopAll: () => { for (const a of agents.values()) a.stop() },
  }
}

async function waitFor(cond, what, timeoutMs = 5000) {
  const started = Date.now()
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

const results = []
const check = (name, ok) => {
  results.push(Boolean(ok))
  console.log(`  ${ok ? 'pass' : 'FAIL'}: ${name}`)
}

console.log('scenario: nobody is scripted; the rack incident is filed, raced, fixed and independently verified\n')
{
  const w = createWorld()
  AGENTS.forEach(w.boot)
  const tag = rackTag(w.runId)
  await waitFor(() => w.chain.verdicts.has(tag), 'a verdict on the rack incident')
  check('atlas, in the rack\'s DC, filed the incident', w.log.find((l) => l[0] === 'report')?.[1] === 'atlas')
  check('the incident was filed once', w.log.filter((l) => l[0] === 'report').length === 1)
  check('the rack was actually power-cycled', w.infra.status().racks.R12.state === 'up')
  check('exactly one agent finished it', w.log.filter((l) => l[0] === 'finish' && l[2] === tag).length === 1)
  check('the verdict came from someone other than the finisher', w.chain.verdicts.get(tag).by !== w.chain.done.get(tag))
  check('the verifier\'s own probe passed', w.chain.verdicts.get(tag).outcome === 'fixed')
  w.stopAll()
}

console.log('\nscenario: the rack incident holder loses power mid-work\n')
{
  const w = createWorld()
  AGENTS.forEach(w.boot)
  const tag = rackTag(w.runId)
  await waitFor(() => w.steps.some((s) => s.tag === tag), 'the first rack step')
  const holder = w.chain.claims.get(tag).agentId
  w.kill(holder)
  await waitFor(() => w.chain.done.has(tag), 'the rack incident to be finished')
  const outage = [...w.chain.done.keys()].find((t) => t.startsWith(`outage-${holder}-`))
  await waitFor(() => [...w.chain.done.keys()].some((t) => t.startsWith(`outage-${holder}-`)), `${holder}'s outage to be finished`)
  const outageTag = [...w.chain.done.keys()].find((t) => t.startsWith(`outage-${holder}-`)) ?? outage
  check(`a peer filed ${holder}'s outage`, w.chain.events.get(outageTag)?.by !== holder)
  check(`a peer powered ${holder}'s DC back on`, w.log.some((l) => l[0] === 'power' && l[1] !== holder && l[2] === holder && l[3] === 'on'))
  check(`${holder} is running again`, w.agents.has(holder))
  check('rack step 1 was not redone after the takeover', w.steps.filter((s) => s.tag === tag && s.step === 0).length === 1)
  check('the rack incident was finished exactly once', w.log.filter((l) => l[0] === 'finish' && l[2] === tag).length === 1)
  await waitFor(() => w.chain.verdicts.has(outageTag), 'a verdict on the outage')
  check('the outage verdict is fixed and not by its finisher', w.chain.verdicts.get(outageTag).outcome === 'fixed' && w.chain.verdicts.get(outageTag).by !== w.chain.done.get(outageTag))
  w.stopAll()
}

console.log('\nscenario: DC-1 loses power before atlas can file anything\n')
{
  const w = createWorld()
  AGENTS.forEach(w.boot)
  w.kill('atlas')
  const tag = rackTag(w.runId)
  await waitFor(() => w.chain.verdicts.has(tag), 'the rack incident to be filed after atlas comes back, and verified', 8000)
  const outageTag = [...w.chain.done.keys()].find((t) => t.startsWith('outage-atlas-'))
  check('atlas\'s outage was filed and finished by a peer', Boolean(outageTag) && w.chain.done.get(outageTag) !== 'atlas')
  check('atlas filed the rack incident only after it was powered back on',
    w.log.findIndex((l) => l[0] === 'report') > w.log.findIndex((l) => l[0] === 'power' && l[2] === 'atlas' && l[3] === 'on'))
  check('the rack is up', w.infra.status().racks.R12.state === 'up')
  w.stopAll()
}

console.log('\nscenario: a peer tries the rack while its data center is dark\n')
{
  const w = createWorld()
  AGENTS.forEach(w.boot)
  const tag = rackTag(w.runId)
  await waitFor(() => w.chain.claims.has(tag), 'someone to claim the rack incident')
  w.infra.setDcPower('atlas', 'off')
  await waitFor(() => w.timeline.some((e) => e.text.startsWith(`could not finish ${tag}`)), 'a rack step to fail on the dark DC')
  const failed = w.timeline.find((e) => e.text.startsWith(`could not finish ${tag}`))
  check('the agent whose step failed released its claim instead of letting it expire', w.log.some((l) => l[0] === 'release' && l[1] === failed.agentId && l[2] === tag))
  w.infra.setDcPower('atlas', 'on')
  await waitFor(() => w.chain.done.has(tag), 'the rack incident to be finished once DC-1 is back', 8000)
  check('the rack incident was still finished', w.infra.status().racks.R12.state === 'up')
  w.stopAll()
}

console.log('\nscenario: two peers lose power at once\n')
{
  const w = createWorld()
  AGENTS.forEach(w.boot)
  await waitFor(() => w.chain.lastBeat.size === 3, 'all three to beat')
  await sleep(TIMINGS.watchStartDelayMs + 20)
  w.kill('nova')
  w.kill('sol')
  await waitFor(() => ['nova', 'sol'].every((id) => [...w.chain.done.keys()].some((t) => t.startsWith(`outage-${id}-`))), 'both outages to be finished', 8000)
  check('atlas brought both back', w.agents.has('nova') && w.agents.has('sol'))
  check('both DCs have power', w.infra.status().dcs.nova.power === 'on' && w.infra.status().dcs.sol.power === 'on')
  const novaClaim = w.log.findIndex((l) => l[0] === 'claim' && l[2].startsWith('outage-nova-'))
  const solClaim = w.log.findIndex((l) => l[0] === 'claim' && l[2].startsWith('outage-sol-'))
  const firstFinish = w.log.findIndex((l) => l[0] === 'finish' && l[2].startsWith('outage-'))
  check('the two outages were worked concurrently, not one after the other', novaClaim > -1 && solClaim > -1 && Math.max(novaClaim, solClaim) < firstFinish)
  w.stopAll()
}

console.log('\nscenario: the verifier\'s probe disagrees with the finisher\n')
{
  const w = createWorld()
  AGENTS.forEach(w.boot)
  const tag = rackTag(w.runId)
  await waitFor(() => w.chain.done.has(tag), 'the rack incident to be finished')
  w.infra.reset()
  await waitFor(() => w.chain.verdicts.has(tag), 'a verdict')
  check('a rack that is down again is recorded as reopened', w.chain.verdicts.get(tag).outcome === 'reopened')
  w.stopAll()
}

await sleep(100)
const passed = results.every(Boolean)
console.log(`\nRESULT: ${passed ? 'passed' : 'FAILED'}`)
process.exit(passed ? 0 : 1)
