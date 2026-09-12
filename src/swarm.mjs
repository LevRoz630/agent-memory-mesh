// Swarm leg: content storage for Agent Memory Mesh. Arkiv holds the pointer + metadata
// (src/arkiv.mjs); this file holds the actual memory content, encrypted, content-addressed.
//
// @snaha/swarm-id's SwarmIdClient is iframe-based browser auth (interactive passkey/connect
// flow) — no fit for a server writing memories programmatically. Using the plain gateway
// fetch() path instead, which Swarm's own bounty brief explicitly allows.
//
// Encryption is app-level (AES-256-GCM), not Swarm's gateway-side Swarm-Encrypt header —
// the gateway never sees plaintext at all this way. References are therefore always plain
// 64 hex chars, not the 128-hex form Swarm-Encrypt produces.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const GATEWAY = process.env.SWARM_GATEWAY ?? 'https://api.gateway.ethswarm.org'
// A bare fetch() against a gateway that accepts the connection and then stalls stays
// pending indefinitely, hanging whichever route awaits it — /api/query and /api/recent both
// fan out concurrent downloads. Bound every call instead.
// Reproduction: scripts/feedback/09-fetch-timeout.mjs
const FETCH_TIMEOUT_MS = 8000

/**
 * The memory-content encryption key. 32 bytes, hex-encoded, from the environment — never
 * hardcoded. If this changes between runs, previously uploaded content becomes
 * undecryptable (the ref alone carries no key material).
 */
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

/**
 * Encrypts `content` (any JSON-serializable value) and uploads it. Returns the plain
 * 64-hex Swarm reference — the pointer that goes in an Arkiv entity's swarm_ref attribute.
 */
export async function uploadMemory(content) {
  const plaintext = Buffer.from(JSON.stringify(content), 'utf8')
  const blob = encrypt(plaintext)

  const res = await fetch(`${GATEWAY}/bytes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: blob,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`Swarm upload failed: ${res.status} ${await res.text().catch(() => '')}`)
  }
  const { reference } = await res.json()
  return reference
}

/**
 * Fetches and decrypts the content a swarm_ref points at.
 */
export async function downloadMemory(ref) {
  const res = await fetch(`${GATEWAY}/bytes/${ref}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) {
    throw new Error(`Swarm download failed: ${res.status} for ref ${ref}`)
  }
  const blob = Buffer.from(await res.arrayBuffer())
  const plaintext = decrypt(blob)
  return JSON.parse(plaintext.toString('utf8'))
}
