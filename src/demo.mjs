export const DATA_CENTERS = { atlas: 'DC-1 Frankfurt', nova: 'DC-2 Amsterdam', sol: 'DC-3 Milan' }

export const WORK_STEPS = ['diagnose rack R12', 'power-cycle rack R12 via IPMI', 'confirm servers back online']

export const INCIDENT_REPORT = {
  rack: 'R12',
  dataCenter: DATA_CENTERS.atlas,
  symptom: 'all 8 servers unreachable, top-of-rack switch silent',
  outOfBand: { ipmiHost: '10.12.0.1', user: 'ops-recovery' },
  affectedCustomers: ['acme-shop', 'nordic-cdn', 'lumen-games'],
}

// Sol starts late so Nova reliably holds the first claim on camera.
const DEFAULT_TIMINGS = { stepMs: 6000, retryMs: 3000, startDelayMs: { nova: 0, sol: 20000 } }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function freshAgents() {
  return Object.fromEntries(Object.entries(DATA_CENTERS).map(([id, dc]) => [id, { dc, alive: true, status: 'idle' }]))
}

export function createDemo({ ops, onUpdate = () => {}, timings = {} }) {
  const t = { ...DEFAULT_TIMINGS, ...timings }
  let state = { tag: null, phase: 'idle', report: null, stepsDone: 0, agents: freshAgents(), timeline: [] }

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

  async function worker(run, agentId) {
    const agent = run.agents[agentId]
    const live = () => agent.alive && run === state
    await sleep(t.startDelayMs[agentId] ?? 0)
    while (live()) {
      if (await ops.isDone(run.tag)) {
        if (live()) setStatus(run, agentId, 'idle')
        return
      }
      if (!live()) return
      setStatus(run, agentId, 'claiming')
      const claim = await ops.tryClaim(agentId, run.tag)
      if (!live()) return
      if (!claim.held) {
        setStatus(run, agentId, 'waiting')
        await sleep(t.retryMs)
        continue
      }
      event(run, agentId, 'claimed the incident on Arkiv')
      setStatus(run, agentId, 'working')
      let working = true
      const renewal = ops.renewClaim(agentId, claim.entityKey, () => working && live())
        .catch((e) => event(run, agentId, `lease renewal failed: ${e.message}`))
      let step = await ops.readProgress(run.tag)
      if (step > 0) event(run, agentId, `found ${step}/${WORK_STEPS.length} steps already done on Swarm, resuming`)
      let laneIndex = 0
      while (step < WORK_STEPS.length) {
        await sleep(t.stepMs)
        if (!live()) return
        await ops.recordStep(agentId, run.tag, step, laneIndex)
        laneIndex += 1
        step += 1
        run.stepsDone = step
        event(run, agentId, `step ${step}/${WORK_STEPS.length}: ${WORK_STEPS[step - 1]}`)
      }
      working = false
      await renewal
      if (!live()) return
      await ops.finish(agentId, run.tag, claim.entityKey)
      run.phase = 'resolved'
      setStatus(run, agentId, 'done')
      event(run, agentId, 'incident resolved')
      return
    }
  }

  async function start() {
    const run = { tag: `incident-${Date.now()}`, phase: 'running', report: null, stepsDone: 0, agents: freshAgents(), timeline: [] }
    state = run
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
    for (const id of ['nova', 'sol']) {
      worker(run, id).catch((e) => {
        run.agents[id].status = 'error'
        event(run, id, `error: ${e.message}`)
      })
    }
    return getState()
  }

  function kill(agentId) {
    const agent = state.agents[agentId]
    if (!agent) throw new Error(`unknown agent "${agentId}"`)
    if (!agent.alive) return getState()
    agent.alive = false
    agent.status = 'dead'
    event(state, agentId, `${agent.dc} lost power, ${agentId} is down`)
    return getState()
  }

  return { start, kill, getState }
}
