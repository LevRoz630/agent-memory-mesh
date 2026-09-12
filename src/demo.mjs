export const DATA_CENTERS = { atlas: 'DC-1 Frankfurt', nova: 'DC-2 Amsterdam', sol: 'DC-3 Milan' }

export const AGENT_IDS = Object.keys(DATA_CENTERS)

export const WORK_STEPS = ['diagnose rack R12', 'power-cycle rack R12 via IPMI', 'confirm servers back online']

export const INCIDENT_REPORT = {
  rack: 'R12',
  dataCenter: DATA_CENTERS.atlas,
  symptom: 'all 8 servers unreachable, top-of-rack switch silent',
  outOfBand: { ipmiHost: '10.12.0.1', user: 'ops-recovery' },
  affectedCustomers: ['acme-shop', 'nordic-cdn', 'lumen-games'],
}

// Sol starts late so Nova reliably holds the first claim on camera, and Atlas later still, so the
// seeded incident plays out as before. The delay applies to the seeded incident only: an outage an
// agent detects itself is worked immediately, by whichever agent noticed.
const DEFAULT_TIMINGS = {
  stepMs: 6000,
  retryMs: 3000,
  verifyPollMs: 4000,
  // A just-written heartbeat stays invisible to queries for a block or two, so watchers that start
  // at the same instant as the beats would read startup lag as everybody being down.
  watchStartDelayMs: 20000,
  startDelayMs: { atlas: 30000, nova: 0, sol: 20000 },
}

const OUTAGE_PREFIX = 'outage-'
const MAX_VERIFY_ATTEMPTS = 5 // a few polls' worth of transient failure, not an unbounded retry

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function freshAgents() {
  return Object.fromEntries(Object.entries(DATA_CENTERS).map(([id, dc]) => [id, { dc, alive: true, status: 'idle' }]))
}

