import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, linkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A fully written owner file is published with an atomic hard link. Readers
// never see partially written JSON. Fail fast instead of queuing console input.
export function acquireDeviceLock(host, port, root = join(tmpdir(), 'ensp-fusion-device-locks')) {
  mkdirSync(root, { recursive: true })
  const address = /^(?:localhost|127\.\d+\.\d+\.\d+|::1)$/i.test(host) ? 'loopback' : host.toLowerCase()
  const key = createHash('sha256').update(`${address}:${port}`).digest('hex')
  const path = join(root, `${key}.lock`)
  const candidate = join(root, `${key}.${process.pid}.${randomUUID()}.owner`)
  const owner = { pid: process.pid, token: randomUUID(), host: address, port, created_at: new Date().toISOString() }
  writeFileSync(candidate, JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
  const busy = () => Object.assign(new Error(`device console ${host}:${port} is busy in another session`), { kind: 'device_busy' })
  let acquired = false
  try {
    try { linkSync(candidate, path); acquired = true }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      // Serialize stale reclamation. A crashed reclaimer leaves a conservative
      // busy result; it can be inspected and removed when all clients stop.
      const guard = `${path}.reclaim`
      try { writeFileSync(guard, String(process.pid), { flag: 'wx', mode: 0o600 }) }
      catch (error) { if (error.code === 'EEXIST') throw busy(); throw error }
      try {
        let old
        try { old = JSON.parse(readFileSync(path, 'utf8')) }
        catch (error) { if (error.code !== 'ENOENT') throw busy() }
        if (old) {
          if (!Number.isInteger(old.pid) || old.pid <= 0) throw busy()
          let alive = true
          try { process.kill(old.pid, 0) }
          catch (error) { if (error.code === 'ESRCH') alive = false }
          if (alive) throw busy()
          unlinkSync(path)
        }
        try { linkSync(candidate, path); acquired = true }
        catch (error) { if (error.code === 'EEXIST') throw busy(); throw error }
      } finally { unlinkSync(guard) }
    }
  } finally { unlinkSync(candidate) }
  let released = false
  return () => {
    if (released || !acquired) return
    released = true
    try {
      if (JSON.parse(readFileSync(path, 'utf8')).token === owner.token) unlinkSync(path)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
