import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export function classifyConsoleFailure(error) {
  const partial = String(error?.output ?? '').trim()
  if (error?.kind === 'authentication') return { state: 'authentication_required', retryable: false, action: 'Provide known credentials through credential_file; do not guess.' }
  if (['confirmation_required', 'input_required'].includes(error?.kind)) return { state: 'interaction_required', retryable: false, action: 'Inspect the prompt; provide explicit matching replies, never blind Enter/Y.' }
  if (/^#+$/u.test(partial)) return { state: 'non_vrp_console', retryable: false, action: 'Only # received. Inspect eNSP serial proxy and the matching VM NamedPipe logs; do not treat # as VRP or keep extending timeouts.' }
  return { state: 'booting_or_unreachable', retryable: true, action: 'Check process, port, VM and serial evidence independently; TCP open alone is not readiness.' }
}

export async function readLogTail(path, maxBytes = 262144) {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    const data = Buffer.alloc(Math.min(size, maxBytes))
    await file.read(data, 0, data.length, Math.max(0, size - data.length))
    return { text: data.toString('utf8'), bytes: data.length, truncated: size > data.length, mtime: (await file.stat()).mtime.toISOString() }
  } finally { await file.close() }
}

export function diagnoseNativeLogs({ consoleError, sources = [] }) {
  const findings = []
  for (const source of sources) {
    for (const [index, line] of String(source.text).split(/\r?\n/u).entries()) {
      let code
      if (/Char#\d+: Write failed.*VERR_NO_DATA|NamedPipe\d+: ConnectNamedPipe failed.*VERR_NO_DATA/iu.test(line)) code = 'SERIAL_PIPE_FAILURE'
      else if (/UdpReceiveFile failed|Failed to upload resource cfg file/iu.test(line)) code = 'PROJECT_SYNC_FAILURE'
      else if (/socket.*(?:10053|10054)/iu.test(line)) code = 'PROXY_CONNECTION_RESET'
      if (code) findings.push({ code, source: source.path, tailLine: index + 1, evidence: line.trim().slice(0, 600),
        correlation: source.device ? 'device-log' : 'shared-log', ...(source.device ? { device: source.device } : {}) })
    }
  }
  return { ok: findings.length === 0 && !consoleError, status: findings.length || consoleError ? 'ACTION_REQUIRED' : 'NO_MATCHING_ERRORS_IN_SAMPLE',
    console: consoleError ? classifyConsoleFailure(consoleError) : { state: 'not_probed' }, findings: findings.slice(-80),
    limits: ['Log evidence only; no automatic restart, version replacement or capacity claim.', 'Shared logs cannot identify a failed device without correlation. No matching error does not prove health.'],
    next: findings.some(f => f.code === 'SERIAL_PIPE_FAILURE')
      ? ['Back up the full project and nonempty configuration assets.', 'Inspect the matching VM serial endpoint and eNSP proxy ownership; use a guarded single-device lifecycle once.', 'After recovery require a genuine VRP prompt and display version before configuration.']
      : ['Correlate timestamps, device UUID, process and console evidence before recovery.'] }
}

export async function nativeLogSources(root, devices = []) {
  const result = []
  const logs = join(root, 'Log')
  const entries = await readdir(logs).catch(() => [])
  const candidates = []
  for (const category of ['Conserver', 'VBoxServer']) {
    const dated = (await Promise.all(entries.filter(name => name.startsWith(category + '_') && /\.log$/iu.test(name)).map(async name => {
      try { const info = await stat(join(logs, name)); return info.isFile() ? { name, mtime: info.mtimeMs } : null }
      catch { return null } // Logs may rotate or become inaccessible during discovery.
    }))).filter(Boolean)
    candidates.push(...dated.sort((a, b) => b.mtime - a.mtime).slice(0, 2).map(row => row.name))
  }
  for (const name of candidates) {
    const path = join(logs, name)
    try { result.push({ path, ...await readLogTail(path) }) } catch { /* disappearing logs are not health proof */ }
  }
  // Only correlate a VM log if the caller provided a topology-derived UUID.
  for (const device of devices) {
    const uuid = String(device.id ?? '')
    if (!/^[A-F\d-]{36}$/iu.test(uuid)) continue
    const directory = join(root, 'VBoxServer', 'devices', uuid)
    for (const name of await readdir(directory).catch(() => [])) {
      if (!/^vfw_usg_Clone_/iu.test(name)) continue
      const path = join(directory, name, 'Logs', 'VBox.log')
      try { result.push({ path, device: device.name, ...await readLogTail(path) }) } catch { /* missing VM logs are not health proof */ }
    }
  }
  return result
}
