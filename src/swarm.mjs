// Swarm leg: the memory content itself, encrypted and content-addressed. @snaha/swarm-id's
// SwarmIdClient is an iframe-based browser passkey flow, unusable from a server, so this goes
// through the plain gateway fetch() path the Swarm brief allows.
//
// Encryption is app-level (AES-256-GCM), so the gateway never sees plaintext and references are
// 64 hex chars — the gateway's own Swarm-Encrypt header would make them 128.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const GATEWAY = process.env.SWARM_GATEWAY ?? 'https://api.gateway.ethswarm.org'
// A gateway that accepts the connection and then stalls leaves a bare fetch() pending
// indefinitely, hanging whichever route is awaiting it.
const FETCH_TIMEOUT_MS = 8000

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

export async function downloadMemory(ref) {
  const res = await fetch(`${GATEWAY}/bytes/${ref}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) {
    throw new Error(`Swarm download failed: ${res.status} for ref ${ref}`)
  }
  const blob = Buffer.from(await res.arrayBuffer())
  const plaintext = decrypt(blob)
  return JSON.parse(plaintext.toString('utf8'))
}
