import { randomUUID } from 'node:crypto'
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { scrubSensitiveText } from './redaction.js'
import { validateRecoveryGuard } from './recovery-guard.js'

function durable(path, text, flags = 'wx') {
  const fd = openSync(path, flags, 0o600)
  try {
    const bytes = Buffer.from(text)
    for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    fsyncSync(fd)
  } finally { closeSync(fd) }
}

export function scrubConfiguration(text) {
  return scrubSensitiveText(text)
}

export function createChangeJournal(root, plan, redact = String) {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
  const folder = join(root, id)
  mkdirSync(folder, { recursive: true })
  const clean = text => scrubConfiguration(redact(text))
  const manifest = {
    version: 1, id, pid: process.pid, created_at: new Date().toISOString(),
    port: plan.port, device: plan.device ?? null, system_view: plan.system_view === true,
    save: plan.save ?? null, commands: plan.commands.map(clean),
    recovery_commands: (plan.recovery_commands ?? []).map(clean),
    recovery_of: plan.recovery_of ?? null,
  }
  const path = join(folder, 'manifest.json')
  durable(path, JSON.stringify(manifest, null, 2))
  const eventPath = join(folder, 'events.jsonl')
  durable(eventPath, '')
  return {
    path,
    event(type, data = {}) {
      const value = JSON.parse(JSON.stringify(data, (_, v) => typeof v === 'string' ? clean(v) : v))
      durable(eventPath, `${JSON.stringify({ at: new Date().toISOString(), type, ...value })}\n`, 'a')
    },
    snapshot(name, output) { durable(join(folder, `${name}.txt`), clean(output)) },
    guard(value) { durable(join(folder, 'recovery-guard.json'), JSON.stringify(validateRecoveryGuard(value), null, 2)) },
  }
}

export function readRecoveryPlan(path) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (manifest.version !== 1 || !Number.isInteger(manifest.port) || manifest.port < 1 || manifest.port > 65535
    || !Array.isArray(manifest.recovery_commands) || !manifest.recovery_commands.length
    || manifest.recovery_commands.some(line => typeof line !== 'string' || line.includes('[REDACTED]'))) {
    throw new Error('journal has no usable explicit recovery plan; review snapshot and supply commands manually')
  }
  const status = journalStatus(path, manifest)
  if (status === 'active-or-unfinished') throw new Error('journal owner is still running with no finished record; do not recover an active change')
  let recovery_guard
  try { recovery_guard = validateRecoveryGuard(JSON.parse(readFileSync(join(dirname(path), 'recovery-guard.json'), 'utf8'))) }
  catch { throw new Error('Recovery requires a valid post-change identity/configuration guard; legacy or incomplete journal requires manual review') }
  return { port: manifest.port, device: manifest.device ?? undefined, commands: manifest.recovery_commands,
    system_view: manifest.system_view === true, save: false, recovery_of: path, recovery_guard }
}

function journalStatus(path, manifest) {
  let events = []
  try { events = readFileSync(join(dirname(path), 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) }
  catch { /* Missing/torn events cannot establish success. */ }
  const last = events.at(-1)
  if (last?.type === 'finished') return last.ok ? 'completed' : 'failed'
  if (Number.isInteger(manifest.pid) && manifest.pid > 0) {
    try { process.kill(manifest.pid, 0); return 'active-or-unfinished' }
    catch (error) { if (error.code !== 'ESRCH') return 'active-or-unfinished' }
  }
  return 'interrupted'
}

export function listChangeJournals(root) {
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
    const path = join(root, entry.name, 'manifest.json')
    try {
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      let guarded = false
      try { validateRecoveryGuard(JSON.parse(readFileSync(join(root, entry.name, 'recovery-guard.json'), 'utf8'))); guarded = true } catch { /* manual review */ }
      return { path, port: manifest.port, device: manifest.device, created_at: manifest.created_at,
        status: journalStatus(path, manifest), recovery_guard_available: guarded, recovery_available: guarded && Array.isArray(manifest.recovery_commands) && manifest.recovery_commands.length > 0
          && manifest.recovery_commands.every(line => typeof line === 'string' && !line.includes('[REDACTED]')) }
    } catch { return { path, status: 'unreadable', recovery_available: false } }
  })
}
