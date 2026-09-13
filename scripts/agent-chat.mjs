// A Claude session deciding for itself whether to remember or recall, through the server's REST
// endpoints.
//
//   node scripts/agent-chat.mjs <atlas|nova|sol> "<message>"

import Anthropic from '@anthropic-ai/sdk'
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { AGENT_IDS } from '../src/arkiv.mjs'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000'

const [agentId, message] = process.argv.slice(2)
if (!agentId || !message) {
  console.error(`usage: node scripts/agent-chat.mjs <${AGENT_IDS.join('|')}> "<message>"`)
  process.exit(1)
}
if (!AGENT_IDS.includes(agentId)) {
  console.error(`agentId must be one of: ${AGENT_IDS.join(', ')}`)
  process.exit(1)
}

const rememberTool = betaTool({
  name: 'remember',
  description:
    'Store something worth keeping about the user or the conversation, indexed and later retrievable. ' +
    'Pick ttlBlocks yourself: short (tens of blocks) for a lease that must lapse on its own, ' +
    'up to the maximum for a record that should outlive the work. ' +
    'Use memoryType "claim" to take a task another agent filed: a claim is a lease, so give it a short ' +
    'ttlBlocks — if you stop working the task, it has to lapse on its own so someone else can pick it up.',
  inputSchema: {
    type: 'object',
    properties: {
      memoryType: { type: 'string', enum: ['event', 'claim', 'lane', 'done', 'verdict'] },
      tag: { type: 'string', description: 'short topic string' },
      importance: { type: 'integer', minimum: 0, maximum: 10 },
      content: { type: 'string', description: 'what to remember, in plain text' },
      ttlBlocks: { type: 'integer', minimum: 1, maximum: 1800, description: 'at ~2s/block, 1800 is ~1 hour — there is no delete call, so entities are never removed early' },
    },
    required: ['memoryType', 'tag', 'importance', 'content', 'ttlBlocks'],
  },
  run: async (args) => {
    console.log(`  remember(${JSON.stringify(args)})`)
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
      agentId: { type: 'string', enum: AGENT_IDS },
      memoryType: { type: 'string', enum: ['event', 'claim', 'lane', 'done', 'verdict'] },
      minImportance: { type: 'integer', minimum: 0, maximum: 10 },
      tagPrefix: { type: 'string' },
    },
    required: ['agentId'],
  },
  run: async (args) => {
    console.log(`  recall(${JSON.stringify(args)})`)
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
      .map((r) => `- [${r.attributes.memory_type}/${r.attributes.tag}] ${JSON.stringify(r.content)}, importance ${r.attributes.importance}, expires block ${r.expiresAt}`)
      .join('\n')
  },
})

const system = `You are ${agentId}, an AI agent on Hydra. ` +
  'You have two tools: remember and recall. Use them naturally when the conversation calls for it. ' +
  'Reply with only what was stored or found, stated plainly in a sentence or two. ' +
  'No caveats, opinions, suggestions, or commentary beyond that.'

const client = new Anthropic()

try {
  const finalMessage = await client.beta.messages.toolRunner({
    model: 'claude-opus-5',
    max_tokens: 2048,
    system,
    tools: [rememberTool, recallTool],
    messages: [{ role: 'user', content: message }],
  })
  const text = finalMessage.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  console.log(`\n${agentId}: ${text}`)
} catch (e) {
  console.error(`\n${agentId} failed: ${e.message}`)
  process.exit(1)
}
