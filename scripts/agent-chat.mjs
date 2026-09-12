// node scripts/agent-chat.mjs <atlas|nova> "<message>" — a real Claude session deciding
// whether to remember/recall, not a human filling out the write form. Talks to the same
// /api/memory and /api/query endpoints the browser UI uses, so a write here still shows
// up live on the mission-control page over the existing websocket.

import Anthropic from '@anthropic-ai/sdk'
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000'
const ENS_NAME = { atlas: 'atlas-ethrome26.eth', nova: 'nova-ethrome26.eth' }

const [agentId, message] = process.argv.slice(2)
if (!agentId || !message) {
  console.error('usage: node scripts/agent-chat.mjs <atlas|nova> "<message>"')
  process.exit(1)
}
if (!ENS_NAME[agentId]) {
  console.error('agentId must be "atlas" or "nova"')
  process.exit(1)
}

const rememberTool = betaTool({
  name: 'remember',
  description:
    'Store something worth keeping about the user or the conversation, indexed and later retrievable. ' +
    'Pick ttlBlocks yourself: short (tens of blocks) for task-scoped context that should lapse on its own, ' +
    'long (thousands of blocks) for durable user preferences.',
  inputSchema: {
    type: 'object',
    properties: {
      memoryType: { type: 'string', enum: ['fact', 'task', 'preference', 'event'] },
      tag: { type: 'string', description: 'short topic string' },
      importance: { type: 'integer', minimum: 0, maximum: 10 },
      content: { type: 'string', description: 'what to remember, in plain text' },
      ttlBlocks: { type: 'integer', minimum: 1 },
    },
    required: ['memoryType', 'tag', 'importance', 'content', 'ttlBlocks'],
  },
  run: async (args) => {
    console.log(`  🔧 remember(${JSON.stringify(args)})`)
    const res = await fetch(`${BASE_URL}/api/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId, memoryType: args.memoryType, tag: args.tag, importance: args.importance,
        content: { note: args.content }, ttlBlocks: args.ttlBlocks,
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      console.log(`     ✕ ${data.error}`)
      return `write failed: ${data.error}`
    }
    console.log(`     ✓ entity ${data.entityKey}, tx ${data.txHash}`)
    return `stored. entityKey=${data.entityKey} tx=${data.txHash} appliedExpiresAtBlock=${data.appliedExpiresAt}`
  },
})

const recallTool = betaTool({
  name: 'recall',
  description:
    "Look up memories matching a filter. agentId can be your own id or another agent's — " +
    'memory on this mesh is shared and portable across agents by design, not siloed per assistant.',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', enum: ['atlas', 'nova'] },
      memoryType: { type: 'string', enum: ['fact', 'task', 'preference', 'event'] },
      minImportance: { type: 'integer', minimum: 0, maximum: 10 },
      tagPrefix: { type: 'string' },
    },
    required: ['agentId'],
  },
  run: async (args) => {
    console.log(`  🔧 recall(${JSON.stringify(args)})`)
    const params = new URLSearchParams({ agentId: args.agentId })
    if (args.memoryType) params.set('memoryType', args.memoryType)
    if (args.minImportance !== undefined) params.set('minImportance', String(args.minImportance))
    if (args.tagPrefix) params.set('tagPrefix', args.tagPrefix)
    const res = await fetch(`${BASE_URL}/api/query?${params}`)
    const rows = await res.json()
    if (!res.ok) {
      console.log(`     ✕ ${rows.error}`)
      return `query failed: ${rows.error}`
    }
    console.log(`     ✓ ${rows.length} match(es)`)
    if (!rows.length) return 'no memories found matching that filter'
    return rows
      .map((r) => `- [${r.attributes.memory_type}/${r.attributes.tag}] ${JSON.stringify(r.content)} (importance ${r.attributes.importance}, expires block ${r.expiresAt})`)
      .join('\n')
  },
})

const system = `You are ${agentId}, an AI agent with the identity ${ENS_NAME[agentId]} on Agent Memory Mesh. ` +
  'You have two tools: remember and recall. Use them naturally when the conversation calls for it, and be ' +
  'concrete in your reply about what you actually stored or found.'

const client = new Anthropic()

const finalMessage = await client.beta.messages.toolRunner({
  model: 'claude-opus-5',
  max_tokens: 2048,
  system,
  tools: [rememberTool, recallTool],
  messages: [{ role: 'user', content: message }],
})

const text = finalMessage.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
console.log(`\n${agentId}: ${text}`)
