// Swarm leg: the memory content itself, encrypted and content-addressed. @snaha/swarm-id's
// SwarmIdClient is an iframe-based browser passkey flow, unusable from a server, so this goes
// through @ethersphere/bee-js against a gateway.
//
// Encryption is app-level (AES-256-GCM), so the gateway never sees plaintext, and references
// stay 64 hex chars (the gateway's own Swarm-Encrypt header would make them 128).
//
// Keys come from each agent's own ARKIV_PRIVATE_KEY_<AGENT>. The same secp256k1 key that signs
// their Arkiv transactions doubles as their Swarm decryption identity, wrapped per recipient in
// encryptForRoster/decryptWithKey below. There is no shared secret.
//
// Postage: uploads are stamped locally with our own batch, which is why this uses /chunks and
// not /bytes. Tested live against api.gateway.ethswarm.org:
//   - POST /bytes with swarm-postage-stamp:       400, the proxy demands swarm-postage-batch-id
//   - POST /bytes with swarm-postage-batch-id:    404 "batch with id not found"
//   - POST /chunks with a signed envelope:        201, and a wrong signing key gets "stamp
//     signature is invalid", so the batch is genuinely being spent
// A batch shared as a key only works this way: the node holds no stamp issuer for it, so every
// chunk has to arrive already signed.

import { createCipheriv, createDecipheriv, randomBytes, createECDH, hkdfSync } from 'node:crypto'
import { Bee, BatchId, PrivateKey, Stamper } from '@ethersphere/bee-js'
import { MantarayNode } from '@ethersphere/core-sdk'
import { AGENT_IDS } from './arkiv.mjs'

const GATEWAY = process.env.SWARM_GATEWAY ?? 'https://api.gateway.ethswarm.org'
// A gateway that accepts the connection and then stalls leaves a bare fetch() pending
// indefinitely, hanging whichever route is awaiting it.
const FETCH_TIMEOUT_MS = 8000
// One chunk. A content-addressed chunk carries at most 4096 bytes plus its 8-byte span, and a
// single stamp covers exactly one chunk, so anything larger needs splitting and a stamp each.
const MAX_BLOB_BYTES = 4096

// One shared ephemeral keypair per memory, wrapped per recipient. Cheaper than a fresh
// ephemeral key per recipient, and standard multi-recipient ECIES practice.
const WRAP_KEY_LEN = 32
const EPHEMERAL_PUBKEY_LEN = 33 // compressed secp256k1 point
const WRAP_IV_LEN = 12
const WRAP_TAG_LEN = 16
const WRAP_ENTRY_LEN = 1 + WRAP_IV_LEN + WRAP_TAG_LEN + WRAP_KEY_LEN // agentIndex + iv + tag + key

export function derivePublicKey(privateKeyBuffer) {
  const ecdh = createECDH('secp256k1')
  ecdh.setPrivateKey(privateKeyBuffer)
  return ecdh.getPublicKey(null, 'compressed')
}

// Raw ECDH output is not a key on its own. HKDF is what makes this ECIES instead of just
// "computeSecret and hope". `info` binds the derived key to which agent slot it's wrapping and
// to the ephemeral public key for this memory, so two recipients never derive the same wrap key
// even if (hypothetically) they shared a public key, and a wrap key can never be reused across
// memories.
function deriveWrapKey(sharedSecret, agentIndex, ephemeralPub) {
  const info = Buffer.concat([Buffer.from([agentIndex]), ephemeralPub])
  return Buffer.from(hkdfSync('sha256', sharedSecret, Buffer.alloc(0), info, WRAP_KEY_LEN))
}

export function encryptForRoster(plaintext, recipients) {
  const contentKey = randomBytes(32)
  const contentIv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', contentKey, contentIv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const contentTag = cipher.getAuthTag()

  const ephemeral = createECDH('secp256k1')
  ephemeral.generateKeys()
  const ephemeralPub = ephemeral.getPublicKey(null, 'compressed')

  const wrappedEntries = recipients.map(({ agentIndex, publicKey }) => {
    const shared = ephemeral.computeSecret(publicKey)
    const wrapKey = deriveWrapKey(shared, agentIndex, ephemeralPub)
    const wrapIv = randomBytes(WRAP_IV_LEN)
    const wrapCipher = createCipheriv('aes-256-gcm', wrapKey, wrapIv)
    const wrappedKey = Buffer.concat([wrapCipher.update(contentKey), wrapCipher.final()])
    const wrapTag = wrapCipher.getAuthTag()
    return Buffer.concat([Buffer.from([agentIndex]), wrapIv, wrapTag, wrappedKey])
  })

  return Buffer.concat([
    Buffer.from([recipients.length]),
    ephemeralPub,
    ...wrappedEntries,
    contentIv,
    contentTag,
    ciphertext,
  ])
}

