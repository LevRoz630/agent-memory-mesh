// The launcher with real child processes (a stub agent script): each child gets only its own key,
// cutting power really kills the process, and powering on starts a new one. No network.
//
//   node tests/unit/fleet.mjs

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFleet } from '../../src/fleet.mjs'
import { createInfra } from '../../src/infra.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const check = (name, ok) => {
  results.push(Boolean(ok))
  console.log(`  ${ok ? 'pass' : 'FAIL'}: ${name}`)
}

async function waitFor(cond, what, timeoutMs = 5000) {
  const started = Date.now()
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

const isRunning = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// The server runs with --env-file=.env holding every key; children must not inherit that flag.
const envFile = join(tmpdir(), `hydra-fleet-test-${process.pid}.env`)
writeFileSync(envFile, 'ARKIV_PRIVATE_KEY_ATLAS=a\nARKIV_PRIVATE_KEY_NOVA=n\nARKIV_PRIVATE_KEY_SOL=s\n')
process.execArgv.push(`--env-file=${envFile}`)

const infra = createInfra()
const fleet = createFleet({
  infra,
  infraUrl: 'http://127.0.0.1:1/infra',
  script: fileURLToPath(new URL('../fixtures/stub-agent.mjs', import.meta.url)),
  env: { PATH: process.env.PATH, ARKIV_PRIVATE_KEY: 'funder', ARKIV_PRIVATE_KEY_ATLAS: 'a', ARKIV_PRIVATE_KEY_NOVA: 'n', ARKIV_PRIVATE_KEY_SOL: 's' },
})

await fleet.start()
const keysLine = (id) => fleet.getState().timeline.find((e) => e.agentId === id && e.text.startsWith('keys:'))
await waitFor(() => ['atlas', 'nova', 'sol'].every(keysLine), 'all three agents to report')
for (const id of ['atlas', 'nova', 'sol']) {
  check(`${id} was given only its own key`, keysLine(id).text === `keys:ARKIV_PRIVATE_KEY_${id.toUpperCase()}`)
}
check('agents report their own status', fleet.getState().agents.nova.status === 'watching')

const novaPid = keysLine('nova').pid
fleet.powerOff('nova')
await waitFor(() => !isRunning(novaPid), 'nova\'s process to die')
check('cutting power killed nova\'s process', !isRunning(novaPid))
check('nova\'s DC has no power', infra.status().dcs.nova.power === 'off')
check('nova is shown dead', fleet.getState().agents.nova.alive === false && fleet.getState().agents.nova.status === 'dead')
await fleet.decrypt('nova', 'ref').then(() => check('decrypting as a dead agent fails', false), () => check('decrypting as a dead agent fails', true))

fleet.powerOn('nova')
await waitFor(() => fleet.getState().timeline.filter((e) => e.agentId === 'nova' && e.text.startsWith('keys:')).length === 2, 'nova to boot again')
const newPid = fleet.getState().timeline.filter((e) => e.agentId === 'nova' && e.text.startsWith('keys:'))[1].pid
check('powering on started a new nova process', newPid !== novaPid && isRunning(newPid))
check('the decrypt request is answered by that agent\'s own process', (await fleet.decrypt('sol', 'ref')).report.by === 'sol')

fleet.stop()
await sleep(50)
const passed = results.every(Boolean)
console.log(`\nRESULT: ${passed ? 'passed' : 'FAILED'}`)
process.exit(passed ? 0 : 1)
