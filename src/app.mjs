// REST surface used by server.mjs, which adds the control room's demo endpoints and /live on top.

import express from 'express'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { queryMemories } from './arkiv.mjs'
import { writeMemory, readMemoryContent } from './memory.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

function serializeAttrs(a) {
  return Object.fromEntries(Object.entries(a ?? {}).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]))
}

async function withContent(entity) {
  let content = null
  try {
    content = await readMemoryContent(entity.attributes)
  } catch (e) {
    content = { error: `content unavailable: ${e.message}` }
  }
  return { key: entity.key, owner: entity.owner, expiresAt: String(entity.expiresAt), attributes: serializeAttrs(entity.attributes), content }
}

export function createApp({ pub, signers }) {
  const app = express()
  app.use(express.json())
  app.use(express.static(join(__dirname, '..', 'public')))

  // Only a real positive integer clamps. A typo used to become NaN, which is falsy, which
  // silently disabled the clamp altogether.
  const rawMax = Number(process.env.DEMO_MAX_TTL_BLOCKS)
  const maxTtlBlocks = Number.isInteger(rawMax) && rawMax > 0 ? rawMax : undefined

  app.post('/api/memory', async (req, res) => {
    try {
      const { agentId, memoryType, tag, importance, content, ttlBlocks } = req.body
      if (!agentId || !memoryType || !tag || importance === undefined || !content || !ttlBlocks) {
        return res.status(400).json({ error: 'agentId, memoryType, tag, importance, content, ttlBlocks are all required' })
      }
      // Without this a fractional or negative value reaches the SDK and surfaces as a 500 with a
      // raw BigInt/InvalidExpiry message.
      const importanceNum = Number(importance)
      const requestedTtl = Number(ttlBlocks)
      if (!Number.isInteger(importanceNum) || importanceNum < 0) {
        return res.status(400).json({ error: 'importance must be a non-negative integer' })
      }
      if (!Number.isInteger(requestedTtl) || requestedTtl < 1) {
        return res.status(400).json({ error: 'ttlBlocks must be a positive integer' })
      }
      // The signer is chosen by agentId, so an entity's `owner` is the agent that wrote it.
      // An unknown agent is refused instead of getting signed for by someone else.
      const signer = signers.get(agentId)
      if (!signer) {
        return res.status(400).json({ error: `no signer configured for agentId "${agentId}" — known: ${[...signers.keys()].join(', ')}` })
      }
      const isClaim = memoryType === 'claim'
      const appliedTtl = (maxTtlBlocks && isClaim) ? Math.min(requestedTtl, maxTtlBlocks) : requestedTtl
      const result = await writeMemory(signer.wallet, {
        agentId, memoryType, tag, importance: importanceNum, content, ttlBlocks: appliedTtl,
      })
      // Report what was asked for AND what was written. Returning only the clamped number as
      // "requested" made the UI and the agent both believe the clamp had not happened.
      res.json({
        ...result,
        requestedTtlBlocks: requestedTtl,
        ttlClamped: appliedTtl !== requestedTtl,
        appliedExpiresAt: result.appliedExpiresAt.toString(),
      })
    } catch (e) {
      console.error('write failed:', e)
      res.status(500).json({ error: e.message })
    }
  })

  app.get('/api/query', async (req, res) => {
    try {
      const { agentId, memoryType, minImportance, tagPrefix } = req.query
      if (!agentId) return res.status(400).json({ error: 'agentId is required' })
      const entities = await queryMemories(pub, {
        agentId,
        memoryType: memoryType || undefined,
        minImportance: minImportance !== undefined ? Number(minImportance) : undefined,
        tagPrefix: tagPrefix || undefined,
      })
      res.json(await Promise.all(entities.map(withContent)))
    } catch (e) {
      console.error('query failed:', e)
      res.status(500).json({ error: e.message })
    }
  })

  app.get('/api/head', async (_req, res) => {
    try {
      const head = await pub.getBlockNumber()
      res.json({ head: head.toString() })
    } catch (e) {
      console.error('head failed:', e)
      res.status(500).json({ error: e.message })
    }
  })

  // Malformed JSON and oversized bodies fail inside express.json(), before any route handler.
  // Express's default handler would serve the stack trace, including file paths, to the client.
  app.use((err, _req, res, _next) => {
    console.error('request failed:', err)
    res.status(err.status || 400).json({ error: 'invalid request' })
  })

  return app
}
