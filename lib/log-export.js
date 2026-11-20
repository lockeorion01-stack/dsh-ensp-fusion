import { readFile, writeFile, stat } from 'node:fs/promises'
import * as zlib from 'node:zlib'
import { createRedactor, credentialValues, redactValue } from './redaction.js'

const MAX = 32 * 1024 * 1024
export function decodeZstdFrames(bytes) {
  if (!zlib.zstdDecompressSync) throw Error('Zstandard export requires Node.js with zstdDecompressSync (22.15+); original log was not copied')
  const chunks = []
  let cursor = 0, size = 0, frames = 0
  const need = length => { if (cursor + length > bytes.length) throw Error('truncated Zstandard session; no raw content exported') }
  while (cursor < bytes.length) {
    if (++frames > 100000) throw Error('too many Zstandard frames')
    need(4)
    const start = cursor, magic = bytes.readUInt32LE(cursor); cursor += 4
    if ((magic >>> 4) === (0x184d2a50 >>> 4)) {
      need(4); const length = bytes.readUInt32LE(cursor); cursor += 4; need(length); cursor += length; continue
    }
    if (magic !== 0xfd2fb528) throw Error('invalid concatenated Zstandard frame')
    need(1)
    const descriptor = bytes[cursor++], single = (descriptor & 32) !== 0
    if (descriptor & 24) throw Error('reserved Zstandard header bits')
    const contentFlag = descriptor >>> 6
    const headerSize = (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + (contentFlag ? [0, 2, 4, 8][contentFlag] : single ? 1 : 0)
    need(headerSize); cursor += headerSize
    for (;;) {
      need(3)
      const block = bytes.readUIntLE(cursor, 3); cursor += 3
      const type = (block >>> 1) & 3, length = block >>> 3
      if (type === 3 || length > 131072) throw Error('invalid Zstandard block')
      const encodedSize = type === 1 ? 1 : length
      need(encodedSize); cursor += encodedSize
      if (block & 1) break
    }
    if (descriptor & 4) { need(4); cursor += 4 }
    const data = zlib.zstdDecompressSync(bytes.subarray(start, cursor), { maxOutputLength: MAX - size })
    size += data.length
    if (size > MAX) throw Error('decoded log exceeds 32 MiB')
    chunks.push(data)
  }
  return Buffer.concat(chunks, size)
}
// Decode concatenated Zstandard frames with the runtime's bounded decoder.
// Malformed or unsupported inputs fail closed: never fall back to raw copying.
export async function exportSanitizedLog(source, destination, { operationId, callId } = {}) {
  if (operationId !== undefined && callId !== undefined) throw Error('operation_id and call_id are mutually exclusive')
  for (const id of [operationId, callId]) if (id !== undefined && (typeof id !== 'string' || !id.trim() || id.length > 256)) throw Error('operation_id or call_id must be a nonempty string <=256 characters')
  if ((await stat(source)).size > MAX) throw Error('log input exceeds 32 MiB; split into smaller sessions first')
  let bytes = await readFile(source)
  const magic = bytes.length >= 4 ? bytes.readUInt32LE(0) : 0
  const compressed = magic === 0xfd2fb528 || (magic >>> 4) === (0x184d2a50 >>> 4)
  if (compressed) {
    bytes = decodeZstdFrames(bytes)
  }
  if (bytes.length > MAX) throw Error('decoded log exceeds 32 MiB')
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '').split(/\r?\n/u)
    .map((text, index) => ({ text, line: index + 1 })).filter(row => row.text.trim())
  if (!lines.length || lines.length > 100000) throw Error('log must contain 1..100000 JSONL records')
  function expand(value, depth = 0) {
    if (depth > 30) throw Error('log JSON nesting exceeds limit; no export written')
    if (typeof value === 'string' && /^[\s]*[\[{]/u.test(value)) {
      let parsed
      try { parsed = JSON.parse(value) } catch { return value }
      return expand(parsed, depth + 1)
    }
    if (Array.isArray(value)) return value.map(v => expand(v, depth + 1))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, depth + 1)]))
    return value
  }
  let records
  try { records = lines.map(row => expand(JSON.parse(row.text))) }
  catch { throw Error('log must be valid JSONL within nesting limits; no raw content exported') }
  // Collect before replacing: an echoed password may precede its credential
  // field or appear in another record. Decode nested arguments/content JSON too.
  const secrets = records.flatMap(credentialValues)
  // Standalone password syntax is ambiguous in documentation. Accept it in
  // command fields, or with a VRP mode keyword. Recognisable VRP command
  // prefixes also occur inside captured configuration and quoted transcripts.
  const credentialToken = /(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"',;]+))/u.source
  const keyword = '(?:password|secret|cipher|community|private-key|pre-shared-key|authentication-key|shared-key)'
  const modifiers = '(?:(?:cipher|simple|irreversible-cipher|read|write|key-id\\s+\\d+|authentication-mode|md5|sha2-256)\\s+)*'
  const prefix = '(?:local-user\\s+\\S+|snmp-agent|radius-server|hwtacacs-server|ike|ipsec|ospf|isis|ntp-service|bgp|authentication-mode)'
  const qualified = new RegExp('(?:\\b' + prefix + '[^\\r\\n"\\x27;]{0,192}?\\b' + keyword + '\\s+' + modifiers + '|\\b' + keyword + '\\s+(?:cipher|simple|irreversible-cipher)\\s+)' + credentialToken, 'giu')
  const inlineCommand = new RegExp('\\b' + keyword + '\\s+' + modifiers + credentialToken, 'iu')
  // A two-token native configuration line can precede an echo in another
  // record. Match the entire line to avoid interpreting descriptive sentences.
  const bareLine = new RegExp('^[\\t ]*' + keyword + '[\\t ]+' + credentialToken + '[\\t ]*$', 'gimu')
  const commandFields = new Set(['commands', 'command', 'cmd', 'recovery_commands'])
  const outputFields = new Set(['text', 'content', 'output', 'configuration', 'transcript'])
  function commandSecrets(value, key = '') {
    if (typeof value === 'string') {
      const matches = [...value.matchAll(qualified)]
      if (commandFields.has(key)) {
        const match = inlineCommand.exec(value)
        if (match) matches.push(match)
      } else if (outputFields.has(key)) for (const match of value.matchAll(bareLine)) matches.push(match)
      for (const match of matches) secrets.push(match[1] ?? match[2] ?? match[3])
    } else if (Array.isArray(value)) value.forEach(item => commandSecrets(item, key))
    else if (value && typeof value === 'object') {
      for (const [field, item] of Object.entries(value)) commandSecrets(item, field)
    }
  }
  records.forEach(row => commandSecrets(row))
  const redact = createRedactor(secrets)
  // Preserve host event discriminators, even when a short credential happens
  // to occur inside a fixed event name. Arbitrary user text still gets scrubbed.
  const eventTypes = new Set([
    'tool/ptc-dispatch', 'tool/ptc-dispatch-start', 'tool/call', 'tool/result', 'step/start', 'step/end',
    'assistant/message', 'user/message', 'system/message', 'turn/start', 'turn/end', 'assistant/attempt',
    'agent/inbox/spliced', 'job/registered', 'job/settled', 'llm/retry', 'llm/retry-started',
    'workspace/changes', 'request/header', 'deliverables/presented', 'session/title', 'command/run',
    'command/done', 'session', 'permission/preset', 'sandbox/mode', 'approval/policy',
    'subagent/model-selection-policy', 'request/context', 'session/title-llm-request', 'session/end-seed',
  ])
  function cleanRecord(row) {
    const clean = redactValue(row, redact)
    if (eventTypes.has(row?.type)) clean.type = row.type
    return clean
  }
  if (operationId !== undefined || callId !== undefined) {
    const selector = operationId !== undefined ? { operation_id: operationId } : { call_id: callId }
    const matches = [], results = []
    function evidence(value, line, field = '') {
      if (!value || typeof value !== 'object') return
      const execution = value.execution
      const operationMatch = operationId !== undefined && execution?.operation_id === operationId
      const callMatch = callId !== undefined && execution?.call_id === callId
      if (operationMatch || callMatch) results.push({ line, field, tool: execution.tool ?? null,
        call_id: execution.call_id ?? null, operation_id: execution.operation_id ?? null,
        isError: value.ok === false || execution.status !== 'success', result: value })
      if (Array.isArray(value)) value.forEach((item, i) => evidence(item, line, field + '/' + i))
      else for (const [key, item] of Object.entries(value)) if (key !== 'execution') evidence(item, line, field + '/' + key)
    }
    for (let index = 0; index < records.length; index++) {
      const row = records[index], line = lines[index].line
      const previous = results.length
      evidence(row, line)
      const data = row?.data
      const dispatchMatch = callId !== undefined && data?.subCallId === callId
      const metadataMatch = operationId !== undefined ? row?.operation_id === operationId : row?.call_id === callId
      if (!dispatchMatch && !metadataMatch && results.length === previous) continue
      matches.push({ line, record: cleanRecord(row) })
      // A thrown tool may have no execution envelope. Keep its exact dispatch
      // error/content, but never manufacture a structured successful response.
      if (dispatchMatch && row.type === 'tool/ptc-dispatch' && results.length === previous) {
        results.push({ line, field: '/data', tool: data.name ?? null, call_id: data.subCallId,
          operation_id: null, isError: data.isError === true, result: null,
          error: data.error ?? null, content: data.content ?? [] })
      }
    }
    if (!matches.length) throw Error('no exact operation_id or call_id match; no export written')
    const artifact = { schema_version: 1, selector: redactValue(selector, redact), matchedRecords: matches.length,
      structuredResults: results.filter(row => row.result !== null).length, results: results.map(result => redactValue(result, redact)), records: matches,
      evidenceLevel: results.some(row => row.result !== null) ? 'structured-result' : 'metadata-or-dispatch-only',
      limits: ['Exact selector matches only; an absent response is never reconstructed from metadata.', 'Sanitized local evidence does not independently verify the active GUI project or device business.'] }
    await writeFile(destination, JSON.stringify(artifact, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    return { ok: true, source, destination, records: matches.length, compressed, originalModified: false,
      selector: artifact.selector, structuredResults: artifact.structuredResults, evidenceLevel: artifact.evidenceLevel, limits: artifact.limits }
  }
  await writeFile(destination, records.map(row => JSON.stringify(cleanRecord(row))).join('\n') + '\n', { flag: 'wx', mode: 0o600 })
  return { ok: true, source, destination, records: records.length, compressed, originalModified: false,
    limits: ['Exports a new sanitized JSONL file; never rewrites host logs.', 'Key-based credentials, explicit replies, configuration secrets and their echoes are scrubbed. Review unstructured free text before sharing.'] }
}
