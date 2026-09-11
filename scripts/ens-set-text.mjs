// Sets the agent-profile text record on an already-registered ENSv2 name. Registration and
// records are separate steps (docs.ens.domains/ensv2/tutorial-app-developers) — this is the
// second step, run after scripts/ens-register.mjs.
//
// Resolver ABI verified live against Blockscout's deployed-contract API, same approach that
// caught the wrong duration type in the registrar script.
//
//   PRIVATE_KEY=0x... node scripts/ens-set-text.mjs atlas-ethrome26 "profile text here"

import { createWalletClient, createPublicClient, http, parseAbi, isHex, namehash } from 'viem'
import { sepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

const [label, profile] = process.argv.slice(2)
if (!label || !profile) {
  console.error('usage: PRIVATE_KEY=0x... node scripts/ens-set-text.mjs <label> "<profile text>"')
  process.exit(1)
}

const pk = process.env.PRIVATE_KEY
if (!pk || !isHex(pk)) {
  console.error('set PRIVATE_KEY in the environment')
  process.exit(1)
}

const RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com'
const PUBLIC_RESOLVER_V2 = '0xe7b9a25607e02da8145e4eb1836ca539e53f11f7'
const RESOLVER_ABI = parseAbi([
  'function setText(bytes32 node, string key, string value)',
  'function text(bytes32 node, string key) view returns (string)',
])

const account = privateKeyToAccount(pk)
const pub = createPublicClient({ chain: sepolia, transport: http(RPC_URL) })
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC_URL) })

const fullName = `${label}.eth`
const node = namehash(fullName)
console.log(`name  ${fullName}`)
console.log(`node  ${node}`)

const tx = await wallet.writeContract({
  address: PUBLIC_RESOLVER_V2, abi: RESOLVER_ABI, functionName: 'setText',
  args: [node, 'description', profile],
})
const receipt = await pub.waitForTransactionReceipt({ hash: tx })
console.log(`set, tx=${tx}, block=${receipt.blockNumber}`)

const readBack = await pub.readContract({
  address: PUBLIC_RESOLVER_V2, abi: RESOLVER_ABI, functionName: 'text', args: [node, 'description'],
})
console.log(`read back: "${readBack}"`)
