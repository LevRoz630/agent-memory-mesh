// Vercel entrypoint, no websocket layer (see src/app.mjs). The clients live in module scope so
// warm invocations reuse them.

import { createApp } from '../src/app.mjs'
import { makeClients, makeAgentSigners } from '../src/arkiv.mjs'

const privateKey = process.env.ARKIV_PRIVATE_KEY
if (!privateKey) {
  throw new Error('set ARKIV_PRIVATE_KEY in the Vercel project environment')
}

const { pub } = makeClients({ privateKey })
const signers = makeAgentSigners()
if (signers.size === 0) {
  throw new Error('set ARKIV_PRIVATE_KEY_ATLAS / _NOVA / _SOL in the Vercel project environment')
}
const app = createApp({ pub, signers })

export default app
