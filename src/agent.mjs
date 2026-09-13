// One agent, alone in its process. It learns about incidents and peers only from Arkiv, Swarm and its
// data center's power controller; what it tells the launcher through `send` is telemetry for the
// control room, never something another agent acts on.

import { AGENT_IDS } from './arkiv.mjs'

export const DATA_CENTERS = { atlas: 'DC-1 Frankfurt', nova: 'DC-2 Amsterdam', sol: 'DC-3 Milan' }

const RACK_STEPS = ['diagnose rack R12', 'power-cycle rack R12 via IPMI', 'confirm rack R12 is back up']

function outageSteps(peerId) {
  const dc = DATA_CENTERS[peerId]
  return [`ping ${dc}'s power controller`, `power on ${dc} via IPMI`, `confirm ${dc} has power`]
}

const INCIDENT_REPORT = {
  rack: 'R12',
  dataCenter: DATA_CENTERS.atlas,
  symptom: 'all 8 servers unreachable, top-of-rack switch silent',
  outOfBand: { ipmiHost: '10.12.0.1', user: 'ops-recovery' },
  affectedCustomers: ['acme-shop', 'nordic-cdn', 'lumen-games'],
}

const DEFAULT_TIMINGS = {
  stepMs: 6000,
  retryMs: 3000,
  // A step that failed (say, a rack whose data center is dark) won't succeed a few seconds later.
  failedStepBackoffMs: 15000,
  pollMs: 4000,
  // A just-written heartbeat stays invisible to queries for a block or two, so a watcher that starts
  // with the beats would read everyone's startup lag as an outage.
  watchStartDelayMs: 20000,
  // Monitoring comes up after the agent's own heartbeat and profile writes are under way.
  monitorStartDelayMs: 8000,
}

const MAX_VERIFY_ATTEMPTS = 5

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function rackTag(runId) {
  return `incident-${runId}`
}

