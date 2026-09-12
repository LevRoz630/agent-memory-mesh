// Swarm leg: the memory content itself, encrypted and content-addressed. @snaha/swarm-id's
// SwarmIdClient is an iframe-based browser passkey flow, unusable from a server, so this goes
// through @ethersphere/bee-js against a gateway.
//
// Encryption is app-level (AES-256-GCM), so the gateway never sees plaintext and references are
// 64 hex chars — the gateway's own Swarm-Encrypt header would make them 128.
//
// Postage: uploads are stamped locally with our own batch, which is why this uses /chunks
// rather than /bytes. Verified live against api.gateway.ethswarm.org:
//   - POST /bytes with swarm-postage-stamp        -> 400, the proxy demands swarm-postage-batch-id
//   - POST /bytes with swarm-postage-batch-id     -> 404 "batch with id not found"
//   - POST /chunks with a signed envelope         -> 201, and a wrong signing key is rejected
//     with "stamp signature is invalid", so the batch is genuinely being spent
// A batch shared as a key is only usable this way: the node holds no stamp issuer for it, so
// every chunk has to arrive already signed.

import { createCipheriv, createDecipheriv, randomBytes, createECDH, hkdfSync } from 'node:crypto'
import { Bee, BatchId, PrivateKey, Stamper } from '@ethersphere/bee-js'

const GATEWAY = process.env.SWARM_GATEWAY ?? 'https://api.gateway.ethswarm.org'
// A gateway that accepts the connection and then stalls leaves a bare fetch() pending
// indefinitely, hanging whichever route is awaiting it.
const FETCH_TIMEOUT_MS = 8000
// One chunk. A content-addressed chunk carries at most 4096 bytes plus its 8-byte span, and a
// single stamp covers exactly one chunk, so anything larger needs splitting and a stamp each.
const MAX_BLOB_BYTES = 4096

// One shared ephemeral keypair per memory, wrapped per recipient — cheaper than a fresh
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

// Raw ECDH output is not a key — HKDF is what makes this ECIES rather than "computeSecret and
// hope". `info` binds the derived key to which agent slot it's wrapping, so two recipients never
// derive the same wrap key even if (hypothetically) they shared a public key.
function deriveWrapKey(sharedSecret, agentIndex) {
  return Buffer.from(hkdfSync('sha256', sharedSecret, Buffer.alloc(0), Buffer.from([agentIndex]), WRAP_KEY_LEN))
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
    const wrapKey = deriveWrapKey(shared, agentIndex)
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
  const wrapKey = deriveWrapKey(shared, agentIndex)

  const wrapDecipher = createDecipheriv('aes-256-gcm', wrapKey, wrapIv)
  wrapDecipher.setAuthTag(wrapTag)
  const contentKey = Buffer.concat([wrapDecipher.update(wrappedKey), wrapDecipher.final()])

  const decipher = createDecipheriv('aes-256-gcm', contentKey, contentIv)
  decipher.setAuthTag(contentTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

// Rotating MEMORY_ENC_KEY makes already-uploaded content undecryptable; a Swarm reference
// carries no key material.
function getKey() {
  const hex = process.env.MEMORY_ENC_KEY
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('set MEMORY_ENC_KEY to a 32-byte hex string (64 hex chars) in the environment')
  }
  return Buffer.from(hex, 'hex')
}

function encrypt(plaintext) {
  const key = getKey()
  const iv = randomBytes(12) // GCM standard
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()
  // [12-byte iv][16-byte authTag][ciphertext] — one blob, self-describing length-wise.
  return Buffer.concat([iv, authTag, ciphertext])
}

function decrypt(blob) {
  const key = getKey()
  const iv = blob.subarray(0, 12)
  const authTag = blob.subarray(12, 28)
  const ciphertext = blob.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

let bee
let stamper

// The stamper tracks which slot of each bucket it has used, so it has to outlive a single
// upload — a fresh one would hand out slot 0 twice and the second chunk in a bucket would
// carry a stamp the first already spent.
function getSwarm() {
  if (!bee) {
    const pk = process.env.SWARM_SIGNER_KEY
    const batchId = process.env.SWARM_POSTAGE_BATCH_ID
    if (!pk || !batchId) {
      throw new Error('set SWARM_SIGNER_KEY and SWARM_POSTAGE_BATCH_ID (the batch and the key that owns it) in the environment')
    }
    // Depth 23 is the drive we were given (§4). It is not readable back from here — the
    // gateway exposes no /stamps, and this node accepted stamps for every depth from 16 to 30,
    // so it validates the signature but not the slot index. Depth decides only how many slots
    // we believe each bucket has before refusing to reuse one.
    const depth = Number(process.env.SWARM_BATCH_DEPTH ?? 23)
    bee = new Bee(GATEWAY)
    stamper = Stamper.fromBlank(new PrivateKey(pk), new BatchId(batchId), depth)
  }
  return { bee, stamper }
}

export async function uploadMemory(content) {
  const { bee, stamper } = getSwarm()
  const blob = encrypt(Buffer.from(JSON.stringify(content), 'utf8'))
  if (blob.length > MAX_BLOB_BYTES) {
    throw new Error(`encrypted content is ${blob.length} bytes; one stamped chunk holds ${MAX_BLOB_BYTES}`)
  }

  const chunk = bee.makeContentAddressedChunk(blob)
  const envelope = stamper.stamp(chunk.address.toUint8Array())
  await bee.chunk.upload(envelope, chunk, undefined, { timeout: FETCH_TIMEOUT_MS })
  return chunk.address.toHex()
}

export async function downloadMemory(ref) {
  const { bee } = getSwarm()
  const chunk = await bee.chunk.download(ref, undefined, { timeout: FETCH_TIMEOUT_MS })
  // /chunks hands back the wire chunk, span included; the blob starts after it.
  const plaintext = decrypt(Buffer.from(chunk).subarray(8))
  return JSON.parse(plaintext.toString('utf8'))
}
