import { mkdir, opendir, stat, open, unlink, appendFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Per-operation files avoid shared JSONL interleaving across hosts/processes.
export async function openExecutionLog(root, id, { maxBytes = 128 * 1024 * 1024, retentionMs = 7 * 86400000, operationBytes = 16384 } = {}) {
  if (typeof id !== 'string' || !/^[a-f\d-]{4,64}$/iu.test(id)) throw Error('invalid diagnostic operation id')
  await mkdir(root, { recursive: true })
  const lockPath = join(root, 'allocation.lock')
  let lock
  for (let attempt = 0; !lock; attempt++) {
    try { lock = await open(lockPath, 'wx') }
    catch (error) { if (error.code !== 'EEXIST' || attempt >= 20) throw error; await delay(5) }
  } // A stale allocation lock fails closed, rather than deleting someone else's lock.
  let path, bytes = 0, closed = false, queue = Promise.resolve()
  try {
    let total = 0, entries = 0
    for await (const entry of await opendir(root)) {
      if (++entries > 8192) throw Error('diagnostic metadata file-count limit reached')
      if (!entry.isFile() || !/^[a-f\d-]+\.(?:active|closed)\.jsonl$/u.test(entry.name)) continue
      const file = join(root, entry.name)
      let info
      try { info = await stat(file) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      if (entry.name.endsWith('.closed.jsonl') && Date.now() - info.mtimeMs > retentionMs) await unlink(file)
      else total += entry.name.endsWith('.active.jsonl') ? Math.max(operationBytes, info.size) : info.size
    }
    if (total + operationBytes > maxBytes) throw Error('diagnostic metadata capacity reached')
    path = join(root, `${id}.active.jsonl`)
    const file = await open(path, 'wx', 0o600); await file.close()
  } finally { await lock.close(); await unlink(lockPath) }
  return {
    event(row) {
      const task = async () => {
        if (closed) throw Error('execution log already closed')
        const text = JSON.stringify(row) + '\n', size = Buffer.byteLength(text)
        const ceiling = row.type === 'finished' ? operationBytes : Math.max(0, operationBytes - 2048)
        if (bytes + size > ceiling) throw Error('operation metadata limit reached')
        await appendFile(path, text); bytes += size
      }
      const pending = queue.then(task)
      queue = pending.catch(() => {}) // a rejected event must not prevent the terminal record/close
      return pending
    },
    async close() { await queue; await rename(path, join(root, `${id}.closed.jsonl`)); closed = true },
  }
}
