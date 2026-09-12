// Renders the public incident receipt HTML from a realistic resolved state. No network, no env vars.
//
//   node scripts/test-receipt.mjs

import { renderReceipt } from '../src/receipt.mjs'

const DANGEROUS_TEXT = 'nova probed the payload for injection: <script>alert(1)</script> and a "quote"'

function buildState() {
  const tag = 'incident-1757676543210'
  const entityKey = '0x' + '7'.repeat(64)
  const swarmRef = 'ab'.repeat(32)
  const baseAt = Date.parse('2026-09-12T10:00:00.000Z')
  const timeline = []
  for (let i = 0; i < 14; i++) {
    const agentId = ['atlas', 'nova', 'sol'][i % 3]
    const text = i === 7 ? DANGEROUS_TEXT : `step ${i}: did something on the incident`
    timeline.push({ at: baseAt + i * 6000, agentId, text })
  }
  return {
    tag,
    phase: 'resolved',
    report: { swarmRef, entityKey },
    stepsDone: 3,
    agents: {
      atlas: { dc: 'DC-1 Frankfurt', alive: true, status: 'watching' },
      nova: { dc: 'DC-2 Amsterdam', alive: false, status: 'dead' },
      sol: { dc: 'DC-3 Milan', alive: true, status: 'done' },
    },
    timeline,
    receiptRef: null,
  }
}

const results = []
const check = (name, ok) => {
  results.push(Boolean(ok))
  console.log(`  ${ok ? 'pass' : 'FAIL'}: ${name}`)
}

console.log('receipt renderer\n')

const state = buildState()
const html = renderReceipt(state)
const bytes = Buffer.byteLength(html, 'utf8')

check('starts with <!doctype html>', /^<!doctype html>/i.test(html))
check('contains the incident tag', html.includes(state.tag))
check('contains the entityKey', html.includes(state.report.entityKey))
check('contains the swarmRef', html.includes(state.report.swarmRef))
check('contains the resolving agent (sol)', /\bsol\b/.test(html))
check('every timeline text appears escaped', state.timeline.every((e) => {
  if (e.text === DANGEROUS_TEXT) {
    return html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && html.includes('&quot;quote&quot;')
  }
  return html.includes(e.text)
}))
check('contains no raw <script>', !html.includes('<script>'))
check(`under 4096 bytes UTF-8 (was ${bytes})`, bytes < 4096)

const passed = results.every(Boolean)
console.log(`\nRESULT: ${passed ? 'passed' : 'FAILED'}`)
process.exit(passed ? 0 : 1)
