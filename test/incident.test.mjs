import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as zlib from 'node:zlib'
import { correlateIncident } from '../lib/incident-correlator.js'
import { collectIncident, incidentWindow, writeIncidentReport } from '../lib/crash-collector.js'
import { sessionLines } from '../lib/incident-session.js'
const at = '2026-11-18T14:33:00Z'
const fault = (recordId, creation = '0x10') => ({ id: 1000, recordId, time: at, provider: 'Application Error', data: { AppName: 'eNSP_Client.exe', ProcessId: '0x20', ProcessCreationTime: creation, ExceptionCode: 'c000008c' } })

test('crash records deduplicate separately from process identity and never imply causation', () => {
  const events = [fault(1), fault(1), fault(2), fault(3, '0x11'), fault(4, ''),
    ...[5,6].map(recordId => ({ id: 1001, recordId, time: at, data: { P1: 'eNSP_Client.exe', ReportId: 'report' } }))]
  const result = correlateIncident(events, [{ operation_id: 'op', tool: 'ensp_cli', at }])
  assert.equal(result.application_error_records, 4); assert.equal(result.affected_instances, 2)
  assert.equal(result.ungrouped_records.length, 1); assert.equal(result.wer_reports.length, 1)
  assert.equal(result.instances[0].correlations[0].relation, 'temporal_only')
  assert.equal(result.instances[0].correlations[0].causal, false)
})

test('collector decodes UTF16/GB18030, reports missing coverage, and writes exclusive reports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ensp-incident-')); t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'native', 'Log'), { recursive: true }); await mkdir(join(root, 'pc')); await mkdir(join(root, 'meta'))
  await writeFile(join(root, 'native', 'Log', 'Conserver_2026-11-18.log'), Buffer.concat([Buffer.from('[INFO]22:33:00 '), Buffer.from([0xd6,0xd0,0xce,0xc4]), Buffer.from(' Failed to put vrpcfg.zip\n')]))
  await writeFile(join(root, 'pc', '2026-11-18.log'), Buffer.concat([Buffer.from([255,254]), Buffer.from('HttpClient failed 中文\r\n', 'utf16le')]))
  const options = { from: '2026-11-18T22:25:00+08:00', to: '2026-11-18T22:40:00+08:00', nativeLogRoot: join(root, 'native'), pcLogRoot: join(root, 'pc'), executionRoot: join(root, 'missing') }
  const incident = await collectIncident(options, { eventProvider: async () => ({ rows: [fault(1)], scanned: 1 }) })
  assert.equal(incident.summary.crash.affected_instances, 1); assert.equal(incident.summary.coverage.complete, false)
  assert(incident.sources.some(s => s.encoding === 'utf-16le')); assert(incident.sources.some(s => s.encoding === 'gb18030'))
  assert(incident.timeline.some(r => r.code === 'PROJECT_SYNC_FAILURE' && r.evidence.includes('中文')))
  assert(incident.timeline.some(r => r.code === 'PCSERVER_ERROR_TEXT' && r.evidence.includes('中文')))
  await writeIncidentReport(incident, { workspace: root, output: 'report' })
  await assert.rejects(writeIncidentReport(incident, { workspace: root, output: 'report' }), { code: 'EEXIST' })
  await assert.rejects(writeIncidentReport(incident, { workspace: root, output: '../escape' }), /workspace/u)
  assert.equal(JSON.parse(await readFile(join(root, 'report', 'summary.json'), 'utf8')).status, 'PARTIAL_EVIDENCE')
  assert.throws(() => incidentWindow('2026-11-18T22:00:00', at), /timezone/u)
})

test('sessions stream concatenated frames, deduplicate inherited calls and keep scripts private', async t => {
  if (!zlib.zstdCompressSync) return t.skip('runtime lacks zstd')
  const root = await mkdtemp(join(tmpdir(), 'ensp-session-')); t.after(() => rm(root, { recursive: true, force: true }))
  const rows = [{ type: 'session', version: 4, createdAt: at }, { type: 'tool/call', time: at, data: { name: 'ensp_cli', callId: 'call', arguments: '{"password":"Synthetic-Secret!"}' } },
    { type: 'tool/result', time: at, data: { message: { toolCallId: 'call' } } },
    { type: 'tool/call', time: at, data: { name: 'run_code', callId: 'ref', arguments: 'tools.ensp_cli({password:"Synthetic-Secret!"})' } }]
  const path = join(root, 'session.zstd')
  await writeFile(path, Buffer.concat(rows.map(r => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n')))))
  const decoded = []; for await (const line of sessionLines(path, { remaining: 4096 }, () => {})) decoded.push(JSON.parse(line))
  assert.deepEqual(decoded, rows)
  const incident = await collectIncident({ from: '2026-11-18T14:30:00Z', to: '2026-11-18T14:40:00Z', sessions: [path, path], nativeLogRoot: root, pcLogRoot: root, executionRoot: root }, { eventProvider: async () => ({ rows: [] }) })
  assert.equal(incident.summary.operations.length, 1)
  assert.equal(incident.timeline.filter(r => r.kind === 'host-reference').length, 1)
  assert(!JSON.stringify(incident).includes('Synthetic-Secret!'))
  await writeFile(path, Buffer.from([0x28,0xb5,0x2f,0xfd]))
  const bad = []; await assert.rejects(async () => { for await (const line of sessionLines(path, { remaining: 4096 }, () => {})) bad.push(line) }, /truncated/u)
  assert.equal(bad.length, 0)
})
