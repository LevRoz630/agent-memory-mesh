// Per-agent "lanes" on Swarm: an indexed feed at address hash(owner, topic, index), where
// topic = hash('agent-memory-mesh/' + tag). Anyone holding a wallet address and the tag can
// compute the address, but reading the content back also requires a roster private key — lane
// payloads are sealed the same roster-scoped way memories are (src/swarm.mjs's sealForRoster/
// openForAnyAgent). Only writing is further restricted, to that owner's slot specifically.
// See ARCHITECTURE.md §7 "The Swarm side: one lane per agent".
//
// bee-js's package.json `exports` only allows importing its top-level entry point, and the plain
// (non-rolling) Feed API there (`bee.feed.makeWriter/.makeReader`) computes the feed's SOC address
// internally and only accepts a bare postage batch ID — which spends the gateway's postage, not
// ours (see src/swarm.mjs's Stamper comment). So the SOC address is computed here, independently,
// with @ethersphere/core-sdk's own primitives (a direct dependency, not a restricted subpath),
// and stamped with the same Stamper src/swarm.mjs already holds before handing bee.feed the
// resulting envelope in place of a batch ID.

import { Topic, FeedIndex, Identifier, EthAddress, Bytes, keccak256, makeSOCAddress } from '@ethersphere/core-sdk'
import { getSwarm, sealForRoster, openForAnyAgent } from './swarm.mjs'
import { AGENT_IDS } from './arkiv.mjs'

const MAX_LANE_PAYLOAD_BYTES = 4096

function socAddressFor(ownerHex, topic, index) {
  const idx = FeedIndex.fromBigInt(BigInt(index))
  const identifierBytes = keccak256(Bytes.concat(topic.toUint8Array(), idx.toUint8Array()))
  const identifier = new Identifier(identifierBytes)
  const owner = new EthAddress(ownerHex)
  return makeSOCAddress(identifier, owner)
}

export async function writeToLane(agentPrivateKeyHex, ownerAddressHex, tag, index, content, roster = AGENT_IDS) {
  const { bee, stamper } = getSwarm()
  const topic = Topic.fromString('agent-memory-mesh/' + tag)
  const address = socAddressFor(ownerAddressHex, topic, index)
  const payload = sealForRoster(Buffer.from(JSON.stringify(content), 'utf8'), roster)
  if (payload.length > MAX_LANE_PAYLOAD_BYTES) {
    throw new Error(`lane payload is ${payload.length} bytes; one stamped chunk holds ${MAX_LANE_PAYLOAD_BYTES}`)
  }
  const envelope = stamper.stamp(address.toUint8Array())
  const writer = bee.feed.makeWriter(topic, agentPrivateKeyHex)
  await writer.uploadPayload(envelope, payload, { index })
  return address.toHex()
}

export async function readLane(ownerAddressHex, tag, index) {
  const { bee } = getSwarm()
  const topic = Topic.fromString('agent-memory-mesh/' + tag)
  const reader = bee.feed.makeReader(topic, ownerAddressHex)
  try {
    const { payload } = await reader.downloadPayload({ index })
    const plaintext = openForAnyAgent(Buffer.from(payload.toUint8Array()))
    return JSON.parse(plaintext.toString('utf8'))
  } catch (e) {
    if (e?.status === 404) return null
    throw e
  }
}

export async function nextFreeLaneIndex(ownerAddressHex, tag) {
  let index = 0
  while ((await readLane(ownerAddressHex, tag, index)) !== null) index += 1
  return index
}
