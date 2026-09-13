// feedback.md finding 2: attribute NAMES pass the SDK's client-side validator and are then
// rejected on-chain, and the engine's rejection message lists the character it just rejected
// as permitted. Attribute VALUES, by contrast, are validated strictly client-side.
//
//   node --env-file=.env arkiv-feedback/repro/02-name-vs-value-validation.mjs

import { ExpirationTime, isValidAttributeName, str, stringToPayload, u64 } from '@arkiv-network/sdk'
import { makeClients } from '../../src/arkiv.mjs'

const { wallet, account } = makeClients({ privateKey: process.env.ARKIV_PRIVATE_KEY })

const writeWithName = (name) =>
  wallet.createEntity({
    expires: ExpirationTime.fromBlocks(60),
    payload: stringToPayload(''),
    contentType: 'application/octet-stream',
    attributes: { [name]: str('x') },
  })

function probe(label, fn) {
  try {
    fn()
    console.log(`  accepted  ${label}`)
    return 'accepted'
  } catch (e) {
    console.log(`  rejected  ${label} -> ${e.constructor.name}: ${e.message.split('\n')[0]}`)
    return 'rejected'
  }
}

console.log('finding 2: name validation is client-permissive/engine-strict; value validation is strict')
console.log(`wallet: ${account.address}\n`)

console.log('ATTRIBUTE NAMES — client-side validator vs the engine:')
const names = ['agent_id', 'agentId', 'AGENT']
const onChain = {}
for (const name of names) {
  const clientSays = isValidAttributeName(name)
  let verdict
  let message = ''
  try {
    const r = await writeWithName(name)
    verdict = 'accepted'
    console.log(`  isValidAttributeName(${JSON.stringify(name)}) = ${clientSays}   on-chain: accepted (${r.entityKey.slice(0, 18)}…)`)
  } catch (e) {
    verdict = 'rejected'
    message = e.message
    console.log(`  isValidAttributeName(${JSON.stringify(name)}) = ${clientSays}   on-chain: rejected`)
  }
  onChain[name] = { clientSays, verdict, message }
}

const charsetMessage = onChain.AGENT.message
console.log('\nThe engine\'s verbatim rejection message for "AGENT":')
for (const line of charsetMessage.split('\n')) console.log(`  ${line}`)
const contradiction = /"A"-"Z"/.test(charsetMessage) && /"A" \(0x41\)/.test(charsetMessage)
console.log(`\n  lists "A"-"Z" as permitted while rejecting "A" (0x41): ${contradiction}`)

console.log('\nATTRIBUTE VALUES — rejected client-side, before any RPC call:')
probe('u64(-3n)', () => u64(-3n))
probe('u64(2n ** 70n)', () => u64(2n ** 70n))
probe("str('a\\nb')", () => str('a\nb'))
// BigInt(5.7) throws in BigInt itself, before u64 is reached.
probe('BigInt(5.7)', () => BigInt(5.7))

console.log('\n  the 128-byte str limit, exact and UTF-8-correct:')
const b128 = probe("str('a'.repeat(128))  = 128 B", () => str('a'.repeat(128)))
const b129 = probe("str('a'.repeat(129))  = 129 B", () => str('a'.repeat(129)))
const u128 = probe("str('é'.repeat(64))   = 128 B", () => str('é'.repeat(64)))
const u130 = probe("str('é'.repeat(65))   = 130 B", () => str('é'.repeat(65)))

const namesReproduced =
  onChain.agentId.clientSays === true &&
  onChain.AGENT.clientSays === true &&
  onChain.agentId.verdict === 'rejected' &&
  onChain.AGENT.verdict === 'rejected' &&
  onChain.agent_id.verdict === 'accepted'
const boundaryReproduced =
  b128 === 'accepted' && b129 === 'rejected' && u128 === 'accepted' && u130 === 'rejected'
const reproduced = namesReproduced && contradiction && boundaryReproduced

console.log(`\nRESULT: ${reproduced ? 'reproduced' : 'NOT reproduced'}`)
process.exit(reproduced ? 0 : 1)
