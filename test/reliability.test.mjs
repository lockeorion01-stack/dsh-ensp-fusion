import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as zlib from 'node:zlib'
import { inspectProject, checkpointProject, compareProject, flashConfiguration } from '../lib/project-checkpoint.js'
import { exportSanitizedLog } from '../lib/log-export.js'
import { hydrateInputs } from '../lib/credential-input.js'
import { normalizeGuiSteps } from '../lib/gui-contract.js'
import { waitDevicesReady } from '../lib/device-ready.js'
import { diagnoseNativeLogs } from '../lib/console-diagnostics.js'
import { createRegistry } from '../mcp/server.js'
import { Bridge } from '../lib/bridge-client.js'
import { VrpSession } from '../lib/cli.js'
import { installOutcomeAdapter } from '../lib/tool-outcome.js'

const zip = Buffer.from('UEsDBBQAAAAIAKC6bV1hK3CUIAAAAB4AAAAKAAAAdnJwY2ZnLmNmZ1PmKq4szkvMTVUIDjfkKstJzFNISixJzlAwNOBS5gIAUEsBAhQAFAAAAAgAoLptXWErcJQgAAAAHgAAAAoAAAAAAAAAAAAAAIABAAAAAHZycGNmZy5jZmdQSwUGAAAAAAEAAQA4AAAASAAAAAAA', 'base64')
async function workspace(t) { const dir = await mkdtemp(join(tmpdir(), 'ensp-reliability-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir }
function embedded(...archives) {
  const blocks = [Buffer.concat([Buffer.from('eNSP'), Buffer.alloc(12)])]
  for (const archive of archives) {
    const header = Buffer.alloc(12), length = Math.ceil(archive.length / 16) * 16
    header.writeUInt32LE(length, 8)
    blocks.push(header, archive, Buffer.alloc(length - archive.length, 255))
  }
  return Buffer.concat(blocks)
}
function storedZip(entries) {
  const locals = [], directory = []
  let offset = 0
  for (const [filename, text] of entries) {
    const name = Buffer.from(filename), data = Buffer.from(text)
    let crc = 0xffffffff
    for (const byte of data) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    crc = (crc ^ 0xffffffff) >>> 0
    const local = Buffer.alloc(30), central = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, name, data); directory.push(central, name)
    offset += local.length + name.length + data.length
  }
  const dir = Buffer.concat(directory), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

test('flash content validates ZIP CRC, expansion limit, eNSP wrapper and latest payload', () => {
  assert.match(flashConfiguration(zip).toString(), /sysname SW1/u)
  assert.match(flashConfiguration(embedded(zip, zip)).toString(), /vlan batch 10/u)
  const bad = Buffer.from(zip); bad[41] ^= 8
  assert.throws(() => flashConfiguration(bad))
  assert.throws(() => flashConfiguration(embedded(zip, bad)), /CRC|length|data|code/iu, 'never silently use a preceding valid history payload')
  assert.throws(() => flashConfiguration(embedded(zip).subarray(0, -20)))
  const bomb = Buffer.from(zip); bomb.writeUInt32LE(5 * 1024 * 1024, 72 + 24)
  assert.throws(() => flashConfiguration(bomb), /unsupported/iu)
  const duplicate = Buffer.from(zip); duplicate.writeUInt16LE(2, duplicate.length - 12)
  assert.throws(() => flashConfiguration(duplicate), /directory/iu)
})

test('eNSP flash selects the newest configuration before complete later sysinfo payloads', () => {
  const latest = storedZip([['vrpcfg.cfg', '#\nsysname SW1\nvlan batch 31\n#\n']])
  const sysinfo = storedZip([['sysinfo-2026-11-14.log', 'diagnostic log'], ['empty.log', '']])
  assert.match(flashConfiguration(embedded(zip, latest, sysinfo)).toString(), /vlan batch 31/u)
  assert.throws(() => flashConfiguration(embedded(sysinfo)), /configuration ZIP/u)
  assert.throws(() => flashConfiguration(sysinfo), /exactly one vrpcfg/u, 'standalone ZIPs still require exactly one configuration')
  const duplicate = storedZip([['vrpcfg.cfg', '#\nsysname SW1\n'], ['folder/vrpcfg.cfg', '#\nsysname Other\n']])
  assert.throws(() => flashConfiguration(embedded(zip, duplicate, sysinfo)), /exactly one vrpcfg/u)
})

test('eNSP flash never falls back through corrupt or incomplete newer records', () => {
  const latest = storedZip([['vrpcfg.cfg', '#\nsysname SW1\nvlan batch 31\n#\n']])
  const sysinfo = storedZip([['sysinfo.log', 'diagnostic log']])
  const badConfig = Buffer.from(latest); badConfig[40] ^= 1
  assert.throws(() => flashConfiguration(embedded(zip, badConfig, sysinfo)), /CRC|length/u)
  const badLog = Buffer.from(sysinfo); badLog[41] ^= 1
  assert.throws(() => flashConfiguration(embedded(zip, badLog)), /CRC|length/u, 'a corrupt trailing log is not certified as complete')
  assert.throws(() => flashConfiguration(embedded(zip, latest).subarray(0, -24)), /bounded|truncated/u)
  assert.throws(() => flashConfiguration(embedded(zip, sysinfo).subarray(0, -24)), /bounded|truncated/u)
  const wrongBound = embedded(zip, latest, sysinfo)
  const logStart = wrongBound.lastIndexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  wrongBound.writeUInt32LE(16, logStart - 4)
  assert.throws(() => flashConfiguration(wrongBound), /truncated/u)
})

test('checkpoint verifies content, refuses overwrite and reports missing or changed assets', async t => {
  const root = await workspace(t), project = join(root, '工程'), path = join(project, '园区.topo')
  await mkdir(join(project, 'sw'), { recursive: true }); await mkdir(join(project, 'fw'))
  await writeFile(path, '<topo><dev id="sw" name="SW1" model="S5700" com_port="8101"/><dev id="fw" name="FW1" model="USG6000V" com_port="8301"/></topo>')
  await writeFile(join(project, 'sw', 'flash.efz'), embedded(zip))
  await writeFile(join(project, 'fw', 'vrpcfg.cfg'), '#\nsysname FW1\n#\n')
  const expected = { SW1: ['vlan batch 10'] }, current = await inspectProject(path, { expected })
  assert.equal(current.ok, true); assert.equal(current.reloadVerified, false)
  assert.equal((await inspectProject(path, { expected: { SW1: ['vlan batch 99'] } })).ok, false)
  const backup = await checkpointProject(path, join(root, 'backup'), { expected })
  assert.equal(backup.ok, true); assert.equal(backup.stable, true)
  assert.equal(compareProject(backup, current).ok, true)
  await assert.rejects(checkpointProject(path, join(root, 'backup')), { code: 'EEXIST' })
  await assert.rejects(checkpointProject(path, join(project, 'nested')), /outside/u)
  await writeFile(join(project, 'fw', 'vrpcfg.cfg'), '')
  assert.equal((await inspectProject(path)).devices[1].state, 'empty')
  assert.equal(compareProject(backup, await inspectProject(path)).ok, false)
  await rm(join(project, 'fw', 'vrpcfg.cfg'))
  assert.equal((await inspectProject(path)).devices[1].state, 'missing')
  const incomplete = await checkpointProject(path, join(root, 'evidence'))
  assert.equal(incomplete.ok, false); assert.equal(incomplete.stable, true, 'a stable but incomplete disk copy is not a passing checkpoint')
  const outside = join(root, 'outside'); await mkdir(outside)
  await symlink(outside, join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(checkpointProject(path, join(project, 'escape', 'backup')), /outside/u)
})

test('AC version-header ZIP configuration is inspected without a sysname and AP absence remains unverified', async t => {
  const root = await workspace(t), project = join(root, 'project'), path = join(project, 'wireless.topo')
  await mkdir(join(project, 'ac'), { recursive: true }); await mkdir(join(project, 'ap'))
  await writeFile(path, '<topo><dev id="ac" name="AC1" model="AC6005" com_port="2001"/><dev id="ap" name="AP1" model="AP6050" com_port="2002"/></topo>')
  const text = '\r\n[V200R007C10SPC300]\r\n#\r\nvlan batch 10\r\n#\r\nreturn\r\n'
  await writeFile(join(project, 'ac', 'vrpcfg.zip'), storedZip([['vrpcfg.cfg', text]]))
  const report = await inspectProject(path, { expected: { AC1: ['vlan batch 10'] } })
  assert.equal(report.ok, false)
  assert.equal(report.devices[0].state, 'content_verified')
  assert.equal(report.devices[0].configurationFormat, 'zip-vrpcfg')
  assert.equal(report.devices[1].state, 'persistence_unverified')
  assert.equal(report.devices[1].ok, false)
  assert.equal(report.reloadVerified, false)
  assert(!JSON.stringify(report).includes('vlan batch 10'), 'never return configuration content')
  assert.equal((await inspectProject(path, { expected: { AC1: ['vlan batch 20'] } })).devices[0].state, 'expected_content_missing')
  const copy = await checkpointProject(path, join(root, 'backup'))
  assert.equal(copy.ok, false, 'an unknown AP is never ignored for aggregate success')
  assert.equal(copy.assetCopyVerified, true)
  assert.deepEqual(await readFile(join(root, 'backup', 'ac', 'vrpcfg.zip')), await readFile(join(project, 'ac', 'vrpcfg.zip')))
  assert.equal(copy.assetManifest.directories.includes('ap'), true)
  await writeFile(join(project, 'ap', 'vrpcfg.cfg'), '#\nsysname AP1\n#\n')
  assert.equal((await inspectProject(path)).ok, true)
})

test('wireless corrupt, empty, ambiguous and nonconfiguration archives never pass', async t => {
  const root = await workspace(t), project = join(root, 'project'), path = join(project, 'wireless.topo')
  await mkdir(join(project, 'ac'), { recursive: true })
  await writeFile(path, '<topo><dev id="ac" name="AC1" model="AC6005" com_port="2001"/></topo>')
  const file = join(project, 'ac', 'vrpcfg.zip')
  for (const text of ['[V200R007C10SPC300]', '[V200R007C10SPC300]\n#\n', '{"state":"ok"}', 'unrelated log']) {
    await writeFile(file, storedZip([['vrpcfg.cfg', text]]))
    assert.equal((await inspectProject(path)).devices[0].state, 'unrecognized_configuration')
  }
  await writeFile(file, '')
  assert.equal((await inspectProject(path)).devices[0].state, 'empty')
  const good = storedZip([['vrpcfg.cfg', '[V200R007C10SPC300]\n#\nvlan batch 10\n#\nreturn\n']])
  const bad = Buffer.from(good); bad[40] ^= 1
  for (const bytes of [bad, good.subarray(0, -5), storedZip([['log.txt', 'irrelevant']]), storedZip([['vrpcfg.cfg', 'sysname AC1'], ['dir/vrpcfg.cfg', 'sysname AC2']])]) {
    await writeFile(file, bytes)
    assert.equal((await inspectProject(path)).devices[0].state, 'invalid')
  }
  await writeFile(file, good)
  await writeFile(join(project, 'ac', 'flash.efz'), embedded(zip))
  const report = await inspectProject(path)
  assert.equal(report.devices[0].state, 'ambiguous')
  assert.equal(report.ok, false)
  const copy = await checkpointProject(path, join(root, 'backup'))
  assert.equal(copy.ok, false); assert.equal(copy.assetCopyVerified, true)
  assert(copy.assetManifest.files.some(row => row.path === 'ac/vrpcfg.zip'))
  assert(copy.assetManifest.files.some(row => row.path === 'ac/flash.efz'))
})

test('checkpoint includes non-console XML and ZIP assets and compare detects their changes', async t => {
  const root = await workspace(t), project = join(root, 'project'), path = join(project, 'campus.topo')
  for (const id of ['sw', 'server', 'empty']) await mkdir(join(project, id), { recursive: true })
  await writeFile(path, '<topo><dev id="sw" name="SW1" model="S5700" com_port="8101"/><dev id="server" name="Server1" model="Server" com_port="0"/><dev id="empty" name="AP1" model="AP6050" com_port="0"/></topo>')
  await writeFile(join(project, 'sw', 'flash.efz'), embedded(zip))
  await writeFile(join(project, 'server', 'PC.xml'), '<PC ip="10.0.0.1"/>')
  await writeFile(join(project, 'server', 'vrpcfg.zip'), zip)
  const checkpoint = await checkpointProject(path, join(root, 'backup'))
  assert.equal(checkpoint.ok, true); assert.equal(checkpoint.assetCopyVerified, true)
  assert.equal(checkpoint.assetManifest.files.length, 4)
  assert.deepEqual(checkpoint.assetManifest.directories, ['empty', 'server', 'sw'])
  assert.equal(compareProject(checkpoint, await inspectProject(path)).ok, true)
  await writeFile(join(project, 'server', 'PC.xml'), '<PC ip="10.0.0.2"/>')
  assert(compareProject(checkpoint, await inspectProject(path)).mismatches.includes('configuration_asset_manifest_changed_or_unverified'))
  await writeFile(join(project, 'server', 'PC.xml'), '<PC ip="10.0.0.1"/>')
  await writeFile(join(project, 'server', 'vrpcfg.zip'), 'changed non-console asset')
  assert.equal(compareProject(checkpoint, await inspectProject(path)).ok, false)
  const outside = join(root, 'outside'); await mkdir(outside)
  await symlink(outside, join(project, 'server', 'unsafe.cfg'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await inspectProject(path)).ok, false)
  await assert.rejects(checkpointProject(path, join(root, 'unsafe-backup')), /symlink|escapes/u)
})

test('exact operation export preserves structured errors, skips and metadata while redacting all session secrets', async t => {
  const root = await workspace(t), source = join(root, 'session.jsonl'), destination = join(root, 'evidence.json')
  const operation = '1234-abcd', call = 'call-1:ptc:3'
  const failure = { ok: false, failure: { phase: 'connect', kind: 'transport', message: 'ECONNREFUSED' }, skipped: ['display version'],
    execution: { operation_id: operation, call_id: call, status: 'failed', tool: 'ensp_cli' }, notes: ['Synthetic-Secret!'] }
  const rows = [
    { type: 'tool/ptc-dispatch', data: { subCallId: call, name: 'ensp_cli', isError: true, error: { code: 'ENSP_OPERATION_FAILED' }, content: [{ type: 'text', text: JSON.stringify(failure) }] } },
    { data: { arguments: JSON.stringify({ password: 'Synthetic-Secret!' }) } },
    { type: 'tool/ptc-dispatch', data: { subCallId: call + '0', content: [{ type: 'text', text: JSON.stringify({ ...failure, execution: { operation_id: 'different', call_id: call + '0' } }) }] } },
  ]
  const original = rows.map(row => JSON.stringify(row)).join('\n') + '\n'
  await writeFile(source, original)
  const exported = await exportSanitizedLog(source, destination, { operationId: operation })
  const text = await readFile(destination, 'utf8'), data = JSON.parse(text)
  assert.equal(exported.structuredResults, 1); assert.equal(data.matchedRecords, 1)
  assert.equal(data.results[0].result.failure.phase, 'connect')
  assert.equal(data.results[0].result.failure.message, 'ECONNREFUSED')
  assert.deepEqual(data.results[0].result.skipped, ['display version'])
  assert.equal(data.results[0].result.execution.operation_id, operation)
  assert(!text.includes('Synthetic-Secret!'))
  assert.equal(await readFile(source, 'utf8'), original)
  const byCall = join(root, 'by-call.json')
  assert.equal((await exportSanitizedLog(source, byCall, { callId: call })).structuredResults, 1)
  assert.equal(JSON.parse(await readFile(byCall, 'utf8')).matchedRecords, 1, 'selector is exact, not a prefix')
  await assert.rejects(exportSanitizedLog(source, destination, { operationId: operation }), { code: 'EEXIST' })
  await assert.rejects(exportSanitizedLog(source, join(root, 'missing.json'), { operationId: 'missing' }), /no exact/u)
  await assert.rejects(readFile(join(root, 'missing.json')), { code: 'ENOENT' })
  await assert.rejects(exportSanitizedLog(source, join(root, 'invalid.json'), { callId: call, operationId: operation }), /mutually exclusive/u)
})

test('exact export retains dispatch-only errors and metadata without fabricating result bodies', async t => {
  const root = await workspace(t), source = join(root, 'session.jsonl')
  await writeFile(source, [
    { type: 'tool/ptc-dispatch', data: { subCallId: 'throw-1', name: 'ensp_cli', isError: true, error: { code: 'PATH_REJECTED' }, content: [{ type: 'text', text: 'path rejected' }] } },
    { type: 'finished', operation_id: 'meta-1', call_id: 'meta-call', status: 'failed' },
  ].map(x => JSON.stringify(x)).join('\n'))
  const thrown = join(root, 'thrown.json'), metadata = join(root, 'metadata.json')
  await exportSanitizedLog(source, thrown, { callId: 'throw-1' })
  const data = JSON.parse(await readFile(thrown, 'utf8'))
  assert.equal(data.structuredResults, 0); assert.equal(data.results[0].result, null)
  assert.equal(data.results[0].error.code, 'PATH_REJECTED')
  await exportSanitizedLog(source, metadata, { operationId: 'meta-1' })
  const meta = JSON.parse(await readFile(metadata, 'utf8'))
  assert.equal(meta.evidenceLevel, 'metadata-or-dispatch-only'); assert.deepEqual(meta.results, [])
})

test('USG custom cfg assets are checked and copied without claiming the startup pointer', async t => {
  const root = await workspace(t), project = join(root, 'project'), path = join(project, 'campus.topo')
  await mkdir(join(project, 'fw'), { recursive: true })
  await writeFile(path, '<topo><dev id="fw" name="FW1" model="USG6000V" com_port="8301"/></topo>')
  const cfg = '#\nsysname FW1\ninterface GigabitEthernet1/0/2.31\n vlan-type dot1q 31\n#\n'
  await writeFile(join(project, 'fw', 'fwcw.cfg'), cfg)
  const options = { expected: { FW1: ['vlan-type dot1q 31'] } }
  const current = await inspectProject(path, options)
  assert.equal(current.ok, true); assert.equal(current.reloadVerified, false)
  assert.equal(current.devices[0].path, join(project, 'fw', 'fwcw.cfg'))
  assert.match(current.devices[0].configurationSelection, /active startup pointer is not verified/u)
  assert.equal((await inspectProject(path, { expected: { FW1: ['vlan-type dot1q 99'] } })).ok, false)
  const checkpoint = await checkpointProject(path, join(root, 'custom-backup'), options)
  assert.equal(checkpoint.ok, true); assert.equal(checkpoint.stable, true)
  assert.equal(await readFile(join(root, 'custom-backup', 'fw', 'fwcw.cfg'), 'utf8'), cfg)
  assert.equal(compareProject(checkpoint, current).ok, true)
  await writeFile(join(project, 'fw', 'fwcw.cfg'), '')
  assert.equal((await inspectProject(path)).devices[0].state, 'empty')
})

test('USG multiple cfg assets stay ambiguous and checkpoint preserves every candidate', async t => {
  const root = await workspace(t), project = join(root, 'project'), path = join(project, 'campus.topo')
  await mkdir(join(project, 'fw'), { recursive: true })
  await writeFile(path, '<topo><dev id="fw" name="FW1" model="USG6000V" com_port="8301"/></topo>')
  const custom = '#\nsysname FW1\n#\n'
  await writeFile(join(project, 'fw', 'fwcw.cfg'), custom)
  await writeFile(join(project, 'fw', 'vrpcfg.cfg'), '')
  const current = await inspectProject(path)
  assert.equal(current.ok, false); assert.equal(current.devices[0].state, 'ambiguous')
  assert.equal(current.devices[0].configurationSha256, undefined)
  assert.deepEqual(current.devices[0].configurationAssets.map(a => a.name), ['fwcw.cfg', 'vrpcfg.cfg'])
  const checkpoint = await checkpointProject(path, join(root, 'ambiguous-backup'))
  assert.equal(checkpoint.ok, false); assert.equal(checkpoint.stable, true)
  assert.equal(await readFile(join(root, 'ambiguous-backup', 'fw', 'fwcw.cfg'), 'utf8'), custom)
  assert.equal((await readFile(join(root, 'ambiguous-backup', 'fw', 'vrpcfg.cfg'))).length, 0)
  assert.equal(compareProject(checkpoint, current).ok, false)
  const outside = join(root, 'outside'); await mkdir(outside)
  await symlink(outside, join(project, 'fw', 'escape.cfg'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await inspectProject(path)).devices[0].state, 'invalid')
  await assert.rejects(checkpointProject(path, join(root, 'unsafe-backup')), /symlink|escapes/u)
})

test('session prose, short credential echoes and exact dispatch selectors', async t => {
  const root = await workspace(t), source = join(root, 'session.jsonl')
  const rows = [
    { description: 'A password is optional. Set password to a value. Record password changes.' },
    { type: 'tool/ptc-dispatch', data: { subCallId: 'call-is-1', name: 'ensp_cli', content: ['echo ~! and p@ ss'] } },
    { arguments: { commands: ['password ~!', 'local-user admin password cipher "p@ ss"'] } },
  ]
  await writeFile(source, rows.map(row => JSON.stringify(row)).join('\n'))
  const destination = join(root, 'selected.json')
  await exportSanitizedLog(source, destination, { callId: 'call-is-1' })
  const artifact = JSON.parse(await readFile(destination, 'utf8'))
  assert.equal(artifact.records[0].record.type, rows[1].type)
  assert.equal(artifact.results[0].call_id, 'call-is-1')
  assert.deepEqual(artifact.results[0].content, ['echo [REDACTED] and [REDACTED]'])
  // A known credential may also occur inside the requested identifier.
  rows.push({ password: 'is' })
  await writeFile(source, rows.map(row => JSON.stringify(row)).join('\n'))
  const second = join(root, 'masked-id.json')
  await exportSanitizedLog(source, second, { callId: 'call-is-1' })
  const masked = JSON.parse(await readFile(second, 'utf8'))
  assert.equal(masked.records[0].record.type, rows[1].type)
  assert.equal(masked.selector.call_id, 'call-[REDACTED]-1')
})

test('credential references hydrate frozen input without recording secrets and reject mixed inputs', async t => {
  const root = await workspace(t), credentials = join(root, 'credentials.json'), commands = join(root, 'commands.json')
  await writeFile(credentials, JSON.stringify({ lab: { username: 'operator', password: 'Synthetic-Credential!' } }))
  await writeFile(commands, JSON.stringify([{ cmd: 'rsa local-key-pair create', replies: [{ expect: 'Input:', reply: '2048' }] }]))
  const args = Object.freeze({ credential_file: credentials, devices: Object.freeze([Object.freeze({ port: 1234, credential_ref: 'lab', commands_file: commands })]) })
  const out = await hydrateInputs(args, async p => p)
  assert.equal(out.devices[0].password, 'Synthetic-Credential!'); assert.equal(out.devices[0].commands.length, 1)
  assert.equal(args.devices[0].password, undefined); assert.equal(out.credential_file, undefined)
  await assert.rejects(hydrateInputs({ credential_file: credentials, credential_ref: 'lab', password: 'inline' }, async p => p), /inline/u)
  await assert.rejects(hydrateInputs({ credential_ref: 'missing' }, async p => p), /not found/u)
  await assert.rejects(hydrateInputs({ commands_file: commands, commands: [] }, async p => p), /mutually/u)
})

test('sanitized export removes nested credentials, earlier echoes and command secrets across zstd frames', async t => {
  if (!zlib.zstdCompressSync) return t.skip('Zstandard requires Node 22.15+; other plugin tools still support Node 20')
  const root = await workspace(t), source = join(root, 'input.zst'), dest = join(root, 'sanitized.jsonl')
  const rows = [
    { text: 'earlier Synthetic-Credential! Synthetic-Reply! Synthetic-Key!', tool: 'ordinary' },
    { arguments: JSON.stringify({ devices: [{ password: 'Synthetic-Credential!', commands: [{ cmd: 'rsa', replies: [{ expect: 'Input:', reply: 'Synthetic-Reply!' }] }] }] }) },
    { output: JSON.stringify({ content: 'local-user operator password irreversible-cipher Synthetic-Key!' }) },
  ]
  const chunks = rows.map(row => Buffer.from(JSON.stringify(row) + '\n'))
  const bytes = Buffer.concat(chunks.map(chunk => zlib.zstdCompressSync(chunk)))
  await writeFile(source, bytes)
  assert.equal((await exportSanitizedLog(source, dest)).records, 3)
  const text = await readFile(dest, 'utf8')
  for (const key of ['Synthetic-Credential!', 'Synthetic-Reply!', 'Synthetic-Key!']) assert(!text.includes(key))
  assert(text.includes('ordinary')); assert.deepEqual(await readFile(source), bytes)
  await assert.rejects(exportSanitizedLog(source, dest), { code: 'EEXIST' })
  const malformed = join(root, 'bad.jsonl'); await writeFile(malformed, '{"password":"broken')
  await assert.rejects(exportSanitizedLog(malformed, join(root, 'bad-export.jsonl')), /valid JSONL/u)
  await assert.rejects(readFile(join(root, 'bad-export.jsonl')), { code: 'ENOENT' })
})

test('GUI rejects ambiguous units, invalid shortcuts and unsupported ops before dispatch', () => {
  assert.deepEqual(normalizeGuiSteps(Object.freeze([Object.freeze({ op: 'sleep', ms: 1200 })])), [{ op: 'sleep', t: 1.2 }])
  for (const steps of [[{ op: 'sleep', t: 12000 }], [{ op: 'key', key: '^o' }], [{ op: 'sleep', t: 1, ms: 1000 }], [{ op: 'sleep', ms: 5000 }], [{ op: 'missing' }]]) {
    assert.throws(() => normalizeGuiSteps(steps, 4000))
  }
})

test('credential files reach CLI and plan-relative lab execution without leaking into reports', async t => {
  const root = await workspace(t)
  await mkdir(join(root, 'plans'))
  await writeFile(join(root, 'campus.topo'), '<topo><dev id="sw" name="SW1" model="S5700" com_port="8101"/></topo>')
  await writeFile(join(root, 'plans', 'credentials.json'), JSON.stringify({ known: { password: 'Synthetic-Local-Only!' } }))
  await writeFile(join(root, 'plans', 'commands.json'), JSON.stringify([{ cmd: 'display version', expect: 'READY', layer: 'configuration' }]))
  await writeFile(join(root, 'plans', 'plan.json'), JSON.stringify({ topology_path: 'campus.topo', topology_base: 'workspace', credential_file: 'credentials.json', devices: [{ device: 'SW1', credential_ref: 'known', commands_file: 'commands.json' }] }))
  let connected = 0
  t.mock.method(VrpSession.prototype, 'open', async function () {
    connected++; assert.equal(this.password, 'Synthetic-Local-Only!'); this.prompt = '<SW1>'; return { prompt: this.prompt }
  })
  t.mock.method(VrpSession.prototype, 'run', async function (commands) {
    return { ok: true, prompt: this.prompt, results: commands.map(command => ({ command, output: this.password + ' READY', ok: true })) }
  })
  const registry = createRegistry({ workspace: root }), invoke = (name, args) => registry.tools.find(t => t.name === name).handler(args, registry.exec)
  const preview = await invoke('ensp_cli', { port: 8101, credential_file: 'plans/credentials.json', credential_ref: 'known', commands_file: 'plans/commands.json', dry_run: true })
  assert.equal(preview.ok, true); assert.equal(connected, 0)
  const result = await invoke('ensp_labtest', { plan_path: 'plans/plan.json', report_prefix: 'acceptance' })
  assert.equal(result.ok, true); assert.equal(connected, 1)
  for (const ext of ['md', 'csv', 'json']) assert(!(await readFile(join(root, 'acceptance.' + ext), 'utf8')).includes('Synthetic-Local-Only!'))
  assert(!JSON.stringify(result).includes('Synthetic-Local-Only!'))
})

test('outcome adapter leaves unrelated plugins and existing SDK errors intact', async () => {
  let around
  installOutcomeAdapter({ on: (event, handler) => { assert.equal(event, 'tools/execute'); around = handler } }, ['ensp_test'])
  const other = { isError: false, value: { ok: false } }
  assert.equal(await around({ name: 'other_plugin' }, async () => other), other)
  const error = { isError: true, error: { message: 'original failure' } }
  assert.equal(await around({ name: 'ensp_test' }, async () => error), error)
})

test('# console is terminal once and native findings never imply device or capacity recovery', async () => {
  let attempts = 0
  const out = await waitDevicesReady([{ name: 'FW1', comPort: 8301 }], { sessionFactory: () => ({
    open: async () => { attempts++; throw Object.assign(Error('timed out'), { output: '##', kind: 'transport' }) }, close() {},
  }) })
  assert.equal(attempts, 1); assert.equal(out.devices[0].state, 'non_vrp_console'); assert.equal(out.ok, false)
  const diagnosis = diagnoseNativeLogs({ sources: [{ path: 'VBox.log', device: 'FW1', text: 'Char#0: Write failed with rc=VERR_NO_DATA\nNamedPipe0: ConnectNamedPipe failed with VERR_NO_DATA' }, { path: 'shared.log', text: 'SyncFlashFileThreadFunc UdpReceiveFile failed' }] })
  assert.equal(diagnosis.ok, false); assert.equal(diagnosis.findings.length, 3)
  assert.equal(diagnosis.findings[2].correlation, 'shared-log')
})

test('status retains hidden instance and separates disk topology from active identity', async t => {
  const root = await workspace(t)
  t.mock.method(Bridge.prototype, 'steps', async steps => ({ steps: steps.map(s => s.op === 'ensp' ? {
    ok: true, inventory: { processes: [{ pid: 42 }], main_windows: [{ hwnd: 123, pid: 42, visible: false, dialogs: [] }], process_scan_complete: true, active_project: { state: 'unknown', verified: false } },
  } : { ok: true, pong: true }) }))
  const registry = createRegistry({ workspace: root })
  const r = await registry.tools.find(t => t.name === 'ensp_status').handler({}, registry.exec)
  assert.equal(r.instances.length, 1); assert.equal(r.instances[0].visible, false)
  assert.equal(r.runtime.active_project.verified, false); assert.match(r.build.fingerprint, /^[a-f0-9]{64}$/u)
})
