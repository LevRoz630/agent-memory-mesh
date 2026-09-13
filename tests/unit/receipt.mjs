// Renders the public incident receipt SVG from a realistic resolved state. No network, no env vars.
//
//   node tests/unit/receipt.mjs

import { renderReceipt } from '../../src/receipt.mjs'

const DANGEROUS_TEXT = 'nova probed the payload for injection: <script>alert(1)</script> and a "quote"'
const LONG_TEXT = 'x'.repeat(300)

function buildState() {
  const tag = 'incident-1757676543210'
  const entityKey = '0x' + '7'.repeat(64)
  const swarmRef = 'ab'.repeat(32)
  const baseAt = Date.parse('2026-09-12T10:00:00.000Z')
  const timeline = []
  for (let i = 0; i < 14; i++) {
    const agentId = ['atlas', 'nova', 'sol'][i % 3]
    let text = `step ${i}: did something on the incident`
    if (i === 7) text = DANGEROUS_TEXT
    if (i === 12) text = LONG_TEXT
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

console.log('receipt renderer (SVG)\n')

const state = buildState()
const svg = renderReceipt(state)
const bytes = Buffer.byteLength(svg, 'utf8')

const trimmed = svg.trim()
check('starts with <svg or <?xml', /^(<svg|<\?xml)/i.test(trimmed))

const openTextCount = (svg.match(/<text/g) || []).length
const closeTextCount = (svg.match(/<\/text>/g) || []).length
check('every <text> is closed', openTextCount > 0 && openTextCount === closeTextCount)

check('contains the incident tag', svg.includes(state.tag))
check('contains the entityKey', svg.includes(state.report.entityKey))
check('contains the swarmRef', svg.includes(state.report.swarmRef))
check('contains the resolving agent (sol)', /\bsol\b/.test(svg))

check('every non-truncated timeline text appears escaped', state.timeline.every((e) => {
  if (e.text === LONG_TEXT) return true // checked separately below: must be truncated, not present in full
  if (e.text === DANGEROUS_TEXT) {
    return svg.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && svg.includes('&quot;quote&quot;')
  }
  return svg.includes(e.text)
}))

check('a 300-character entry is truncated with …', !svg.includes(LONG_TEXT) && svg.includes('…'))

check('contains no <script', !svg.includes('<script'))
check('contains no onload/onclick', !/\bon(load|click)\s*=/i.test(svg))
check('contains no foreignObject', !svg.includes('foreignObject'))

check(`under 4096 bytes UTF-8 (was ${bytes})`, bytes < 4096)

const passed = results.every(Boolean)
console.log(`\nRESULT: ${passed ? 'passed' : 'FAILED'}`)
process.exit(passed ? 0 : 1)
