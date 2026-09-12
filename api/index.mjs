// Vercel entrypoint, no websocket layer — see src/app.mjs. The clients live in module scope so
// warm invocations reuse them.

import { createApp } from '../src/app.mjs'
import { makeClients } from '../src/arkiv.mjs'

const privateKey = process.env.ARKIV_PRIVATE_KEY
if (!privateKey) {
  throw new Error('set ARKIV_PRIVATE_KEY in the Vercel project environment')
}

const { pub, wallet } = makeClients({ privateKey })
const app = createApp({ pub, wallet })

export default app
