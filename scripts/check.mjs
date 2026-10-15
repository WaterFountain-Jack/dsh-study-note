import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
for (const directory of ['src', 'scripts', 'tests']) {
  for (const name of await readdir(new URL(`../${directory}/`, import.meta.url))) {
    if (!/\.(?:js|mjs)$/u.test(name)) continue
    const result = spawnSync(process.execPath, ['--check', `${directory}/${name}`], { cwd: root, stdio: 'inherit' })
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}
console.log('JavaScript syntax checks passed.')
