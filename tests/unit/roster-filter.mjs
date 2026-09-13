// Rows written by a wallet outside the roster never reach the protocol. No network.
//
//   node tests/unit/roster-filter.mjs

import { render } from '@arkiv-network/sdk/query'
import { queryByTagAndType } from '../../src/arkiv.mjs'
import { ROSTER } from '../../src/roster.mjs'

let failed = false
function check(name, ok) {
  console.log(`  ${ok ? 'pass' : 'FAIL'}: ${name}`)
  if (!ok) failed = true
}

const row = (key, owner) => ({ key, owner, attributes: { tag: { type: 'str', value: 'agent-atlas' } } })
const rows = [
  row('0x01', '0x000000000000000000000000000000000000dEaD'),
  row('0x02', ROSTER.atlas.address.toLowerCase()),
]
let queried = null
const pub = { select: () => ({ where: (pred) => { queried = render(pred).toLowerCase(); return { limit: () => ({ fetch: async () => ({ entities: rows }) }) } } }) }

const result = await queryByTagAndType(pub, { tag: 'agent-atlas', memoryType: 'heartbeat' })
check('a stranger\'s heartbeat row is dropped', !result.some((r) => r.key === '0x01'))
check('the roster agent\'s row is kept, matched case-insensitively', result.length === 1 && result[0].key === '0x02')
check('the query itself is limited to roster owners, so a stranger\'s rows can\'t fill the page', Object.values(ROSTER).every(({ address }) => queried.includes(`$owner = addr(${address.toLowerCase()})`)))

console.log(`\nRESULT: ${failed ? 'FAILED' : 'passed'}`)
process.exit(failed ? 1 : 0)
