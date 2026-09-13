// Runs every reproduction script in this directory and summarizes which findings
// reproduced. Each script exits 0 when its finding reproduced, 1 when it did not.
//
//   npm run feedback:repro          all of them
//   npm run feedback:repro -- 03    only scripts whose filename starts with 03
//
// Scripts inherit this process's environment, so the --env-file=.env in the npm
// script covers them too.

import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const filter = process.argv[2]

const scripts = (await readdir(here))
  .filter((f) => f.endsWith('.mjs') && f !== 'run-all.mjs')
  .filter((f) => !filter || f.startsWith(filter))
  .sort()

if (scripts.length === 0) {
  console.error(filter ? `no scripts match "${filter}"` : 'no scripts found')
  process.exit(1)
}

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, file)], { stdio: 'inherit' })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

const results = []
for (const file of scripts) {
  console.log(`\n${'='.repeat(78)}\n${file}\n${'='.repeat(78)}`)
  const started = Date.now()
  const code = await run(file)
  results.push({ file, code, seconds: ((Date.now() - started) / 1000).toFixed(1) })
}

console.log(`\n${'='.repeat(78)}\nsummary\n${'='.repeat(78)}`)
for (const { file, code, seconds } of results) {
  console.log(`${code === 0 ? 'reproduced    ' : 'NOT reproduced'}  ${file}  (${seconds}s)`)
}

const failed = results.filter((r) => r.code !== 0).length
console.log(`\n${results.length - failed}/${results.length} reproduced`)
process.exit(failed === 0 ? 0 : 1)
