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
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('log tail byte limit must be a positive integer')
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    const data = Buffer.alloc(Math.min(size, maxBytes))
    const start = Math.max(0, size - data.length)
    const { bytesRead } = await file.read(data, 0, data.length, start)
    let content = data.subarray(0, bytesRead)
    if (start > 0) {
      const previous = Buffer.alloc(1)
      await file.read(previous, 0, 1, start - 1)
      // Discard an incomplete first line, including any split multibyte character.
      if (previous[0] !== 10) content = content.subarray(content.indexOf(10) < 0 ? content.length : content.indexOf(10) + 1)
    }
    let text, encoding = 'utf-8'
    try { text = new TextDecoder(encoding, { fatal: true }).decode(content) }
    catch { encoding = 'gb18030'; text = new TextDecoder(encoding).decode(content) }
    return { text, encoding, bytes: bytesRead, truncated: size > bytesRead, mtime: (await file.stat()).mtime.toISOString() }
  } finally { await file.close() }
}

export function diagnoseNativeLogs({ consoleError, sources = [], unavailableSources = [] }) {
  const findings = []
  const findingCounts = {}
  let totalFindings = 0
  for (const source of sources) {
    const date = /(?:Conserver|VBoxServer)_(\d{4}-\d{2}-\d{2})\.log$/iu.exec(source.path)?.[1]
    for (const [index, line] of String(source.text).split(/\r?\n/u).entries()) {
      let code
      if (/Char#\d+: Write failed.*VERR_NO_DATA|NamedPipe\d+: ConnectNamedPipe failed.*VERR_NO_DATA/iu.test(line)) code = 'SERIAL_PIPE_FAILURE'
      else if (/UdpReceiveFile failed|Failed to upload resource cfg file|Failed to put (?:vrpcfg\.(?:zip|cfg)|flash\.efz)\b/iu.test(line)) code = 'PROJECT_SYNC_FAILURE'
      else if (/GetVBoxFileListenPort failed/iu.test(line)) code = 'FILE_TRANSFER_UNAVAILABLE'
      else if (/StartDeviceThreadFunc.*Failed to start device/iu.test(line)) code = 'DEVICE_START_FAILURE'
      else if (/CAgent::WaitMe.*Failed to wait for processes to exit/iu.test(line)) code = 'PROCESS_EXIT_FAILURE'
      else if (/socket.*(?:10053|10054)/iu.test(line)) code = 'PROXY_CONNECTION_RESET'
      if (code) {
        totalFindings++
        findingCounts[code] = (findingCounts[code] ?? 0) + 1
        const time = /^\[(?:ERROR|INFO|WARN|DEBUG)\](\d{2}:\d{2}:\d{2})\b/iu.exec(line)?.[1]
        findings.push({ code, source: source.path, tailLine: index + 1, evidence: line.trim().slice(0, 600),
          ...(date && time ? { loggedAt: `${date} ${time}`, timeBasis: 'native-local-clock-unverified' } : {}),
          correlation: source.device ? 'device-log' : 'shared-log', ...(source.device ? { device: source.device } : {}) })
        if (findings.length > 80) findings.shift()
      }
    }
  }
  const incomplete = !sources.length || unavailableSources.length > 0
  return { ok: totalFindings === 0 && !consoleError && !incomplete,
    status: totalFindings || consoleError ? 'ACTION_REQUIRED' : incomplete ? 'INSUFFICIENT_LOG_EVIDENCE' : 'NO_MATCHING_ERRORS_IN_SAMPLE',
    console: consoleError ? classifyConsoleFailure(consoleError) : { state: 'not_probed' }, findings,
    totalFindings, omittedFindings: totalFindings - findings.length, findingCounts, unavailableSources,
    limits: ['Log evidence only; no automatic restart, version replacement or capacity claim.', 'Shared logs cannot identify a failed device without correlation. No matching error does not prove health.',
      'Native timestamps use the log filename and local clock; mtime is not the event time. Windows crash reports and PCServer logs are outside this sample.'],
    next: findingCounts.SERIAL_PIPE_FAILURE
      ? ['Back up the full project and nonempty configuration assets.', 'Inspect the matching VM serial endpoint and eNSP proxy ownership; use a guarded single-device lifecycle once.', 'After recovery require a genuine VRP prompt and display version before configuration.']
      : ['Correlate timestamps, device UUID, process and console evidence before recovery.'] }
}

export async function nativeLogSources(root, devices = [], { onUnavailable = () => {} } = {}) {
  const result = []
  const logs = join(root, 'Log')
  const unavailable = (path, error, extra = {}) => onUnavailable({ path, code: error?.code ?? 'UNAVAILABLE', ...extra })
  const entries = await readdir(logs).catch(error => { unavailable(logs, error); return [] })
  const candidates = []
  for (const category of ['Conserver', 'VBoxServer']) {
    const dated = (await Promise.all(entries.filter(name => name.startsWith(category + '_') && /\.log$/iu.test(name)).map(async name => {
      try { const info = await stat(join(logs, name)); return info.isFile() ? { name, mtime: info.mtimeMs } : null }
      catch (error) { unavailable(join(logs, name), error, { category }); return null }
    }))).filter(Boolean)
    if (!dated.length) unavailable(logs, { code: 'NO_MATCHING_LOGS' }, { category })
    candidates.push(...dated.sort((a, b) => b.mtime - a.mtime).slice(0, 2).map(row => row.name))
  }
  for (const name of candidates) {
    const path = join(logs, name)
    try { result.push({ path, ...await readLogTail(path) }) } catch (error) { unavailable(path, error) }
  }
  // Only correlate a VM log if the caller provided a topology-derived UUID.
  for (const device of devices) {
    if (device.model && !/^USG/iu.test(device.model)) continue
    const uuid = String(device.id ?? '')
    if (!/^[A-F\d-]{36}$/iu.test(uuid)) continue
    const directory = join(root, 'VBoxServer', 'devices', uuid)
    let names
    try { names = await readdir(directory) }
    catch (error) { unavailable(directory, error, { device: device.name }); continue }
    if (!names.some(name => /^vfw_usg_Clone_/iu.test(name))) unavailable(directory, { code: 'NO_MATCHING_VM_LOGS' }, { device: device.name })
    for (const name of names) {
      if (!/^vfw_usg_Clone_/iu.test(name)) continue
      const path = join(directory, name, 'Logs', 'VBox.log')
      try { result.push({ path, device: device.name, ...await readLogTail(path) }) } catch (error) { unavailable(path, error, { device: device.name }) }
    }
  }
  return result
}
