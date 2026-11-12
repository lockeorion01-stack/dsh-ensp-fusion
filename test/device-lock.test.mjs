import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireDeviceLock } from '../lib/device-lock.js'
import { createChangeJournal, readRecoveryPlan, listChangeJournals } from '../lib/change-journal.js'
import { prepareCliEntries } from '../lib/cli-plan.js'

test('cross-process console conflict, separate ports, release and dead-owner recovery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ensp-lock-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const moduleUrl = new URL('../lib/device-lock.js', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { acquireDeviceLock } from ${JSON.stringify(moduleUrl)}; acquireDeviceLock('127.0.0.1', 12345, process.argv[1]); process.send('locked'); setInterval(()=>{},1000)`, root],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true })
  t.after(() => child.kill())
  await once(child, 'message')
  assert.throws(() => acquireDeviceLock('localhost', 12345, root), { kind: 'device_busy' })
  const release = acquireDeviceLock('127.0.0.1', 12346, root)
  release(); release()
  const exited = once(child, 'exit'); child.kill(); await exited
  const recovered = acquireDeviceLock('::1', 12345, root)
  assert.throws(() => acquireDeviceLock('localhost', 12345, root), { kind: 'device_busy' })
  recovered()
  acquireDeviceLock('127.0.0.1', 12345, root)()
})

test('unfinished live journal refuses recovery and dead owner is discoverable as interrupted', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ensp-interrupted-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const journal = createChangeJournal(root, { port: 1234, commands: ['sysname R2'], recovery_commands: ['sysname R1'] })
  journal.event('command-started', { command: 'sysname R2' })
  assert.throws(() => readRecoveryPlan(journal.path), /still running/)
  const manifest = JSON.parse(await readFile(journal.path, 'utf8'))
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true })
  await once(child, 'exit')
  manifest.pid = child.pid
  await writeFile(journal.path, JSON.stringify(manifest))
  assert.equal(listChangeJournals(root)[0].status, 'interrupted')
  assert.throws(() => readRecoveryPlan(journal.path), /requires a valid post-change/u)
})

test('recovery plans reject redacted secrets and whole batch rejects invalid recovery commands', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ensp-journal-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const journal = createChangeJournal(root, { port: 1234, commands: ['sysname R2'], recovery_commands: ['password cipher secret-value'] })
  assert.throws(() => readRecoveryPlan(journal.path), /no usable/)
  assert.throws(() => prepareCliEntries({ devices: [
    { port: 1234, commands: ['sysname R1'] },
    { port: 1235, commands: ['sysname R2'], recovery_commands: ['quit\nsave'] },
  ] }), /single-line/)
})