export function createDemo({ ops, onUpdate = () => {}, timings = {} }) {
  const t = { ...DEFAULT_TIMINGS, ...timings, startDelayMs: { ...DEFAULT_TIMINGS.startDelayMs, ...timings.startDelayMs } }
  let state = { tag: null, phase: 'idle', report: null, stepsDone: 0, agents: freshAgents(), timeline: [], receiptRef: null, incidents: {} }
  // Loop handles and cross-agent bookkeeping live outside `state` because getState() clones it.
  let control = null

  function getState() {
    return structuredClone(state)
  }

  // A run that has been replaced by a newer start() keeps mutating its own object but never emits.
  function emit(run) {
    if (run === state) onUpdate(getState())
  }

  function event(run, agentId, text) {
    run.timeline.push({ at: Date.now(), agentId, text })
    emit(run)
  }

  function setStatus(run, agentId, status) {
    run.agents[agentId].status = status
    emit(run)
  }

  // `subject` is the agent whose data center the incident is about, and only an outage incident has
  // one: it is that peer's silence, so resolving it is what brings the peer back. The seeded
  // incident is about a rack, not an agent — resolving it revives nobody, or a peer killed while it
  // was still open would come back without any peer ever having noticed it was gone.
  function incidentFor(run, tag) {
    if (!run.incidents[tag]) {
      const subject = tag.startsWith(OUTAGE_PREFIX) ? tag.slice(OUTAGE_PREFIX.length) : null
      run.incidents[tag] = { tag, subject, phase: 'running', stepsDone: 0 }
    }
    return run.incidents[tag]
  }

  function isLive(run, agentId) {
    return run.agents[agentId].alive && run === state
  }

  async function worker(run, ctl, agentId, tag) {
    const live = () => isLive(run, agentId)
    const incident = incidentFor(run, tag)
    if (tag === run.tag) await sleep(t.startDelayMs[agentId] ?? 0)
    while (live()) {
      if (await ops.isDone(tag)) {
        if (live() && run.agents[agentId].status !== 'watching') setStatus(run, agentId, 'idle')
        return
      }
      if (!live()) return
      setStatus(run, agentId, 'claiming')
      const claim = await ops.tryClaim(agentId, tag)
      if (!live()) return
      if (!claim.held) {
        setStatus(run, agentId, 'waiting')
        await sleep(t.retryMs)
        continue
      }
      event(run, agentId, `claimed ${tag} on Arkiv`)
      setStatus(run, agentId, 'working')
      let working = true
      // A lapsed lease is not a crash, and renewClaim reports it instead of throwing: the claim row
      // is gone, any agent may take the tag, and this one must stop acting as the holder.
      let leaseLost = false
      const renewal = ops.renewClaim(agentId, claim.entityKey, () => working && live())
        .then((result) => { if (result?.lost) leaseLost = true })
        .catch((e) => event(run, agentId, `lease renewal failed: ${e.message}`))
      let step = await ops.readProgress(tag)
      if (step > 0) event(run, agentId, `found ${step}/${WORK_STEPS.length} steps already done on Swarm, resuming`)
      let laneIndex = 0
      while (step < WORK_STEPS.length && !leaseLost) {
        await sleep(t.stepMs)
        if (!live()) return
        if (leaseLost) break
        await ops.recordStep(agentId, tag, step, laneIndex)
        laneIndex += 1
        step += 1
        incident.stepsDone = step
        if (tag === run.tag) run.stepsDone = step
        event(run, agentId, `step ${step}/${WORK_STEPS.length}: ${WORK_STEPS[step - 1]}`)
      }
      working = false
      await renewal
      if (!live()) return
      // Whatever was finished is already published to this agent's lane, so the next holder resumes
      // from there rather than restarting. Go back around: either the tag is done, or re-claim it.
      if (leaseLost) {
        event(run, agentId, `lease on ${tag} lapsed before the work finished — dropping the claim`)
        setStatus(run, agentId, 'waiting')
        await sleep(t.retryMs)
        continue
      }
      // Claimed before the write, not after: finish() publishes the `done` row partway through, and
      // a verify loop that polls in that window would otherwise let the worker grade itself.
      ctl.finishedBy[tag] = agentId
      try {
        await ops.finish(agentId, tag, claim.entityKey)
      } catch (e) {
        delete ctl.finishedBy[tag]
        throw e
      }
      incident.phase = 'resolved'
      if (tag === run.tag) run.phase = 'resolved'
      setStatus(run, agentId, 'done')
      event(run, agentId, `${tag} resolved`)
      const { subject } = incident
      if (subject && run.agents[subject] && !run.agents[subject].alive) revive(run, ctl, subject)
      if (run === state) {
        try {
          // run.tag is always the seeded incident's tag, never whichever incident just finished --
          // override it, or an outage's receipt is mislabeled with the seeded incident's name.
          const ref = await ops.publishReceipt(structuredClone({ ...run, tag }))
          if (run === state) {
            incident.receiptRef = ref
            if (tag === run.tag) run.receiptRef = ref
            event(run, agentId, 'published a public receipt on Swarm')
          }
        } catch (e) {
          if (run === state) event(run, agentId, `receipt upload failed: ${e.message}`)
        }
      }
      return
    }
  }

  function spawnWorker(run, ctl, agentId, tag) {
    const key = `${agentId}:${tag}`
    if (ctl.working.has(key)) return
    ctl.working.add(key)
    worker(run, ctl, agentId, tag)
      .catch((e) => {
        run.agents[agentId].status = 'error'
        event(run, agentId, `error: ${e.message}`)
      })
      .finally(() => ctl.working.delete(key))
  }

  // Whichever live agent polls first and sees a `done` row writes the verdict — never the agent
  // that did the work, so a verdict is always a second pair of eyes.
  async function verifyLoop(run, ctl, agentId) {
    const live = () => isLive(run, agentId)
    while (live()) {
      await sleep(t.verifyPollMs)
      for (const tag of Object.keys(run.incidents)) {
        if (!live()) return
        if (ctl.verified.has(tag) || ctl.finishedBy[tag] === agentId) continue
        if (!(await ops.isDone(tag))) continue
        if (!live() || ctl.verified.has(tag) || ctl.finishedBy[tag] === agentId) continue
        ctl.verified.add(tag)
        try {
          const { outcome } = await ops.verify(agentId, tag)
          incidentFor(run, tag).verdict = outcome
          if (tag === run.tag) run.verdict = outcome
          event(run, agentId, `verified ${tag}: ${outcome}`)
        } catch (e) {
          // A permanently broken verify (missing signer, chain down) must not push one timeline
          // entry every poll forever: `state.timeline` is cloned on every getState() and this
          // controller backs a long-lived server. Retry a transient failure a few times, log the
          // first and the last, then leave the tag marked so no agent picks it up again.
          const attempts = (ctl.verifyFailures.get(tag) ?? 0) + 1
          ctl.verifyFailures.set(tag, attempts)
          if (attempts >= MAX_VERIFY_ATTEMPTS) {
            event(run, agentId, `gave up verifying ${tag} after ${attempts} attempts: ${e.message}`)
            continue
          }
          ctl.verified.delete(tag)
          if (attempts === 1) event(run, agentId, `verification of ${tag} failed, retrying: ${e.message}`)
        }
      }
    }
  }

  // startHeartbeat() gives up if its own row lapsed — which happens to a busy agent whose renewal
  // lands a block late, not only to a dead one. A live agent beats again; a killed one never does,
  // because live() is false.
  async function heartbeatLoop(run, agentId) {
    const live = () => isLive(run, agentId)
    while (live()) {
      try {
        await ops.startHeartbeat(agentId, live)
      } catch (e) {
        event(run, agentId, `heartbeat interrupted: ${e.message}`)
      }
      if (!live()) return
      await sleep(t.retryMs)
    }
  }

  function startAgentLoops(run, ctl, agentId) {
    const live = () => isLive(run, agentId)
    heartbeatLoop(run, agentId).catch((e) => event(run, agentId, `heartbeat loop stopped: ${e.message}`))
    sleep(t.watchStartDelayMs).then(() => {
      if (!live()) return
      ctl.stopWatch[agentId] = ops.watchForPeerOutages(agentId, (peerId, outageTag) => {
        if (!live()) return
        event(run, agentId, `noticed ${peerId} stopped beating — filed ${outageTag}`)
        incidentFor(run, outageTag).detectedBy = agentId
        emit(run)
        spawnWorker(run, ctl, agentId, outageTag)
      })
    })
    verifyLoop(run, ctl, agentId).catch((e) => event(run, agentId, `verify loop stopped: ${e.message}`))
  }

  function revive(run, ctl, agentId) {
    const agent = run.agents[agentId]
    agent.alive = true
    agent.status = 'watching'
    event(run, agentId, `${agent.dc} back online, ${agentId} is watching again`)
    startAgentLoops(run, ctl, agentId)
  }

  function stopAllWatches() {
    if (!control) return
    for (const stop of Object.values(control.stopWatch)) stop?.()
  }

  async function start() {
    stopAllWatches()
    const run = { tag: `incident-${Date.now()}`, phase: 'running', report: null, stepsDone: 0, agents: freshAgents(), timeline: [], receiptRef: null, incidents: {} }
    state = run
    const ctl = { stopWatch: {}, working: new Set(), verified: new Set(), verifyFailures: new Map(), finishedBy: {} }
    control = ctl
    setStatus(run, 'atlas', 'watching')
    event(run, 'atlas', `rack R12 in ${DATA_CENTERS.atlas} stopped responding`)
    try {
      run.report = await ops.reportIncident(run.tag, INCIDENT_REPORT)
    } catch (e) {
      run.phase = 'failed'
      event(run, 'atlas', `failed to file the incident: ${e.message}`)
      throw e
    }
    event(run, 'atlas', 'filed the incident: index on Arkiv, encrypted report on Swarm')
    incidentFor(run, run.tag)
    for (const id of AGENT_IDS) {
      startAgentLoops(run, ctl, id)
      spawnWorker(run, ctl, id, run.tag)
    }
    return getState()
  }

  // Killing an agent has one consequence on the wire: its heartbeat stops being renewed. Nothing
  // announces the outage — its peers notice the silence and file it themselves.
  function kill(agentId) {
    const agent = state.agents[agentId]
    if (!agent) throw new Error(`unknown agent "${agentId}"`)
    if (!agent.alive) return getState()
    agent.alive = false
    agent.status = 'dead'
    control?.stopWatch[agentId]?.()
    event(state, agentId, `${agent.dc} lost power, ${agentId} is down — heartbeat stops`)
    return getState()
  }

  return { start, kill, getState }
}
