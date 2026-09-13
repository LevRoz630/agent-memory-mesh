// The launcher: starts one process per agent, cuts and restores their power, and folds their
// telemetry into the state the control room renders. It makes no protocol decisions; if an agent
// never reports something, the control room never shows it.

import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { AGENT_IDS } from './arkiv.mjs'
import { DATA_CENTERS, rackTag } from './agent.mjs'

const AGENT_SCRIPT = fileURLToPath(new URL('../scripts/agent.mjs', import.meta.url))
const DECRYPT_TIMEOUT_MS = 20000
const SHARED_ENV = ['PATH', 'ARKIV_HTTP_URL', 'SWARM_GATEWAY', 'SWARM_SIGNER_KEY', 'SWARM_POSTAGE_BATCH_ID', 'SWARM_BATCH_DEPTH', 'HYDRA_INFRA_TOKEN']

function freshState(runId) {
  return {
    id: runId, tag: runId ? rackTag(runId) : null, phase: runId ? 'running' : 'idle', report: null, stepsDone: 0,
    agents: Object.fromEntries(AGENT_IDS.map((id) => [id, { dc: DATA_CENTERS[id], alive: false, status: 'idle' }])),
    timeline: [], receiptRef: null, incidents: {},
  }
}

export function createFleet({ infra, infraUrl, env = process.env, script = AGENT_SCRIPT, onUpdate = () => {} }) {
  let state = freshState(null)
  const children = new Map()
  const pending = new Map()
  let nextRequest = 0

  const getState = () => structuredClone(state)
  const emit = () => onUpdate(getState())

  function note(agentId, text) {
    state.timeline.push({ at: Date.now(), agentId, text })
  }

  function childEnv(agentId) {
    const out = {}
    for (const name of SHARED_ENV) if (env[name] !== undefined) out[name] = env[name]
    const keyName = `ARKIV_PRIVATE_KEY_${agentId.toUpperCase()}`
    out[keyName] = env[keyName]
    return { ...out, HYDRA_AGENT_ID: agentId, HYDRA_RUN_ID: String(state.id), HYDRA_INFRA_URL: infraUrl }
  }

  function receive(agentId, msg) {
    const agent = state.agents[agentId]
    if (msg.type === 'event') {
      const { type, ...entry } = msg
      state.timeline.push(entry)
    } else if (msg.type === 'status') {
      if (agent.alive) agent.status = msg.status
    } else if (msg.type === 'report') {
      if (msg.tag === state.tag) state.report = { swarmRef: msg.swarmRef, entityKey: msg.entityKey }
    } else if (msg.type === 'incident') {
      const { incident } = msg
      const prev = state.incidents[incident.tag] ?? {}
      // Every agent reports its own view; a resolution or verdict from one must not be undone by
      // another that has not seen it yet.
      const verdict = prev.verdict ?? incident.verdict
      const merged = {
        ...prev, ...incident,
        phase: verdict ? (verdict === 'fixed' ? 'resolved' : 'reopened') : prev.phase === 'resolved' ? 'resolved' : (incident.phase ?? prev.phase),
        verdict,
        receiptRef: prev.receiptRef ?? incident.receiptRef,
        resolvedBy: prev.resolvedBy ?? incident.resolvedBy,
        report: prev.report ?? incident.report,
        stepsDone: Math.max(prev.stepsDone ?? 0, incident.stepsDone ?? 0),
      }
      state.incidents[incident.tag] = merged
      if (incident.tag === state.tag) {
        state.phase = merged.phase ?? state.phase
        state.stepsDone = merged.stepsDone
        state.receiptRef = merged.receiptRef ?? state.receiptRef
        if (!state.report && merged.report?.entityKey) state.report = merged.report
      }
    } else if (msg.type === 'decrypted') {
      pending.get(msg.id)?.(msg)
      return
    } else {
      return
    }
    emit()
  }

  function spawnAgent(agentId) {
    // fork() reuses this process's node flags by default, and `--env-file=.env` would hand every agent
    // every key.
    const child = fork(script, [], { env: childEnv(agentId), execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    children.set(agentId, child)
    Object.assign(state.agents[agentId], { alive: true, status: 'booting' })
    child.on('message', (msg) => {
      if (children.get(agentId) === child) receive(agentId, msg)
    })
    child.on('exit', (code, signal) => {
      if (children.get(agentId) !== child) return
      children.delete(agentId)
      Object.assign(state.agents[agentId], { alive: false, status: 'error' })
      note(agentId, `${agentId}'s process exited on its own (${signal ?? `code ${code}`})`)
      emit()
    })
  }

  function killChild(agentId) {
    const child = children.get(agentId)
    if (!child) return
    children.delete(agentId)
    child.kill('SIGKILL')
  }

  async function start() {
    for (const id of [...children.keys()]) killChild(id)
    infra.reset()
    state = freshState(String(Date.now()))
    for (const id of AGENT_IDS) spawnAgent(id)
    note('fleet', `run ${state.id}: started ${AGENT_IDS.length} agent processes, rack R12 in ${DATA_CENTERS.atlas} is down`)
    emit()
    return getState()
  }

  function powerOff(agentId) {
    if (!state.agents[agentId]) throw new Error(`unknown agent "${agentId}"`)
    if (!state.id) throw new Error('no run in progress')
    infra.setDcPower(agentId, 'off')
    if (!children.has(agentId)) return getState()
    killChild(agentId)
    Object.assign(state.agents[agentId], { alive: false, status: 'dead' })
    note(agentId, `${DATA_CENTERS[agentId]} lost power, ${agentId}'s process was killed (SIGKILL)`)
    emit()
    return getState()
  }

  function powerOn(agentId) {
    if (!state.agents[agentId]) throw new Error(`unknown agent "${agentId}"`)
    infra.setDcPower(agentId, 'on')
    if (children.has(agentId) || !state.id) return getState()
    spawnAgent(agentId)
    note(agentId, `${DATA_CENTERS[agentId]} has power again, ${agentId}'s process is booting`)
    emit()
    return getState()
  }

  function decrypt(agentId, ref) {
    const child = children.get(agentId)
    if (!child) return Promise.reject(new Error(`${agentId} is not running, so nobody holding its key can open this`))
    const id = ++nextRequest
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${agentId} did not answer within ${DECRYPT_TIMEOUT_MS / 1000}s`))
      }, DECRYPT_TIMEOUT_MS)
      pending.set(id, (msg) => {
        clearTimeout(timer)
        pending.delete(id)
        msg.ok ? resolve(msg) : reject(new Error(msg.error))
      })
      child.send({ type: 'decrypt', id, ref })
    })
  }

  function stop() {
    for (const id of [...children.keys()]) killChild(id)
  }

  return { start, powerOff, powerOn, decrypt, getState, stop }
}
