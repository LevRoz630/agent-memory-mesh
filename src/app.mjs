// The REST surface, shared between local dev (server.mjs, which adds a real websocket push
// on top) and the Vercel deployment (api/index.mjs, which can't hold a persistent websocket
// — Vercel's Node runtime is a function per request, no long-lived process — so it exposes
// /api/recent for the frontend's polling fallback instead). Deploying server.mjs as-is to
// Vercel returned FUNCTION_INVOCATION_FAILED on every route — confirmed live, not assumed.

import express from 'express'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { queryMemories, queryRecent } from './arkiv.mjs'
import { writeMemory, readMemoryContent } from './memory.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function serializeAttrs(a) {
  return Object.fromEntries(Object.entries(a ?? {}).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]))
}

async function withContent(entity) {
  let content = null
  try {
    content = await readMemoryContent(entity.attributes)
  } catch (e) {
    content = { error: `content unavailable: ${e.message}` }
  }
  return { key: entity.key, expiresAt: String(entity.expiresAt), attributes: serializeAttrs(entity.attributes), content }
}

export function createApp({ pub, wallet }) {
  const app = express()
  app.use(express.json())
  app.use(express.static(join(__dirname, '..', 'public')))

  app.post('/api/memory', async (req, res) => {
    try {
      const { agentId, memoryType, tag, importance, content, ttlBlocks } = req.body
      if (!agentId || !memoryType || !tag || importance === undefined || !content || !ttlBlocks) {
        return res.status(400).json({ error: 'agentId, memoryType, tag, importance, content, ttlBlocks are all required' })
      }
      const result = await writeMemory(wallet, {
        agentId, memoryType, tag, importance: Number(importance), content, ttlBlocks: Number(ttlBlocks),
      })
      res.json({ ...result, appliedExpiresAt: result.appliedExpiresAt.toString() })
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

  // Polling fallback for contexts with no persistent websocket (serverless deployments).
  // The real Mission 03 mechanism is the websocket push in server.mjs; this exists only
  // so the publicly deployed app still shows activity without lying about how.
  app.get('/api/recent', async (_req, res) => {
    try {
      const entities = await queryRecent(pub, { limit: 20 })
      res.json(await Promise.all(entities.map(withContent)))
    } catch (e) {
      console.error('recent failed:', e)
      res.status(500).json({ error: e.message })
    }
  })

  app.get('/api/head', async (_req, res) => {
    const head = await pub.getBlockNumber()
    res.json({ head: head.toString() })
  })

  // Catches errors that never reach a route handler at all — malformed JSON or an oversized
  // body both fail inside express.json() itself. Without this, Express's default error
  // handler serves a full stack trace, including absolute server file paths, to the client.
  app.use((err, _req, res, _next) => {
    console.error('request failed:', err)
    res.status(err.status || 400).json({ error: 'invalid request' })
  })

  return app
}
