// Vercel entrypoint. No websocket layer here — see src/app.mjs's header comment for why.
// Clients hold the Arkiv keypair for the lifetime of the function's module scope, reused
// across warm invocations (Vercel keeps a function instance alive between nearby requests).

import { createApp } from '../src/app.mjs'
import { makeClients } from '../src/arkiv.mjs'

const privateKey = process.env.ARKIV_PRIVATE_KEY
if (!privateKey) {
  throw new Error('set ARKIV_PRIVATE_KEY in the Vercel project environment')
}

const { pub, wallet } = makeClients({ privateKey })
const app = createApp({ pub, wallet })

export default app
