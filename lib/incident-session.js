import { open } from 'node:fs/promises'
import * as zlib from 'node:zlib'
import { createHash } from 'node:crypto'

// Frame-at-a-time, bounded compressed and decoded data. Never tail a zstd stream.
export async function* sessionLines(path, budget, checkDeadline) {
  const file = await open(path, 'r'); let offset = 0, decoded = '', frames = 0
  const hash = createHash('sha256')
  let initial, size = 0, decodedBytes = 0
  async function read(n) {
    checkDeadline()
    if (offset + n > size) throw Error('truncated session frame')
    if (offset + n > 32 * 1024 * 1024) throw Object.assign(Error('session compressed-input limit'), { code: 'SESSION_INPUT_LIMIT' })
    if (n > budget.remaining) throw Object.assign(Error('incident read/decode byte limit'), { code: 'INCIDENT_BYTE_LIMIT' })
    const bytes = Buffer.alloc(n), { bytesRead } = await file.read(bytes, 0, n, offset)
    if (bytesRead !== n) throw Error('session changed during read')
    offset += n; budget.remaining -= n; hash.update(bytes); return bytes
  }
  function consume(bytes) {
    decodedBytes += bytes.length
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  try {
    initial = await file.stat()
    if (!initial.isFile()) throw Error('session must be a regular file')
    size = initial.size
    if (size < 4) { if (size) yield consume(await read(size)); return }
    const first = Buffer.alloc(4); await file.read(first, 0, 4, 0)
    const magic = first.readUInt32LE()
    const zstd = magic === 0xfd2fb528 || (magic >>> 4) === (0x184d2a50 >>> 4)
    if (!zstd) {
      // TextDecoder streaming preserves UTF-8 characters split across read chunks.
      const decoder = new TextDecoder('utf-8', { fatal: true })
      while (offset < size) {
        const n = Math.min(65536, size - offset, budget.remaining)
        if (!n) throw Object.assign(Error('incident decoded-byte limit'), { code: 'INCIDENT_BYTE_LIMIT' })
        const bytes = await read(n); decodedBytes += bytes.length; decoded += decoder.decode(bytes, { stream: true })
        let nl; while ((nl = decoded.indexOf('\n')) >= 0) { if (nl > 1024 * 1024) throw Error('session line limit'); yield decoded.slice(0, nl); decoded = decoded.slice(nl + 1) }
        if (decoded.length > 1024 * 1024) throw Error('session line limit')
      }
      decoded += decoder.decode()
    } else {
      if (!zlib.zstdDecompressSync) throw Error('Zstandard requires Node 22.15+')
      const decoder = new TextDecoder('utf-8', { fatal: true })
      while (offset < size) {
        if (++frames > 100000) throw Error('session frame limit')
        const chunks = [await read(4)], magic = chunks[0].readUInt32LE()
        if ((magic >>> 4) === (0x184d2a50 >>> 4)) { const length = (await read(4)).readUInt32LE(); await read(length); continue }
        if (magic !== 0xfd2fb528) throw Error('invalid session frame')
        const desc = await read(1); chunks.push(desc)
        const d = desc[0], single = !!(d & 32), flag = d >>> 6
        if (d & 24) throw Error('reserved session frame bits')
        chunks.push(await read((single ? 0 : 1) + [0, 1, 2, 4][d & 3] + (flag ? [0, 2, 4, 8][flag] : single ? 1 : 0)))
        let frameBytes = chunks.reduce((n, b) => n + b.length, 0)
        for (;;) {
          const header = await read(3), h = header.readUIntLE(0, 3), type = (h >>> 1) & 3, n = h >>> 3
          if (type === 3 || n > 131072) throw Error('invalid session block')
          chunks.push(header, await read(type === 1 ? 1 : n)); frameBytes += 3 + (type === 1 ? 1 : n)
          if (frameBytes > 4 * 1024 * 1024) throw Error('session frame compressed-size limit')
          if (h & 1) break
        }
        if (d & 4) chunks.push(await read(4))
        if (!budget.remaining) throw Object.assign(Error('incident decoded-byte limit'), { code: 'INCIDENT_BYTE_LIMIT' })
        let bytes
        try { bytes = zlib.zstdDecompressSync(Buffer.concat(chunks), { maxOutputLength: budget.remaining }) }
        catch (error) { if (error.code === 'ERR_BUFFER_TOO_LARGE') error.code = 'INCIDENT_BYTE_LIMIT'; throw error }
        budget.remaining -= bytes.length; decodedBytes += bytes.length; decoded += decoder.decode(bytes, { stream: true })
        let nl; while ((nl = decoded.indexOf('\n')) >= 0) { if (nl > 1024 * 1024) throw Error('session line limit'); yield decoded.slice(0, nl); decoded = decoded.slice(nl + 1) }
        if (decoded.length > 1024 * 1024) throw Error('session line limit')
      }
      decoded += decoder.decode()
    }
    const final = await file.stat()
    if (final.size !== initial.size || final.mtimeMs !== initial.mtimeMs) throw Error('session changed during read')
    if (decoded.trim()) yield decoded
  } finally { budget.lastSession = { sampled_sha256: hash.digest('hex'), input_bytes_read: offset, decoded_bytes: decodedBytes }; await file.close() }
}
