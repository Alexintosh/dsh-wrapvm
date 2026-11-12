/** Pack the built bundle for the DSH release named by its engine requirement. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundle = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8'))
const target = source.engines.dsh
if (source.version !== '0.2.2' || target !== '0.2.2-rc.2') throw new Error('Unexpected bundle or DSH release version')
const staging = mkdtempSync(join(bundle, '.release-pack-'))
const run = (command, args, cwd) => execFileSync(command, args, {
  cwd, stdio: 'inherit', env: { ...process.env, npm_config_ignore_scripts: 'true' },
})
try {
  run(process.execPath, [resolve(bundle, '../../../node_modules/pnpm/bin/pnpm.cjs'), 'pack', '--pack-destination', staging], bundle)
  const candidates = readdirSync(staging).filter(name => name.endsWith('.tgz'))
  if (candidates.length !== 1) throw new Error('Expected exactly one staged archive')
  run('tar', ['-xzf', join(staging, candidates[0]), '-C', staging], bundle)
  const dir = join(staging, 'package')
  const manifestPath = join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.version !== source.version || manifest.engines.dsh !== target) throw new Error('Staged version mismatch')
  for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (!name.startsWith('@deepseek-ai/dsh-')) continue
      if (version !== '0.2.2-rc.1' && version !== target) throw new Error(`Unexpected ${name} version: ${version}`)
      manifest[section][name] = target
    }
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  run(join(dirname(process.execPath), 'npm'), ['pack', '--ignore-scripts', '--workspaces=false', '--pack-destination', bundle], dir)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
