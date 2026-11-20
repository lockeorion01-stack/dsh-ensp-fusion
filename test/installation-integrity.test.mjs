import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createContentManifest, checkInstalled } from '../lib/installation-integrity.js'

test('same version with altered content or stale runtime root cannot pass installation verification', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ensp-install-')); t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['lib','mcp','skills','bin','upstream']) await mkdir(join(root, dir))
  const files = ['index.js','base.js','cordis.patch.yml','requirements-windows.lock.txt']
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dsh-ensp-fusion', version: '1.1.3', files: [...files,...['lib','mcp','skills','bin','upstream']] }))
  for (const name of [...files,'README.md']) await writeFile(join(root, name), 'original')
  const manifest = await createContentManifest(root)
  const first = await checkInstalled({ manifest, installedRoot: root })
  assert.equal(first.ok, true); assert.equal(first.runtime.verified, false)
  assert.equal((await checkInstalled({ manifest, installedRoot: root, runtimeStatus: { build: { ...first.disk_build, root: join(root, 'old') } } })).ok, false)
  const now = Date.now(), observedAt = new Date(now).toISOString()
  assert.equal((await checkInstalled({ manifest, installedRoot: root, runtimeStatus: { build: first.disk_build } })).runtime.status, 'STALE_OR_UNDATED')
  assert.equal((await checkInstalled({ manifest, installedRoot: root, now, runtimeStatus: { build: first.disk_build, observedAt } })).runtime.verified, true)
  for (const observation of [new Date(now - 300001).toISOString(), new Date(now + 10000).toISOString(), 'bad-time']) {
    const invalid = await checkInstalled({ manifest, installedRoot: root, now, runtimeStatus: { build: first.disk_build, observedAt: observation } })
    assert.equal(invalid.runtime.verified, false)
    assert.equal(invalid.runtime.status, 'STALE_OR_UNDATED')
  }
  await writeFile(join(root, 'index.js'), 'modified')
  const changed = await checkInstalled({ manifest, installedRoot: root })
  assert.equal(changed.ok, false); assert(changed.differences.some(d => d.path === 'index.js'))
  await assert.rejects(checkInstalled({ manifest: { ...manifest, files: [{ path: '../escape', size: 0, sha256: 'a'.repeat(64) }] }, installedRoot: root }), /invalid/u)
})
