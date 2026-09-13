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

// Atlas noticed the rack, so it takes the first claim; nova and then sol hold back so that holds on
// camera. The delay applies to the rack incident only: an outage is worked immediately by every
// live peer.
const DEFAULT_TIMINGS = {
  stepMs: 6000,
  retryMs: 3000,
  verifyPollMs: 4000,
  // A just-written heartbeat stays invisible to queries for a block or two, so watchers that start
  // at the same instant as the beats would read startup lag as everybody being down.
  watchStartDelayMs: 20000,
  // Atlas files the rack incident this long after start, which is the window to cut DC-1 first.
  reportDelayMs: 8000,
  startDelayMs: { atlas: 0, nova: 10000, sol: 20000 },
}

const MAX_VERIFY_ATTEMPTS = 5 // a few polls' worth of transient failure, not an unbounded retry

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function freshAgents() {
  return Object.fromEntries(Object.entries(DATA_CENTERS).map(([id, dc]) => [id, { dc, alive: true, status: 'idle' }]))
}

export function createDemo({ ops, onUpdate = () => {}, timings = {} }) {
  const t = { ...DEFAULT_TIMINGS, ...timings, startDelayMs: { ...DEFAULT_TIMINGS.startDelayMs, ...timings.startDelayMs } }
  let state = { id: null, tag: null, phase: 'idle', report: null, stepsDone: 0, agents: freshAgents(), timeline: [], receiptRef: null, incidents: {} }
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
  // one: it is that peer's silence, so resolving it is what brings the peer back. The rack incident
  // is about a rack, not an agent — resolving it revives nobody, or a peer killed while it was still
  // open would come back without any peer ever having noticed it was gone.
  function incidentFor(run, tag, subject = null) {
    if (!run.incidents[tag]) run.incidents[tag] = { tag, subject, phase: 'running', stepsDone: 0 }
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
      // A step that throws must also stop the renewal, or the claim never lapses for a restarted
      // worker or anyone else to take.
      try {
        let step = await ops.readProgress(tag)
        if (step > 0) event(run, agentId, `found ${step}/${WORK_STEPS.length} steps already done on Swarm, resuming`)
        // Continues this agent's own lane rather than restarting it at 0, which would overwrite what
        // it published before a lapsed lease.
        let laneIndex = await ops.nextLaneIndex(agentId, tag)
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
      } finally {
        working = false
      }
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
      // Marked before the write, not after: finish() publishes the `done` row partway through, and a
      // verify loop polling in that window would otherwise ask protocol verify() to grade its own fix.
      ctl.ownFixes.add(`${agentId}:${tag}`)
      await ops.finish(agentId, tag, claim.entityKey)
      incident.phase = 'resolved'
      if (tag === run.tag) run.phase = 'resolved'
      setStatus(run, agentId, 'done')
      event(run, agentId, `${tag} resolved`)
      const { subject } = incident
      if (subject && run.agents[subject] && !run.agents[subject].alive) revive(run, ctl, subject)
      if (run === state) {
        try {
          // run.tag is always the rack incident's tag, never whichever incident just finished --
          // override it, or an outage's receipt is mislabeled with the rack incident's name.
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

  // A worker that crashed on a Swarm or RPC error comes back after retryMs. It has to: a live agent
  // that has worked an incident keeps the right to resume it (protocol tryClaim), so while it is
  // alive nobody else will take over.
  function spawnWorker(run, ctl, agentId, tag) {
    const key = `${agentId}:${tag}`
    if (ctl.working.has(key)) return
    ctl.working.add(key)
    worker(run, ctl, agentId, tag)
      .then(() => ctl.working.delete(key), (e) => {
        ctl.working.delete(key)
        run.agents[agentId].status = 'error'
        event(run, agentId, `error: ${e.message}`)
        return sleep(t.retryMs).then(() => {
          if (isLive(run, agentId) && run.incidents[tag]?.phase !== 'resolved') spawnWorker(run, ctl, agentId, tag)
        })
      })
  }

  // Whichever live agent polls first and sees a `done` row writes the verdict — never the agent
  // that did the work. protocol verify() refuses that on-chain; ownFixes only saves the round trip.
  async function verifyLoop(run, ctl, agentId) {
    const live = () => isLive(run, agentId)
    while (live()) {
      await sleep(t.verifyPollMs)
      for (const tag of Object.keys(run.incidents)) {
        const own = `${agentId}:${tag}`
        if (!live()) return
        if (ctl.verified.has(tag) || ctl.ownFixes.has(own)) continue
        if (!(await ops.isDone(tag))) continue
        if (!live() || ctl.verified.has(tag) || ctl.ownFixes.has(own)) continue
        ctl.verified.add(tag)
        try {
          const result = await ops.verify(agentId, tag)
          if (result.refused) {
            ctl.ownFixes.add(own)
            ctl.verified.delete(tag)
            continue
          }
          incidentFor(run, tag).verdict = result.outcome
          if (tag === run.tag) run.verdict = result.outcome
          event(run, agentId, `verified ${tag}: ${result.outcome}`)
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
      // A beat that lapsed is written again at once: waiting would leave a gap long enough for two
      // peer polls to read a live agent as down. Only a failed write waits before retrying.
      try {
        await ops.startHeartbeat(agentId, live)
      } catch (e) {
        event(run, agentId, `heartbeat interrupted: ${e.message}`)
        if (live()) await sleep(t.retryMs)
      }
    }
  }

  // Every live peer that sees an outage works it, whether it filed the row or found it already
  // there, so the incident survives its filer dying too.
  function startAgentLoops(run, ctl, agentId) {
    const live = () => isLive(run, agentId)
    heartbeatLoop(run, agentId).catch((e) => event(run, agentId, `heartbeat loop stopped: ${e.message}`))
    sleep(t.watchStartDelayMs).then(() => {
      if (!live()) return
      ctl.stopWatch[agentId] = ops.watchForPeerOutages(agentId, run.id, (peerId, outageTag, { filed = true } = {}) => {
        if (!live()) return
        const incident = incidentFor(run, outageTag, peerId)
        if (filed) {
          incident.detectedBy = agentId
          event(run, agentId, `noticed ${peerId} stopped beating — filed ${outageTag}`)
        }
        spawnWorker(run, ctl, agentId, outageTag)
      })
    })
    verifyLoop(run, ctl, agentId).catch((e) => event(run, agentId, `verify loop stopped: ${e.message}`))
  }

  // A revived agent is a full peer again: it rejoins every incident still open, or one it had worked
  // before would wait on it (protocol tryClaim yields to a live previous worker) while it sat idle.
  function revive(run, ctl, agentId) {
    const agent = run.agents[agentId]
    agent.alive = true
    agent.status = 'watching'
    event(run, agentId, `${agent.dc} back online, ${agentId} is watching again`)
    startAgentLoops(run, ctl, agentId)
    for (const incident of Object.values(run.incidents)) {
      if (incident.phase !== 'resolved' && incident.subject !== agentId) spawnWorker(run, ctl, agentId, incident.tag)
    }
  }

  function stopAllWatches() {
    if (!control) return
    for (const stop of Object.values(control.stopWatch)) stop?.()
  }

  // A DC that is already dark when the rack fails can't report it: the run then has no rack
  // incident, only atlas's outage, which its peers detect from the silence like any other.
  async function fileRackIncident(run, ctl) {
    await sleep(t.reportDelayMs)
    if (!isLive(run, 'atlas')) return
    setStatus(run, 'atlas', 'watching')
    event(run, 'atlas', `rack R12 in ${DATA_CENTERS.atlas} stopped responding`)
    try {
      run.report = await ops.reportIncident(run.tag, INCIDENT_REPORT)
    } catch (e) {
      run.phase = 'failed'
      event(run, 'atlas', `failed to file the incident: ${e.message}`)
      return
    }
    if (run !== state) return
    event(run, 'atlas', 'filed the incident: index on Arkiv, encrypted report on Swarm')
    incidentFor(run, run.tag)
    for (const id of AGENT_IDS) {
      if (isLive(run, id)) spawnWorker(run, ctl, id, run.tag)
    }
  }

  async function start() {
    stopAllWatches()
    const id = Date.now()
    const run = { id, tag: `incident-${id}`, phase: 'running', report: null, stepsDone: 0, agents: freshAgents(), timeline: [], receiptRef: null, incidents: {} }
    state = run
    const ctl = { stopWatch: {}, working: new Set(), verified: new Set(), verifyFailures: new Map(), ownFixes: new Set() }
    control = ctl
    for (const agentId of AGENT_IDS) startAgentLoops(run, ctl, agentId)
    fileRackIncident(run, ctl).catch((e) => event(run, 'atlas', `error: ${e.message}`))
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
