import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
export function captureBuild(directory = root) {
  const files = ['package.json', 'index.js', 'base.js', 'cordis.patch.yml', 'requirements-windows.lock.txt']
  function walk(dir) {
    for (const entry of readdirSync(join(directory, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory() && entry.name !== '__pycache__') walk(path)
      else if (entry.isFile() && /\.(?:js|mjs|py|md|yml|json)$/u.test(path)) files.push(path)
    }
  }
  for (const dir of ['lib', 'mcp', 'skills', 'bin', 'upstream']) walk(dir)
  const hash = createHash('sha256')
  for (const path of files.sort()) hash.update(path + '\0').update(readFileSync(join(directory, path))).update('\0')
  return Object.freeze({ name: 'dsh-ensp-fusion', version: JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version,
    fingerprint: hash.digest('hex'), algorithm: 'sha256', root: directory, loadedAt: new Date().toISOString() })
}
// Capture at module load, so editing an installed file cannot make an already
// running plugin claim it has reloaded the new build.
const loaded = captureBuild()
export function buildInfo() { return { ...loaded } }
