// Two agents race to claim the same fresh tag at (as close to) the same instant. Exactly one
// should end up holding the claim after the tie-break settles; the loser's claim entity should be
// gone.
//
//   node --env-file=.env tests/live/tie-break.mjs

import { makeClients, makeAgentSigners, queryByTagAndType } from '../../src/arkiv.mjs'
import { tryClaim } from '../../src/protocol.mjs'

const httpUrl = process.env.ARKIV_HTTP_URL
const { pub } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY, httpUrl })
const signers = makeAgentSigners({ httpUrl })
const ctx = { pub, signers }

const tag = `verify-tie-break-${Date.now()}`
console.log('deterministic tie-break\n')
console.log(`  tag: ${tag}`)

const [novaResult, solResult] = await Promise.all([
  tryClaim(ctx, 'nova', tag),
  tryClaim(ctx, 'sol', tag),
])
console.log(`  nova: ${JSON.stringify(novaResult)}`)
console.log(`  sol:  ${JSON.stringify(solResult)}`)

const exactlyOneHeld = novaResult.held !== solResult.held
console.log(`  exactly one holder: ${exactlyOneHeld}`)

const finalRows = await queryByTagAndType(pub, { tag, memoryType: 'claim' })
const oneRowRemains = finalRows.length === 1
console.log(`  exactly one claim row remains on-chain: ${oneRowRemains} (found ${finalRows.length})`)

const reproduced = exactlyOneHeld && oneRowRemains
console.log(`\nRESULT: ${reproduced ? 'passed' : 'FAILED'}`)
process.exit(reproduced ? 0 : 1)
