import { open, readdir, lstat, realpath, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { collectWindowsEvents } from './windows-events.js'
import { correlateIncident } from './incident-correlator.js'
import { sessionLines } from './incident-session.js'
import { diagnoseNativeLogs } from './console-diagnostics.js'
import { createRedactor, redactValue } from './redaction.js'
import { readTopo } from './topo.js'

const HASH = data => createHash('sha256').update(data).digest('hex')
const inside = (root, target) => { const r = relative(root, target); return !isAbsolute(r) && r !== '..' && !r.startsWith('../') && !r.startsWith('..\\') }
export function incidentWindow(from, to, now = Date.now()) {
  const explicit = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/iu.test(value) && Number.isFinite(Date.parse(value))
  if ((from !== undefined && !explicit(from)) || (to !== undefined && !explicit(to))) throw Error('incident times require ISO8601 with explicit timezone')
  const end = to === undefined ? now : Date.parse(to), start = from === undefined ? end - 7200000 : Date.parse(from)
  if (start > end || end - start > 7 * 86400000) throw Error('incident window must be ordered and at most seven days')
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() }
}
async function tail(path, limit) {
  const file = await open(path, 'r')
  try {
    const before = await file.stat(), bom = Buffer.alloc(2); await file.read(bom, 0, 2, 0)
    const utf16 = bom[0] === 0xff && bom[1] === 0xfe
    let start = Math.max(0, before.size - limit); if (utf16 && start % 2) start++
    const bytes = Buffer.alloc(Math.min(limit, before.size - start)), read = await file.read(bytes, 0, bytes.length, start)
    const raw = bytes.subarray(0, read.bytesRead)
    let content = raw
    if (start) {
      let newline = -1
      if (utf16) { for (let i = 0; i + 1 < raw.length; i += 2) if (raw[i] === 10 && raw[i + 1] === 0) { newline = i + 1; break } }
      else newline = raw.indexOf(10)
      content = raw.subarray(newline < 0 ? raw.length : newline + 1)
    }
    let text, encoding = utf16 ? 'utf-16le' : 'utf-8'
    try { text = new TextDecoder(encoding, { fatal: true }).decode(content) }
    catch (error) { if (utf16) throw error; encoding = 'gb18030'; text = new TextDecoder(encoding, { fatal: true }).decode(content) }
    const after = await file.stat()
    return { text: text.replace(/^\uFEFF/u, ''), encoding, bytes: raw.length, sampled_sha256: HASH(raw), truncated: start > 0,
      changed_during_read: before.size !== after.size || before.mtimeMs !== after.mtimeMs }
  } finally { await file.close() }
}

