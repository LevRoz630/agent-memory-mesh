// Register a flat top-level Sepolia name on the ENSv2 beta deployment, as an agent
// identity. Two names needed (one per demo agent) — run twice, or loop LABELS below.
//
// Flow (commit-reveal, per docs.ens.domains/ensv2/tutorial-app-developers +
// docs.ens.domains/ensv2/eth-registrar): mint MockUSDC -> approve ETHRegistrar ->
// makeCommitment -> commit -> wait >=60s (MIN_COMMITMENT_AGE) -> register.
//
// UNVERIFIED BEFORE THIS RUN: exact ABI param types/order came from a doc-page summary,
// not the raw Solidity source — expect the first call to error with a real signature
// mismatch and adjust from that error, same as every other "verify against the live
// chain" script in this project's pre-flight work. Budget for that inside the 60-minute
// cap, don't treat this script as done until it has actually landed a tx.
//
// Needs Sepolia ETH for gas. Faucets: https://sepoliafaucet.com or Alchemy/Infura's.
// Needs PRIVATE_KEY in the environment (a Sepolia-funded wallet), never hardcoded.
//
//   PRIVATE_KEY=0x... node scripts/ens-register.mjs atlas
//   PRIVATE_KEY=0x... node scripts/ens-register.mjs nova

import { createPublicClient, createWalletClient, http, parseAbi, isHex } from 'viem'
import { sepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { randomBytes } from 'node:crypto'

const LABEL = process.argv[2]
if (!LABEL) {
  console.error('usage: PRIVATE_KEY=0x... node scripts/ens-register.mjs <label>')
  process.exit(1)
}

const pk = process.env.PRIVATE_KEY
if (!pk || !isHex(pk)) {
  console.error('set PRIVATE_KEY (a Sepolia-funded wallet private key) in the environment')
  process.exit(1)
}

// Confirmed live 2026-09-11 from docs.ens.domains/learn/deployments#sepolia-ensv2-beta
const ETH_REGISTRAR = '0xa88553f454b77203b0d036a05c894d555eaaa2cc'
const MOCK_USDC = '0x768f42455a2d082e23ceef7d51e5787c82d67a39'
const PUBLIC_RESOLVER_V2 = '0xe7b9a25607e02da8145e4eb1836ca539e53f11f7'
const NO_SUBREGISTRY = '0x0000000000000000000000000000000000000000'
const NO_REFERRER = '0x0000000000000000000000000000000000000000000000000000000000000000'.slice(0, 66)

const ERC20_ABI = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
])

// Verified 2026-09-11 against the deployed contract's actual ABI via Blockscout
// (eth-sepolia.blockscout.com/api/v2/smart-contracts/<address>), not a doc-page summary —
// the earlier doc-summary version had `duration` as uint256, which is wrong (uint64) and
// produced a different selector, hence the first run's silent "execution reverted".
const ETH_REGISTRAR_ABI = parseAbi([
  'function isAvailable(string label) view returns (bool)',
  'function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)',
  'function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) view returns (bytes32)',
  'function commit(bytes32 commitment)',
  'function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256 tokenId)',
])

// Explicit RPC, not viem's default rotation — one of those endpoints hung indefinitely on
// a live run (no error, no response) rather than failing fast. publicnode's Sepolia
// endpoint answered eth_getBalance in well under a second when checked directly with curl.
const RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com'

const account = privateKeyToAccount(pk)
const pub = createPublicClient({ chain: sepolia, transport: http(RPC_URL) })
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC_URL) })

console.log(`account   ${account.address}`)
console.log(`label     ${LABEL}`)

const ethBal = await pub.getBalance({ address: account.address })
console.log(`Sepolia ETH balance: ${ethBal} wei`)
if (ethBal === 0n) {
  console.error('\nno Sepolia ETH — fund this wallet first (sepoliafaucet.com), gas will fail otherwise')
  process.exit(1)
}

console.log('\n1. isAvailable')
const available = await pub.readContract({
  address: ETH_REGISTRAR, abi: ETH_REGISTRAR_ABI, functionName: 'isAvailable', args: [LABEL],
})
console.log(`   ${LABEL}: ${available ? 'AVAILABLE' : 'TAKEN — pick a different label'}`)
if (!available) process.exit(1)

const DURATION = 60n * 60n * 24n * 30n // 30 days, plenty for a hackathon demo

console.log('\n2. getRegisterPrice')
const [base, premium] = await pub.readContract({
  address: ETH_REGISTRAR, abi: ETH_REGISTRAR_ABI, functionName: 'getRegisterPrice',
  args: [LABEL, DURATION, MOCK_USDC],
})
const total = base + premium
console.log(`   base=${base} premium=${premium} total=${total}`)

console.log('\n3. mint MockUSDC (test token, free)')
const mintTx = await wallet.writeContract({
  address: MOCK_USDC, abi: ERC20_ABI, functionName: 'mint', args: [account.address, total * 2n],
})
await pub.waitForTransactionReceipt({ hash: mintTx })
console.log(`   minted, tx=${mintTx}`)

console.log('\n4. approve ETHRegistrar to spend MockUSDC')
const approveTx = await wallet.writeContract({
  address: MOCK_USDC, abi: ERC20_ABI, functionName: 'approve', args: [ETH_REGISTRAR, total * 2n],
})
await pub.waitForTransactionReceipt({ hash: approveTx })
console.log(`   approved, tx=${approveTx}`)

const secret = `0x${randomBytes(32).toString('hex')}`

console.log('\n5. makeCommitment + commit')
const commitment = await pub.readContract({
  address: ETH_REGISTRAR, abi: ETH_REGISTRAR_ABI, functionName: 'makeCommitment',
  args: [LABEL, account.address, secret, NO_SUBREGISTRY, PUBLIC_RESOLVER_V2, DURATION, NO_REFERRER],
})
const commitTx = await wallet.writeContract({
  address: ETH_REGISTRAR, abi: ETH_REGISTRAR_ABI, functionName: 'commit', args: [commitment],
})
await pub.waitForTransactionReceipt({ hash: commitTx })
console.log(`   committed, tx=${commitTx}`)

console.log('\n6. waiting 65s for MIN_COMMITMENT_AGE...')
await new Promise((r) => setTimeout(r, 65_000))

console.log('\n7. register')
const registerTx = await wallet.writeContract({
  address: ETH_REGISTRAR, abi: ETH_REGISTRAR_ABI, functionName: 'register',
  args: [LABEL, account.address, secret, NO_SUBREGISTRY, PUBLIC_RESOLVER_V2, DURATION, MOCK_USDC, NO_REFERRER],
})
const receipt = await pub.waitForTransactionReceipt({ hash: registerTx })
console.log(`   registered, tx=${registerTx}, block=${receipt.blockNumber}`)
console.log(`\n${LABEL}.eth is now owned by ${account.address} on Sepolia (ENSv2 beta)`)
console.log('Explorer: https://sepolia.etherscan.io/tx/' + registerTx)