export function createAgent({ agentId, runId, ops, send = () => {}, timings = {} }) {
  const t = { ...DEFAULT_TIMINGS, ...timings }
  let stopped = false
  const live = () => !stopped
  const timeline = []
  // Everything below is this process's own bookkeeping. Losing it on a restart is fine: every
  // decision that matters is re-read from the chain.
  const incidents = new Map()
  const working = new Set()
  const closed = new Set()
  const ownFixes = new Set()
  const verified = new Set()
  const verifyFailures = new Map()
  let stopWatch = null

  function event(text, extra = {}) {
    const entry = { at: Date.now(), agentId, text, ...extra }
    timeline.push(entry)
    send({ type: 'event', ...entry })
  }

  function setStatus(status) {
    send({ type: 'status', status })
  }

  function track(tag, fields) {
    const incident = incidents.get(tag) ?? { tag, subject: tag.startsWith('outage-') ? AGENT_IDS.find((id) => tag.startsWith(`outage-${id}-`)) : null }
    Object.assign(incident, fields)
    incidents.set(tag, incident)
    send({ type: 'incident', incident: { ...incident } })
    return incident
  }

  function stepsFor(incident) {
    return incident.subject ? outageSteps(incident.subject) : RACK_STEPS
  }

  async function performStep(incident, step) {
    const { subject } = incident
    if (subject) {
      if (step === 1) return ops.setDcPower(subject, 'on')
      const { dcs } = await ops.infraStatus()
      if (step === 2 && dcs[subject].power !== 'on') throw new Error(`${DATA_CENTERS[subject]} still has no power`)
      return
    }
    if (step === 1) return ops.powerCycleRack('R12')
    const { racks } = await ops.infraStatus()
    if (step === 2 && racks.R12.state !== 'up') throw new Error('rack R12 is still down')
  }

  async function probe(incident) {
    const { dcs, racks } = await ops.infraStatus()
    return incident.subject ? dcs[incident.subject].power === 'on' : racks.R12.state === 'up'
  }

  async function worker(tag) {
    const incident = incidents.get(tag)
    const steps = stepsFor(incident)
    while (live()) {
      if (await ops.isDone(tag)) {
        closed.add(tag)
        return
      }
      if (!live()) return
      setStatus('claiming')
      const claim = await ops.tryClaim(agentId, tag)
      if (!live()) return
      if (!claim.held) {
        setStatus('waiting')
        await sleep(t.retryMs)
        continue
      }
      event(`claimed ${tag} on Arkiv`, { tag, entityKey: claim.entityKey })
      setStatus('working')
      let workingOn = true
      let leaseLost = false
      let lostReason = ''
      // Renewal runs until finish() returns: the `done` row is what closes the incident, and a claim
      // that lapses before it lands lets a peer redo the work.
      const renewal = ops.renewClaim(agentId, claim.entityKey, () => workingOn && live())
        .then((result) => {
          if (!result?.lost) return
          leaseLost = true
          lostReason = `its lease lapsed${result.reason ? ` (${result.reason})` : ''}`
        })
        .catch((e) => {
          // Without renewals the claim lapses while this agent keeps working and a peer takes over.
          leaseLost = true
          lostReason = `its lease could not be renewed (${e.message})`
        })
      let failure = null
      let finished = false
      try {
        let step = await ops.readProgress(tag)
        if (step > 0) event(`found ${step}/${steps.length} steps already done on Swarm, resuming`, { tag })
        let laneIndex = await ops.nextLaneIndex(agentId, tag)
        while (step < steps.length && !leaseLost) {
          await sleep(t.stepMs)
          if (!live() || leaseLost) break
          await performStep(incident, step)
          await ops.recordStep(agentId, tag, step, laneIndex, steps[step])
          laneIndex += 1
          step += 1
          track(tag, { stepsDone: step })
          event(`step ${step}/${steps.length}: ${steps[step - 1]}`, { tag })
        }
        if (live() && !leaseLost && step === steps.length) {
          ownFixes.add(tag)
          await ops.finish(agentId, tag, claim.entityKey)
          finished = true
        }
      } catch (e) {
        failure = e
      } finally {
        workingOn = false
      }
      await renewal
      if (!live()) return
      if (!finished) {
        // Leaving the claim to expire would hold every peer off the incident for a whole lease.
        await ops.releaseClaim(agentId, claim.entityKey).catch(() => {})
        event(`could not finish ${tag}: ${failure ? failure.message : lostReason}; released the claim`, { tag })
        setStatus('waiting')
        await sleep(failure ? t.failedStepBackoffMs : t.retryMs)
        continue
      }
      closed.add(tag)
      track(tag, { phase: 'resolved', resolvedBy: agentId })
      setStatus('done')
      event(`${tag} resolved`, { tag })
      try {
        const receiptRef = await ops.publishReceipt({
          tag, phase: 'resolved', report: incident.report ?? null,
          agents: { [agentId]: { status: 'done' } },
          timeline: timeline.filter((e) => e.tag === tag),
        })
        track(tag, { receiptRef })
        event('published a public receipt on Swarm', { swarmRef: receiptRef })
      } catch (e) {
        event(`receipt upload failed: ${e.message}`)
      }
      setStatus('watching')
      return
    }
  }

  // A worker that failed is not restarted here; the next discovery poll starts it again while the
  // incident is still open.
  function startWorker(tag) {
    if (working.has(tag) || closed.has(tag) || !live()) return
    working.add(tag)
    worker(tag).then(
      () => working.delete(tag),
      (e) => {
        working.delete(tag)
        if (!live()) return
        setStatus('error')
        event(`error on ${tag}: ${e.message}`)
      },
    )
  }

  function consider(row) {
    const known = incidents.has(row.tag)
    const report = row.entityKey ? { report: { entityKey: row.entityKey, swarmRef: row.swarmRef } } : {}
    const incident = track(row.tag, known ? report : { phase: 'running', stepsDone: 0, ...report })
    if (incident.subject !== agentId) startWorker(row.tag)
  }

  async function discoverLoop() {
    while (live()) {
      try {
        for (const row of await ops.listIncidents(runId)) consider(row)
      } catch (e) {
        event(`incident discovery failed: ${e.message}`)
      }
      await sleep(t.pollMs)
    }
  }

  // Racks are watched by the agent in the same data center. The incident tag is per run, so filing
  // is skipped whenever the chain already has it, including after this agent restarts.
  async function monitorLoop() {
    await sleep(t.monitorStartDelayMs)
    const tag = rackTag(runId)
    while (live()) {
      try {
        const { racks } = await ops.infraStatus()
        const down = Object.entries(racks).filter(([, r]) => r.dc === agentId && r.state === 'down')
        if (down.length > 0 && !incidents.has(tag) && !(await ops.listIncidents(runId)).some((r) => r.tag === tag) && live()) {
          event(`rack ${down[0][0]} in ${DATA_CENTERS[agentId]} stopped responding`)
          const written = await ops.reportIncident(agentId, tag, INCIDENT_REPORT)
          send({ type: 'report', tag, ...written })
          event('filed the incident: index on Arkiv, encrypted report on Swarm', written)
          consider({ tag, ...written })
        }
      } catch (e) {
        event(`rack monitoring failed: ${e.message}`)
      }
      await sleep(t.pollMs)
    }
  }

  async function verifyLoop() {
    while (live()) {
      await sleep(t.pollMs)
      for (const [tag, incident] of incidents) {
        if (!live()) return
        if (verified.has(tag) || ownFixes.has(tag)) continue
        if (!(await ops.isDone(tag))) continue
        if (!live()) return
        verified.add(tag)
        try {
          const result = await ops.verify(agentId, tag, () => probe(incident))
          if (result.refused) {
            ownFixes.add(tag)
            continue
          }
          track(tag, { phase: result.outcome === 'fixed' ? 'resolved' : 'reopened', verdict: result.outcome })
          if (!result.alreadyVerified) event(`verified ${tag}: ${result.outcome}`, { entityKey: result.entityKey })
        } catch (e) {
          const attempts = (verifyFailures.get(tag) ?? 0) + 1
          verifyFailures.set(tag, attempts)
          if (attempts >= MAX_VERIFY_ATTEMPTS) {
            event(`gave up verifying ${tag} after ${attempts} attempts: ${e.message}`)
            continue
          }
          verified.delete(tag)
          if (attempts === 1) event(`verification of ${tag} failed, retrying: ${e.message}`)
        }
      }
    }
  }

  async function heartbeatLoop() {
    while (live()) {
      try {
        await ops.startHeartbeat(agentId, live)
      } catch (e) {
        event(`heartbeat interrupted: ${e.message}`)
        if (live()) await sleep(t.retryMs)
      }
    }
  }

  function start() {
    setStatus('watching')
    event(`${DATA_CENTERS[agentId]} is up, ${agentId} is watching`)
    heartbeatLoop().catch((e) => event(`heartbeat loop stopped: ${e.message}`))
    ops.publishProfile(agentId, { location: DATA_CENTERS[agentId] })
      .catch((e) => event(`profile publish failed: ${e.message}`))
    sleep(t.watchStartDelayMs).then(() => {
      if (!live()) return
      stopWatch = ops.watchForPeerOutages(agentId, runId, (peerId, tag, { filed = true, location = null } = {}) => {
        if (!live()) return
        if (filed) event(`noticed ${peerId} stopped beating, filed ${tag}${location ? `; its sealed profile puts it in ${location}` : ''}`)
        consider({ tag })
      })
    })
    discoverLoop().catch((e) => event(`discovery loop stopped: ${e.message}`))
    monitorLoop().catch((e) => event(`monitor loop stopped: ${e.message}`))
    verifyLoop().catch((e) => event(`verify loop stopped: ${e.message}`))
  }

  function stop() {
    stopped = true
    stopWatch?.()
  }

  return { start, stop }
}
