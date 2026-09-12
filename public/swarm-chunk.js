const SWARM_GATEWAY = 'https://api.gateway.ethswarm.org'
const SWARM_SPAN_BYTES = 8
const SWARM_PREVIEW_BYTES = 192

const swarmChunkUrl = (ref) => `${SWARM_GATEWAY}/chunks/${encodeURIComponent(ref)}`
const swarmFileUrl = (ref) => `${SWARM_GATEWAY}/bzz/${encodeURIComponent(ref)}/`

// The gateway serves chunks as binary/octet-stream, so following the link downloads a file.
// It allows cross-origin reads, so the page fetches the bytes itself and shows them instead.
async function fetchSwarmChunk(ref) {
  if (!/^[0-9a-f]{64}$/i.test(String(ref))) throw new Error('not a Swarm reference')
  const res = await fetch(swarmChunkUrl(ref))
  if (!res.ok) throw new Error(`Swarm gateway returned ${res.status}`)
  const payload = new Uint8Array(await res.arrayBuffer()).subarray(SWARM_SPAN_BYTES)
  const hex = Array.from(payload.subarray(0, SWARM_PREVIEW_BYTES), (b) => b.toString(16).padStart(2, '0')).join('')
  return { bytes: payload.length, hex, truncated: payload.length > SWARM_PREVIEW_BYTES, host: new URL(SWARM_GATEWAY).host }
}
