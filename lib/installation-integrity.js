import { readdir, readFile, lstat, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative, isAbsolute, resolve } from 'node:path'
import { captureBuild } from './build-info.js'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (root, path) => { const r = relative(root, path); return r !== '..' && !r.startsWith('../') && !r.startsWith('..\\') && !isAbsolute(r) }

export async function createContentManifest(root) {
  root = await realpath(root)
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')), files = []
  async function walk(path) {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw Error('manifest refuses symlinks: ' + path)
    if (info.isDirectory()) {
      for (const name of await readdir(path)) if (name !== '__pycache__') await walk(join(path, name))
    } else if (info.isFile()) {
      if (files.length >= 4096 || info.size > 64 * 1024 * 1024) throw Error('manifest file limit')
      const bytes = await readFile(path)
      files.push({ path: relative(root, path).replace(/\\/gu, '/'), size: bytes.length, sha256: digest(bytes) })
    }
  }
  const paths = new Set(['package.json', 'README.md', ...(pkg.files ?? [])])
  for (const path of paths) {
    if (typeof path !== 'string' || !inside(root, resolve(root, path))) throw Error('invalid package files path')
    await walk(resolve(root, path))
  }
  return { schema_version: 1, name: pkg.name, version: pkg.version, fingerprint_algorithm: 'source-sha256-v1',
    fingerprint: captureBuild(root).fingerprint, files: files.sort((a,b) => a.path.localeCompare(b.path)) }
}

export async function checkInstalled({ manifest, installedRoot, runtimeStatus, now = Date.now(), maxRuntimeAgeMs = 300000 }) {
  if (!Number.isFinite(now) || !Number.isSafeInteger(maxRuntimeAgeMs) || maxRuntimeAgeMs < 1) throw Error('invalid runtime evidence age limit')
  if (manifest?.schema_version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 4096 || manifest.fingerprint_algorithm !== 'source-sha256-v1'
      || !/^[a-f\d]{64}$/u.test(manifest.fingerprint ?? '')) throw Error('invalid content manifest')
  const root = await realpath(installedRoot), differences = [], paths = new Set()
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !file.path || /\\|\0/u.test(file.path) || isAbsolute(file.path)
        || !inside(root, resolve(root, file.path)) || paths.has(file.path) || !/^[a-f\d]{64}$/u.test(file.sha256 ?? '') || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 64 * 1024 * 1024) throw Error('invalid manifest file entry')
    paths.add(file.path)
    const path = resolve(root, file.path)
    try {
      const actual = await realpath(path)
      if (!inside(root, actual) || !(await lstat(path)).isFile()) throw Error('installed file is not a contained regular file')
      if ((await lstat(path)).size !== file.size) differences.push({ path: file.path, reason: 'size' })
      else if (digest(await readFile(path)) !== file.sha256) differences.push({ path: file.path, reason: 'sha256' })
    } catch (error) { differences.push({ path: file.path, reason: error.code ?? 'INVALID_FILE' }) }
  }
  let diskBuild
  try {
    const actual = await createContentManifest(root)
    for (const file of actual.files) if (!paths.has(file.path)) differences.push({ path: file.path, reason: 'unexpected-file' })
  } catch (error) { differences.push({ path: '<package-files>', reason: error.code ?? 'INVALID_PACKAGE_FILES' }) }
  try { diskBuild = captureBuild(root); if (diskBuild.fingerprint !== manifest.fingerprint) differences.push({ path: '<build>', reason: 'fingerprint' }) }
  catch (error) { differences.push({ path: '<build>', reason: error.code ?? 'UNREADABLE_BUILD' }) }
  let runtime = { status: 'UNVERIFIED', verified: false }
  if (runtimeStatus !== undefined) {
    const value = runtimeStatus?.value ?? runtimeStatus
    const build = value?.build
    const observedAt = value?.observedAt
    const observed = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN
    const loaded = typeof build?.loadedAt === 'string' ? Date.parse(build.loadedAt) : NaN
    const canonical = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
    const same = !!build && typeof build.root === 'string' && canonical(build.root) === canonical(root)
      && build.fingerprint === manifest.fingerprint && Number.isFinite(loaded)
    const fresh = Number.isFinite(observed) && observed >= now - maxRuntimeAgeMs && observed <= now + 5000
      && Number.isFinite(loaded) && loaded <= observed
    runtime = { status: !same ? 'DIFFERENT_OR_INVALID' : !fresh ? 'STALE_OR_UNDATED' : 'MATCH',
      verified: same && fresh, content_matches: same, fresh, observed_at: observedAt ?? null,
      max_age_ms: maxRuntimeAgeMs, build: build ?? null }
  }
  const ok = !differences.length && (runtimeStatus === undefined || runtime.verified)
  return { ok, installed_root: root, expected_version: manifest.version, disk_build: diskBuild ?? null, differences, runtime,
    status: !ok ? 'DIFFERENT' : runtime.verified ? 'INSTALL_AND_RUNTIME_MATCH' : 'INSTALL_VERIFIED_RUNTIME_UNVERIFIED',
    limits: ['Runtime comparison trusts the supplied status evidence and observation timestamp; it does not contact or authenticate a live host.',
      'Evidence must be observed within five minutes by default; loadedAt alone does not establish freshness.', 'Module validation and Electron launch require separate host checks.'] }
}