export async function collectIncident(options = {}, { eventProvider = collectWindowsEvents, now = Date.now } = {}) {
  const window = incidentWindow(options.from, options.to, now()), started = performance.now()
  const budget = { remaining: 32 * 1024 * 1024 }, sources = [], timeline = [], operations = new Map()
  let timelineOmitted = 0, operationsOmitted = 0
  const addTimeline = row => { if (timeline.length < 10000) timeline.push(row); else timelineOmitted++ }
  const addOperation = (key, op) => { if (operations.has(key) || operations.size < 2000) { operations.set(key, op); return true } operationsOmitted++; return false }
  const checkDeadline = () => { if (performance.now() - started >= 20000) throw Object.assign(Error('incident deadline'), { code: 'DEADLINE' }) }
  const inWindow = value => Number.isFinite(Date.parse(value)) && Date.parse(value) >= Date.parse(window.from) && Date.parse(value) <= Date.parse(window.to)
  const unavailable = (kind, path, error) => sources.push({ kind, source: path, available: false, error: error?.code ?? 'READ_OR_PARSE_ERROR' })
  let eventResult = { rows: [] }, consideredFiles = 0
  try {
    eventResult = await eventProvider({ ...window, limit: 2000, timeoutMs: Math.max(1, 20000 - (performance.now() - started)) })
    sources.push({ kind: 'windows-events', source: 'Application', available: true, scanned: eventResult.scanned ?? eventResult.rows.length,
      truncated: !!eventResult.truncated, sampled_sha256: HASH(JSON.stringify(eventResult.rows)) })
    if (eventResult.rows.length > 2000) { eventResult.rows = eventResult.rows.slice(0, 2000); eventResult.truncated = true; sources.at(-1).truncated = true }
    eventResult.rows.forEach(row => addTimeline({ kind: 'windows-event', at: row.time, event_id: row.id,
      app: row.id === 1000 ? row.data?.AppName : row.data?.P1, record_id: row.recordId }))
  } catch (error) { unavailable('windows-events', 'Application', error) }
  async function* files(root, depth = 0) {
    checkDeadline()
    const dir = await realpath(root)
    const iterator = await import('node:fs/promises').then(fs => fs.opendir(dir))
    try {
      for await (const entry of iterator) {
        checkDeadline()
        if (consideredFiles >= 128) { sources.push({ kind: 'file-discovery', source: root, available: false, error: 'FILE_LIMIT' }); return }
        const path = join(dir, entry.name)
        if (entry.isDirectory() && depth > 0) yield* files(path, depth - 1)
        else if (entry.isFile() && /\.(?:log|jsonl|wer)$/iu.test(entry.name)) {
          const date = /\b(\d{4}-\d{2}-\d{2})\b/u.exec(entry.name.replace(/_/gu, ' '))?.[1]
          const first = new Date(Date.parse(window.from) - 86400000).toISOString().slice(0, 10), last = new Date(Date.parse(window.to) + 86400000).toISOString().slice(0, 10)
          if (date && (date < first || date > last)) continue
          consideredFiles++; yield path
        }
      }
    } finally { /* for-await closes opendir even on partial traversal */ }
  }
  async function sampled(kind, path) {
    checkDeadline()
    if (budget.remaining <= 0) throw Object.assign(Error('byte limit'), { code: 'BYTE_LIMIT' })
    if (!(await lstat(path)).isFile()) throw Error('source must be a regular file')
    const result = await tail(path, Math.min(262144, budget.remaining)); budget.remaining -= result.bytes
    sources.push({ kind, source: path, available: true, ...result, text: undefined })
    return result
  }
  const roots = []
  const nativeRoot = options.nativeLogRoot ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'eNSP') : null)
  if (nativeRoot) roots.push({ kind: 'native-log', root: join(nativeRoot, 'Log'), depth: 0 })
  roots.push({ kind: 'pcserver-log', root: options.pcLogRoot ?? join(dirname(options.ensp ?? 'C:/Program Files/Huawei/eNSP/eNSP_Client.exe'), 'plugin', 'pc_client_server', 'log'), depth: 2 })
  if (options.topology && nativeRoot) {
    try {
      const topology = await readTopo(options.topology)
      for (const device of topology.devices) if (/^USG/iu.test(device.model ?? '') && /^[a-f\d-]{36}$/iu.test(device.id ?? ''))
        roots.push({ kind: 'vm-log', root: join(nativeRoot, 'VBoxServer', 'devices', device.id), depth: 3 })
    } catch (error) { unavailable('topology', options.topology, error) }
  }
  if (options.werRoot) roots.push({ kind: 'wer-report', root: options.werRoot, depth: 2 })
  const executionRoot = options.executionRoot ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'dsh-ensp-fusion', 'diagnostics') : null)
  if (executionRoot) roots.push({ kind: 'execution-metadata', root: executionRoot, depth: 0 })
  for (const { kind, root, depth } of roots) {
    let count = 0
    try {
      for await (const path of files(root, depth)) {
        count++
        // Filename dates select candidates. mtime is never the event clock.
        const date = /\b(\d{4}-\d{2}-\d{2})\b/u.exec(basename(path).replace(/_/gu, ' '))?.[1]
        const startDate = new Date(Date.parse(window.from) - 86400000).toISOString().slice(0, 10), endDate = new Date(Date.parse(window.to) + 86400000).toISOString().slice(0, 10)
        if (date && (date < startDate || date > endDate)) continue
        try {
          const result = await sampled(kind, path)
          if (kind === 'execution-metadata') {
            for (const line of result.text.split(/\r?\n/u).filter(Boolean)) {
              const row = JSON.parse(line)
              if (!inWindow(row.at) || !/^[a-f\d-]{36}$/iu.test(row.operation_id ?? '') || !/^ensp_\w+$/u.test(row.tool ?? '')) continue
              // Persisted metadata has a whitelist too; never copy an arbitrary JSON row.
              const key = row.operation_id, op = operations.get(key) ?? { operation_id: key, tool: row.tool, started: row.at }
              if (row.type === 'finished') op.finished = row.at
              if (row.omitted_events > 0) sources.at(-1).omitted_events = (sources.at(-1).omitted_events ?? 0) + row.omitted_events
              addOperation(key, op)
              addTimeline({ kind: 'execution', operation_id: key, tool: row.tool, at: row.at, phase: ['started','validated','dispatched','observed','cancel_requested','stop_confirmed','stop_unconfirmed','finished'].includes(row.type) ? row.type : 'unknown',
                build_fingerprint: /^[a-f\d]{64}$/u.test(row.build_fingerprint ?? '') ? row.build_fingerprint : null })
            }
          } else if (kind === 'wer-report') {
            const fields = Object.fromEntries(result.text.split(/\r?\n/u).map(line => /^(AppName|AppPath|ReportIdentifier|EventType)=(.*)$/u.exec(line)).filter(Boolean).map(m => [m[1], m[2]]))
            addTimeline({ kind, at: null, source_ref: HASH(path), fields, time_basis: 'unknown' })
          } else {
            const diagnosis = diagnoseNativeLogs({ sources: [{ path, text: result.text }] })
            sources.at(-1).total_findings = diagnosis.totalFindings
            sources.at(-1).omitted_findings = diagnosis.omittedFindings
            for (const finding of diagnosis.findings) addTimeline({ kind, at: null, native_time: finding.loggedAt ?? null,
              time_basis: finding.timeBasis ?? 'unknown', source_ref: HASH(path), code: finding.code, tail_line: finding.tailLine,
              evidence: finding.evidence })
            if (kind === 'pcserver-log') for (const [i, line] of result.text.split(/\r?\n/u).entries()) {
              if (/fail(?:ed|ure)?|exception|fatal/iu.test(line)) addTimeline({ kind, at: null, source_ref: HASH(path), tail_line: i + 1,
                code: 'PCSERVER_ERROR_TEXT', evidence: line.slice(0, 600), time_basis: 'unknown' })
            }
          }
        } catch (error) { unavailable(kind, path, error) }
      }
      if (!count) unavailable(kind, root, { code: 'NO_MATCHING_FILES' })
    } catch (error) { unavailable(kind, root, error) }
  }
  // Explicit session list only. Return structural metadata, never script bodies.
  const sessionCalls = new Map(), seenCalls = new Set()
  for (const path of options.sessions ?? []) {
    delete budget.lastSession
    try {
      if (++consideredFiles > 128) throw Object.assign(Error('file limit'), { code: 'FILE_LIMIT' })
      const before = budget.remaining; let rows = 0
      for await (const line of sessionLines(path, budget, checkDeadline)) {
        if (++rows > 100000) throw Error('session row limit')
        if (!line.trim()) continue
        const row = JSON.parse(line.replace(/^\uFEFF/u, ''))
        if (!['tool/call','tool/result'].includes(row.type)) continue
        const time = typeof row.time === 'number' ? row.time : Date.parse(row.time)
        if (!Number.isFinite(time)) throw Object.assign(Error('tool record lacks valid time'), { code: 'SESSION_INVALID_TOOL_TIME' })
        const at = new Date(time).toISOString()
        if (!inWindow(at)) continue
        if (row.type === 'tool/call' && typeof row.data?.callId === 'string') {
          const name = row.data.name, callId = row.data.callId
          const key = `${callId}:${at}:${name}`
          if (seenCalls.has(key)) continue
          seenCalls.add(key)
          if (/^ensp_\w+$/u.test(name)) {
            const op = { operation_id: HASH(key), call_id: callId, tool: name, started: at }
            if (addOperation(op.operation_id, op)) sessionCalls.set(callId, op)
          } else if (name === 'run_code' && /\bensp_\w+/u.test(String(row.data.arguments))) addTimeline({ kind: 'host-reference', at, tool: name,
            call_ref: HASH(callId), internal_call_count: null })
        } else if (row.type === 'tool/result') {
          const op = sessionCalls.get(row.data?.message?.toolCallId)
          if (op) op.finished = at
        }
      }
      sources.push({ kind: 'dsh-session', source: path, available: true, rows, decoded_bytes: before - budget.remaining, ...budget.lastSession })
    } catch (error) { unavailable('dsh-session', path, error); Object.assign(sources.at(-1), budget.lastSession) }
  }
  const coverageIncomplete = timelineOmitted > 0 || operationsOmitted > 0 || sources.some(s => !s.available || s.truncated || s.changed_during_read || s.omitted_findings || s.omitted_events)
  const crash = correlateIncident(eventResult.rows, [...operations.values()])
  const summary = { schema_version: 1, ok: !coverageIncomplete, status: coverageIncomplete ? 'PARTIAL_EVIDENCE' : 'COLLECTED', window,
    collected_at: new Date(now()).toISOString(), crash, operations: [...operations.values()],
    coverage: { complete: !coverageIncomplete, bytes_read_or_decoded: 32 * 1024 * 1024 - budget.remaining,
      file_candidates: consideredFiles, omitted_timeline_rows: timelineOmitted, omitted_operations: operationsOmitted,
      limits: { files: 128, decoded_bytes: 32 * 1024 * 1024, timeout_ms: 20000, events: 2000, timeline_rows: 10000, operations: 2000, report_bytes: 16 * 1024 * 1024 } },
    limits: ['Collection success does not mean no crash or healthy business.', 'Native local times are unverified and are not automatically correlated as UTC.', 'No dump collection, restart, ACL or system configuration changes.'] }
  return redactValue({ summary, sources, timeline: timeline.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? ''))) }, createRedactor())
}

