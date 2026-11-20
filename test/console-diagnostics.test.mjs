import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { diagnoseNativeLogs, nativeLogSources, readLogTail } from '../lib/console-diagnostics.js'
import { createRegistry } from '../mcp/server.js'

test('native configuration load and start failures cannot produce a clean sample', () => {
  const diagnosis = diagnoseNativeLogs({ sources: [{ path: 'Log/Conserver_2026-11-19.log', text: [
    '[INFO]00:44:37 LoadDeviceThreadFunc Failed to put vrpcfg.zip.',
    '[ERROR]00:44:38 FileClient GetVBoxFileListenPort failed 0 times',
    '[INFO]00:44:47 StartDeviceThreadFunc Failed to start device.',
    '[ERROR]00:44:48 CAgent::WaitMe - Failed to wait for processes to exit.',
  ].join('\n') }] })
  assert.equal(diagnosis.ok, false)
  assert.deepEqual(diagnosis.findings.map(f => f.code), ['PROJECT_SYNC_FAILURE', 'FILE_TRANSFER_UNAVAILABLE', 'DEVICE_START_FAILURE', 'PROCESS_EXIT_FAILURE'])
  assert.equal(diagnosis.findings[0].loggedAt, '2026-11-19 00:44:37')
  assert(diagnosis.findings.every(f => f.correlation === 'shared-log' && f.device === undefined))
})

test('bounded findings retain counts and serial guidance after a later error burst', () => {
  const diagnosis = diagnoseNativeLogs({ sources: [{ path: 'VBox.log', device: 'FW1', text:
    'Char#0: Write failed with rc=VERR_NO_DATA\n' + 'socket reset: 10054\n'.repeat(100) }] })
  assert.equal(diagnosis.findings.length, 80)
  assert.equal(diagnosis.totalFindings, 101)
  assert.equal(diagnosis.omittedFindings, 21)
  assert.equal(diagnosis.findingCounts.SERIAL_PIPE_FAILURE, 1)
  assert(diagnosis.next.some(s => /serial endpoint/u.test(s)))
  const success = diagnoseNativeLogs({ sources: [{ path: 'VBoxServer.log', text: '[ERROR]00:00:00 CDevTunnel::TryConnect - Succeed in connecting.: 0.' }] })
  assert.equal(success.ok, true, 'the native severity label alone does not establish failure')
})

test('missing shared log category keeps partial discovery inconclusive', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ensp-log-coverage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'Log'))
  await writeFile(join(root, 'Log', 'VBoxServer_2026-11-19.log'), 'no matching errors\n')
  const unavailableSources = []
  const sources = await nativeLogSources(root, [], { onUnavailable: row => unavailableSources.push(row) })
  assert.equal(sources.length, 1)
  assert(unavailableSources.some(row => row.category === 'Conserver'))
  const diagnosis = diagnoseNativeLogs({ sources, unavailableSources })
  assert.equal(diagnosis.ok, false)
  assert.equal(diagnosis.status, 'INSUFFICIENT_LOG_EVIDENCE')
  assert.equal(diagnoseNativeLogs({ sources: [] }).status, 'INSUFFICIENT_LOG_EVIDENCE')

  await writeFile(join(root, 'campus.topo'), '<topo><dev id="sw" name="SW1" model="S5700" com_port="8101"/></topo>')
  const registry = createRegistry({ workspace: root })
  const tool = registry.tools.find(t => t.name === 'ensp_console_diagnose')
  const result = await tool.handler({ topology_path: 'campus.topo', device: 'SW1', native_log_root: root }, registry.exec)
  assert.equal(result.ok, false)
  assert.equal(result.status, 'INSUFFICIENT_LOG_EVIDENCE')
  assert.match(result.coverage, /partial/u)
  assert.equal(result.readiness.state, 'not_probed')
  assert.equal(result.sources[0].encoding, 'utf-8')
})

test('empty topology-matched USG directory is reported as missing VM evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ensp-vm-log-coverage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const id = '12345678-1234-1234-1234-123456789012'
  await mkdir(join(root, 'Log'))
  for (const category of ['Conserver', 'VBoxServer']) await writeFile(join(root, 'Log', `${category}_2026-11-19.log`), 'no matching errors\n')
  await mkdir(join(root, 'VBoxServer', 'devices', id), { recursive: true })
  const unavailableSources = []
  const sources = await nativeLogSources(root, [{ id, name: 'FW1', model: 'USG6000V' }], { onUnavailable: row => unavailableSources.push(row) })
  assert.equal(sources.length, 2)
  assert.deepEqual(unavailableSources.map(row => [row.device, row.code]), [['FW1', 'NO_MATCHING_VM_LOGS']])
  assert.equal(diagnoseNativeLogs({ sources, unavailableSources }).ok, false)
})

test('native GB18030 evidence is readable and bounded tails omit incomplete lines', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ensp-log-encoding-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'native.log')
  // GB18030 bytes for 中文, matching the legacy native log encoding.
  await writeFile(file, Buffer.concat([Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from(' Failed to put vrpcfg.zip.\n')]))
  const result = await readLogTail(file)
  assert.match(result.text, /^中文 Failed to put/u)
  assert.equal(result.encoding, 'gb18030')
  assert.equal(result.truncated, false)
  await writeFile(file, 'first line\nsecond line\n')
  const tail = await readLogTail(file, 16)
  assert.equal(tail.truncated, true)
  assert.equal(tail.text, 'second line\n')
})