export function decryptWithKey(blob, agentIndex, privateKeyBuffer) {
  let offset = 0
  const nRecipients = blob[offset]; offset += 1
  const ephemeralPub = blob.subarray(offset, offset + EPHEMERAL_PUBKEY_LEN); offset += EPHEMERAL_PUBKEY_LEN

  let match = null
  for (let i = 0; i < nRecipients; i++) {
    const entry = blob.subarray(offset, offset + WRAP_ENTRY_LEN)
    offset += WRAP_ENTRY_LEN
    if (entry[0] === agentIndex) match = entry
  }
  if (!match) throw new Error(`agent index ${agentIndex} is not on this memory's roster`)

  const wrapIv = match.subarray(1, 1 + WRAP_IV_LEN)
  const wrapTag = match.subarray(1 + WRAP_IV_LEN, 1 + WRAP_IV_LEN + WRAP_TAG_LEN)
  const wrappedKey = match.subarray(1 + WRAP_IV_LEN + WRAP_TAG_LEN)

  const contentIv = blob.subarray(offset, offset + 12); offset += 12
  const contentTag = blob.subarray(offset, offset + 16); offset += 16
  const ciphertext = blob.subarray(offset)

  const ecdh = createECDH('secp256k1')
  ecdh.setPrivateKey(privateKeyBuffer)
  const shared = ecdh.computeSecret(ephemeralPub)
  const wrapKey = deriveWrapKey(shared, agentIndex, ephemeralPub)

  const wrapDecipher = createDecipheriv('aes-256-gcm', wrapKey, wrapIv)
  wrapDecipher.setAuthTag(wrapTag)
  const contentKey = Buffer.concat([wrapDecipher.update(wrappedKey), wrapDecipher.final()])

  const decipher = createDecipheriv('aes-256-gcm', contentKey, contentIv)
  decipher.setAuthTag(contentTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function agentPrivateKeyBuffer(agentId) {
  const hex = process.env[`ARKIV_PRIVATE_KEY_${agentId.toUpperCase()}`]
  if (!hex) return null
  return Buffer.from(hex.replace(/^0x/, ''), 'hex')
}

// The auditor is not an operational agent: it never signs an Arkiv transaction, so it isn't in
// AGENT_IDS and doesn't take a slot in that array's index scheme. Reserved index 3, one past the
// three agents, keeps its wrap entry structurally separate from decryptForAnyAgent's loop. A
// writer process that never sets AUDITOR_PUBLIC_KEY produces exactly the old 3-recipient blob.
const AUDITOR_AGENT_INDEX = 3

function auditorPublicKey() {
  const hex = process.env.AUDITOR_PUBLIC_KEY
  if (!hex) return null
  return Buffer.from(hex.replace(/^0x/, ''), 'hex')
}

function decryptForAnyAgent(blob) {
  for (const agentId of AGENT_IDS) {
    const priv = agentPrivateKeyBuffer(agentId)
    if (!priv) continue
    try {
      return decryptWithKey(blob, AGENT_IDS.indexOf(agentId), priv)
    } catch {
      continue // wrong slot for this agent, or auth failure — try the next configured key
    }
  }
  throw new Error('no configured agent key could decrypt this memory')
}

let bee
let stamper

// The stamper tracks which slot of each bucket it has used, so it has to outlive a single
// upload. A fresh one would hand out slot 0 twice, and the second chunk in a bucket would
// carry a stamp the first already spent.
export function getSwarm() {
  if (!bee) {
    const pk = process.env.SWARM_SIGNER_KEY
    const batchId = process.env.SWARM_POSTAGE_BATCH_ID
    if (!pk || !batchId) {
      throw new Error('set SWARM_SIGNER_KEY and SWARM_POSTAGE_BATCH_ID (the batch and the key that owns it) in the environment')
    }
    // Depth 23 is the drive we were given (§4). It isn't readable back from here: the gateway
    // exposes no /stamps, and this node accepted stamps for every depth from 16 to 30, so it
    // validates the signature but not the slot index. Depth decides only how many slots we
    // believe each bucket has before refusing to reuse one.
    const depth = Number(process.env.SWARM_BATCH_DEPTH ?? 23)
    bee = new Bee(GATEWAY)
    stamper = Stamper.fromBlank(new PrivateKey(pk), new BatchId(batchId), depth)
  }
  return { bee, stamper }
}

// Reusable by anything sealing content to the roster (uploadMemory here, src/lane.mjs's lane
// payloads). This is the recipient-building logic uploadMemory used to duplicate inline.
//
// If AUDITOR_PUBLIC_KEY is configured, every seal also wraps a copy of the content key for the
// auditor, using only their public key and never a private key held by this process. That's
// what makes "a single observer wallet with access to all logs" a real, separately-custodied
// identity instead of just a fourth name for a key this process already holds: the writer can
// grant the auditor access without ever being able to decrypt anything as the auditor itself.
export function sealForRoster(plaintext, roster = AGENT_IDS) {
  const recipients = roster.map((agentId) => {
    const priv = agentPrivateKeyBuffer(agentId)
    if (!priv) throw new Error(`no key configured for roster agent "${agentId}" — set ARKIV_PRIVATE_KEY_${agentId.toUpperCase()}`)
    return { agentIndex: AGENT_IDS.indexOf(agentId), publicKey: derivePublicKey(priv) }
  })
  const auditorPub = auditorPublicKey()
  if (auditorPub) recipients.push({ agentIndex: AUDITOR_AGENT_INDEX, publicKey: auditorPub })
  return encryptForRoster(plaintext, recipients)
}

export function openForAnyAgent(blob) {
  return decryptForAnyAgent(blob)
}

// Distinct from openForAnyAgent on purpose: the auditor decrypts with ONLY their own key, never
// by trying the three agents' keys, because a real deployment never hands the auditor's process
// those keys in the first place.
export function openForAuditor(blob, auditorPrivateKeyBuffer) {
  return decryptWithKey(blob, AUDITOR_AGENT_INDEX, auditorPrivateKeyBuffer)
}

export async function uploadMemory(content, roster = AGENT_IDS) {
  const { bee, stamper } = getSwarm()
  const blob = sealForRoster(Buffer.from(JSON.stringify(content), 'utf8'), roster)
  if (blob.length > MAX_BLOB_BYTES) {
    throw new Error(`encrypted content is ${blob.length} bytes; one stamped chunk holds ${MAX_BLOB_BYTES}`)
  }
  const chunk = bee.makeContentAddressedChunk(blob)
  const envelope = stamper.stamp(chunk.address.toUint8Array())
  await bee.chunk.upload(envelope, chunk, undefined, { timeout: FETCH_TIMEOUT_MS })
  return chunk.address.toHex()
}

// Builds the manifest locally and stamps every chunk with our batch. The gateway accepts a plain
// POST /bzz with no stamp and pays for it with its own postage, so that route is avoided.
export async function uploadPublicFile(filename, contentType, bytes) {
  if (bytes.length > MAX_BLOB_BYTES) {
    throw new Error(`public file is ${bytes.length} bytes; one stamped chunk holds ${MAX_BLOB_BYTES}`)
  }
  const { bee, stamper } = getSwarm()

  const leaf = bee.makeContentAddressedChunk(bytes)
  await bee.chunk.upload(stamper.stamp(leaf.address.toUint8Array()), leaf, undefined, { timeout: FETCH_TIMEOUT_MS })

  const manifest = new MantarayNode()
  manifest.addFork(filename, leaf.address.toUint8Array(), { 'Content-Type': contentType, Filename: filename })
  manifest.addFork('/', new Uint8Array(32), { 'website-index-document': filename })

  const { reference } = await manifest.saveRecursively(async (chunk) => {
    const raw = chunk.build().subarray(0, 8 + Number(chunk.span))
    await bee.chunk.upload(stamper.stamp(chunk.hash().toUint8Array()), raw, undefined, { timeout: FETCH_TIMEOUT_MS })
  })

  return Buffer.from(reference).toString('hex')
}

export async function downloadSealed(ref) {
  const { bee } = getSwarm()
  const chunk = await bee.chunk.download(ref, undefined, { timeout: FETCH_TIMEOUT_MS })
  return Buffer.from(chunk).subarray(8)
}

export async function downloadMemory(ref) {
  const plaintext = openForAnyAgent(await downloadSealed(ref))
  return JSON.parse(plaintext.toString('utf8'))
}