export async function writeIncidentReport(incident, { workspace, output }) {
  const root = await realpath(resolve(workspace)), destination = resolve(root, output)
  if (!inside(root, destination) || root === destination) throw Error('incident destination must be a new workspace subdirectory')
  const parent = await realpath(dirname(destination))
  if (!inside(root, parent)) throw Error('incident output parent escapes workspace')
  const report = `# eNSP incident ${incident.summary.status}\n\nWindow: ${incident.summary.window.from} — ${incident.summary.window.to}\n\nApplication Error records: ${incident.summary.crash.application_error_records}\nAffected process instances: ${incident.summary.crash.affected_instances}\nCoverage complete: ${incident.summary.coverage.complete}\n\nInstances are not proven independent terminations. Correlations do not establish causation. See summary.json and sources.json for limitations.\n`
  const outputs = { 'summary.json': JSON.stringify(incident.summary, null, 2) + '\n',
    'timeline.jsonl': incident.timeline.map(row => JSON.stringify(row)).join('\n') + '\n',
    'sources.json': JSON.stringify(incident.sources, null, 2) + '\n', 'report.md': report }
  if (Object.values(outputs).reduce((n, text) => n + Buffer.byteLength(text), 0) > 16 * 1024 * 1024) throw Error('incident report output exceeds 16 MiB')
  await mkdir(destination) // exclusive: never overwrite an old report
  for (const [name, text] of Object.entries(outputs)) await writeFile(join(destination, name), text, { flag: 'wx', mode: 0o600 })
  return { ...incident.summary, output: destination }
}
