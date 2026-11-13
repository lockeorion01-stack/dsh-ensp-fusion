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
export async function exportSanitizedLog(source, destination) {
  if ((await stat(source)).size > MAX) throw Error('log input exceeds 32 MiB; split into smaller sessions first')
  let bytes = await readFile(source)
  const magic = bytes.length >= 4 ? bytes.readUInt32LE(0) : 0
  const compressed = magic === 0xfd2fb528 || (magic >>> 4) === (0x184d2a50 >>> 4)
  if (compressed) {
    bytes = decodeZstdFrames(bytes)
  }
  if (bytes.length > MAX) throw Error('decoded log exceeds 32 MiB')
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '').split(/\r?\n/u).filter(s => s.trim())
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
  try { records = lines.map(line => expand(JSON.parse(line))) }
  catch { throw Error('log must be valid JSONL within nesting limits; no raw content exported') }
  // Collect before replacing: an echoed password may precede its credential
  // field or appear in another record. Decode nested arguments/content JSON too.
  const secrets = records.flatMap(credentialValues)
  function commandSecrets(value) {
    if (typeof value === 'string') {
      for (const m of value.matchAll(/\b(?:password|cipher|secret|community|pre-shared-key|authentication-key|shared-key)\s+(?:(?:cipher|simple|irreversible-cipher)\s+)?([^\s"',;]+)/giu)) secrets.push(m[1])
    } else if (value && typeof value === 'object') Object.values(value).forEach(commandSecrets)
  }
  records.forEach(commandSecrets)
  const redact = createRedactor(secrets)
  const cleaned = records.map(row => redactValue(row, redact))
  await writeFile(destination, cleaned.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx', mode: 0o600 })
  return { ok: true, source, destination, records: records.length, compressed, originalModified: false,
    limits: ['Exports a new sanitized JSONL file; never rewrites host logs.', 'Key-based credentials, explicit replies, configuration secrets and their echoes are scrubbed. Review unstructured free text before sharing.'] }
}
