/**
 * Read-only lab acceptance, with no I/O except the injected runDevice callback.
 *
 * validateLabPlan returns a detached, normalized plan or throws TypeError;
 * optional topology_path is retained for the parent to resolve (never opened).
 * runLabTest returns { title, timestamp, ok, counts, devices, rows }.
 * counts counts command rows: { total, pass, fail, error, skipped }.
 * Row statuses are PASS, FAIL (assertion mismatch), ERROR (execution/protocol
 * failure), or SKIPPED. An omitted layer is reported as null.
 * new_password is redaction-only metadata: it is NEVER sent to runDevice.
 * renderLabReports returns strings only; the caller owns paths and file writes.
 */

import { redactValue } from './redaction.js'

const LAYERS = new Set(['configuration', 'interface', 'routing', 'connectivity'])
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const DEVICE_KEYS = new Set([
  'device', 'port', 'commands', 'username', 'password', 'passwords',
  'new_password', 'command_timeout_ms',
])

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${path} must be an object`)
  }
}

function keys(value, allowed, path) {
  // Do not echo unknown keys or input values: they can contain credentials.
  if (Reflect.ownKeys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${path} contains unsupported options (mutation and echo options are forbidden)`)
  }
}

function nonempty(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${path} must be a nonempty string`)
  }
}

function patternRegex(pattern, path) {
  if (!pattern.startsWith('/')) return null
  const parts = /^\/(.*)\/([a-z]*)$/u.exec(pattern)
  if (!parts || !parts[1].trim()) throw new TypeError(`${path} has an invalid regex`)
  let regex
  try {
    regex = new RegExp(parts[1], parts[2] || 'i')
  } catch {
    throw new TypeError(`${path} has an invalid regex`)
  }
  // Empty-output assertions (e.g. /.*/) do not provide acceptance evidence.
  if (regex.test('')) throw new TypeError(`${path} regex must not match empty output`)
  regex.lastIndex = 0
  return regex
}

/** Validate the entire plan before any device is contacted. No input mutation. */
export function validateLabPlan(plan) {
  object(plan, 'plan')
  keys(plan, new Set(['title', 'topology_path', 'devices']), 'plan')
  if (plan.title !== undefined) nonempty(plan.title, 'title')
  if (plan.topology_path !== undefined && typeof plan.topology_path !== 'string') {
    throw new TypeError('topology_path must be a string')
  }
  if (!Array.isArray(plan.devices) || plan.devices.length === 0) {
    throw new TypeError('devices must be a nonempty array')
  }
  const devices = Array.from(plan.devices, (entry, deviceIndex) => {
    const path = `devices[${deviceIndex}]`
    object(entry, path)
    keys(entry, DEVICE_KEYS, path)
    if (entry.device !== undefined) nonempty(entry.device, `${path}.device`)
    if (entry.port !== undefined && (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535)) {
      throw new TypeError(`${path}.port must be an integer from 1 to 65535`)
    }
    if (entry.device === undefined && entry.port === undefined) {
      throw new TypeError(`${path} requires device or port`)
    }
    if (entry.command_timeout_ms !== undefined
      && (!Number.isSafeInteger(entry.command_timeout_ms) || entry.command_timeout_ms <= 0)) {
      throw new TypeError(`${path}.command_timeout_ms must be a positive integer`)
    }
    for (const key of ['username', 'password', 'new_password']) {
      if (entry[key] !== undefined && typeof entry[key] !== 'string') {
        throw new TypeError(`${path}.${key} must be a string`)
      }
    }
    if (entry.passwords !== undefined && (!Array.isArray(entry.passwords)
      || Array.from(entry.passwords).some((password) => typeof password !== 'string' || !password))) {
      throw new TypeError(`${path}.passwords must be an array of nonempty strings`)
    }
    if (!Array.isArray(entry.commands) || entry.commands.length === 0) {
      throw new TypeError(`${path}.commands must be a nonempty array`)
    }
    const commands = Array.from(entry.commands, (spec, commandIndex) => {
      const at = `${path}.commands[${commandIndex}]`
      object(spec, at)
      keys(spec, new Set(['cmd', 'expect', 'layer']), at)
      nonempty(spec.cmd, `${at}.cmd`)
      // Literal ASCII space is the only command separator. Reject shell/CLI
      // chaining and redirection, including VRP's file-writing pipe operators.
      if (CONTROL.test(spec.cmd) || !/^(display|ping|tracert)(?: +|$)/iu.test(spec.cmd.trim())
        || /^display +diagnostic-information(?: +|$)/iu.test(spec.cmd.trim())
        || /[;|&<>`]/u.test(spec.cmd) || /\$\(/u.test(spec.cmd)) {
        throw new TypeError(`${at}.cmd must be a single read-only display, ping, or tracert command`)
      }
      if (spec.layer !== undefined && !LAYERS.has(spec.layer)) {
        throw new TypeError(`${at}.layer is invalid`)
      }
      const expect = Array.isArray(spec.expect) ? Array.from(spec.expect) : [spec.expect]
      if (expect.length === 0) throw new TypeError(`${at}.expect must be nonempty`)
      expect.forEach((pattern, index) => {
        nonempty(pattern, `${at}.expect[${index}]`)
        patternRegex(pattern, `${at}.expect[${index}]`)
      })
      return { cmd: spec.cmd.trim(), expect, ...(spec.layer === undefined ? {} : { layer: spec.layer }) }
    })
    return { ...entry, ...(entry.passwords === undefined ? {} : { passwords: [...entry.passwords] }), commands }
  })
  return { title: plan.title ?? 'Lab acceptance report',
    ...(plan.topology_path === undefined ? {} : { topology_path: plan.topology_path }), devices }
}

function makeRedactor(plan) {
  const secrets = [...new Set(plan.devices.flatMap((entry) => [
    entry.username, entry.password, entry.new_password, ...(entry.passwords ?? []),
  ]).filter((value) => typeof value === 'string' && value.length > 0)
    .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]))]
    .sort((a, b) => b.length - a.length)
  // A single replacement pass handles overlapping passwords and does not
  // recursively replace characters inside the redaction marker.
  const regex = secrets.length
    ? new RegExp(secrets.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'gu')
    : null
  return (value) => regex ? value.replace(regex, '[REDACTED]') : value
}

function message(value) {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try { return JSON.stringify(value) ?? String(value) } catch { return 'Unserializable executor diagnostic' }
}

function status(value) {
  const name = typeof value === 'string' ? value.toUpperCase() : ''
  if (name === 'SKIP' || name === 'SKIPPED') return 'SKIPPED'
  return ['PASS', 'FAIL', 'ERROR'].includes(name) ? name : null
}

function count(rows) {
  const counts = { total: rows.length, pass: 0, fail: 0, error: 0, skipped: 0 }
  for (const row of rows) counts[row.status.toLowerCase()] += 1
  return counts
}

function overall(rows) {
  for (const name of ['ERROR', 'FAIL', 'SKIPPED']) {
    if (rows.some((row) => row.status === name)) return name
  }
  return 'PASS'
}

function matches(actual, pattern) {
  const regex = patternRegex(pattern, 'expect')
  return regex ? regex.test(actual) : actual.toLowerCase().includes(pattern.toLowerCase())
}

/**
 * runDevice receives { device?, port?, username?, password?, passwords?,
 * command_timeout_ms?, commands: string[], expect: string[][],
 * save: false, system_view: false }. It may throw or return the runOnDevice
 * result. Execution failures are recorded and never abort subsequent devices.
 * Evidence and failure.index use zero-based command positions; legacy skipped
 * command lists describe the unexecuted suffix, not every matching command.
 */
export async function runLabTest(plan, { runDevice } = {}) {
  const validated = validateLabPlan(plan)
  if (typeof runDevice !== 'function') throw new TypeError('runDevice must be a function')
  const redact = makeRedactor(validated)
  const rows = []
  const devices = []
  const timestamp = new Date().toISOString()
  for (const entry of validated.devices) {
    const request = { commands: entry.commands.map((spec) => spec.cmd),
      expect: entry.commands.map((spec) => [...spec.expect]), save: false, system_view: false }
    for (const key of ['device', 'port', 'username', 'password', 'passwords', 'command_timeout_ms']) {
      if (entry[key] !== undefined) request[key] = Array.isArray(entry[key]) ? [...entry[key]] : entry[key]
    }
    let response
    try {
      response = await runDevice(request)
      object(response, 'executor result')
    } catch (error) {
      response = { ok: false, failure: message(error) || 'Executor threw without a diagnostic' }
    }
    const failure = response.failure ? message(response.failure) : ''
    const results = Array.isArray(response.results) ? response.results : []
    const checks = Array.isArray(response.checks) ? response.checks : []
    const connectFailure = response.failure?.phase === 'connect'
    let failureIndex = Number.isInteger(response.failure?.index)
      && response.failure.index >= 0 && response.failure.index < entry.commands.length
      ? response.failure.index : -1
    if (failure && failureIndex < 0) {
      failureIndex = entry.commands.findIndex((spec, index) =>
        (results[index]?.command === spec.cmd
          && (results[index].ok === false || status(results[index].status) === 'ERROR'))
        || (checks[index]?.command === spec.cmd && status(checks[index].status) === 'ERROR'))
      // A thrown command can be absent from results. The first unconfirmed
      // position is the failure; later unexecuted positions are skipped.
      if (failureIndex < 0 && results.length < entry.commands.length
        && status(checks[results.length]?.status) !== 'SKIPPED') failureIndex = results.length
    }
    const skipped = Array.isArray(response.skipped) ? response.skipped : []
    const skippedIndexes = new Set(skipped.flatMap((item) => {
      const index = typeof item === 'number' ? item : item?.index
      return Number.isInteger(index) && index >= 0 ? [index] : []
    }))
    const trailingSkipped = skipped.filter((item) => typeof item === 'string'
      || (item && typeof item.command === 'string' && item.index === undefined)).length
    const device = redact(entry.device ?? (typeof response.device === 'string' ? response.device : '')) || null
    const port = entry.port ?? (Number.isInteger(response.port) ? response.port : null)
    const deviceRows = entry.commands.map((spec, index) => {
      const output = results[index]
      const check = checks[index]
      const alignedOutput = output && output.command === spec.cmd
      const alignedCheck = check && check.command === spec.cmd
      const actual = alignedOutput && typeof output.output === 'string' ? output.output : ''
      const checkStatus = alignedCheck ? status(check.status) : null
      const outputStatus = alignedOutput ? status(output.status) : null
      let rowStatus
      let error = ''
      let missing = []
      if (connectFailure) {
        // Even when the parent lists every command as skipped, a connection
        // failure is a device error. Attribute it to the first command row.
        rowStatus = index === 0 ? 'ERROR' : 'SKIPPED'
        error = failure
      } else if (checkStatus === 'ERROR' || outputStatus === 'ERROR' || index === failureIndex) {
        rowStatus = 'ERROR'
        error = message(check?.error || output?.error || failure) || 'Executor reported an error'
      } else if (checkStatus === 'SKIPPED' || outputStatus === 'SKIPPED'
        || (!alignedOutput && !alignedCheck && (response.skipped === true
          || skippedIndexes.has(index)
          || (index >= results.length && (index >= entry.commands.length - trailingSkipped
            || (failureIndex >= 0 && index > failureIndex)))))) {
        rowStatus = 'SKIPPED'
        error = message(check?.error || check?.reason) || failure
      } else if (!alignedOutput || typeof output.output !== 'string' || output.ok === false) {
        rowStatus = 'ERROR'
        error = message(output?.error) || failure || 'Command output missing, misaligned, or unsuccessful'
      } else if (!alignedCheck || typeof check.pass !== 'boolean' || !Array.isArray(check.missing)
        || (check.status !== undefined && checkStatus === null)) {
        rowStatus = 'ERROR'
        error = failure || 'Required assertion check missing or invalid'
      } else {
        missing = spec.expect.filter((pattern) => !matches(actual, pattern))
        rowStatus = check.pass && check.missing.length === 0 && missing.length === 0
          && checkStatus !== 'FAIL' && outputStatus !== 'FAIL' ? 'PASS' : 'FAIL'
        // Keep missing patterns from the executor too, without copying arbitrary
        // executor properties (which may contain login credentials).
        missing = [...new Set([...missing, ...check.missing.map(message)])]
      }
      return { layer: spec.layer ?? null, device, port, command: redact(spec.cmd),
        expected: spec.expect.map(redact), actual: redact(actual), status: rowStatus,
        missing: missing.map(redact), error: redact(error) }
    })
    // An unexplained aggregate failure must not become a passing report merely
    // because all command-level checks happen to claim success.
    if ((response.ok === false || failure) && deviceRows.every((row) => row.status === 'PASS')) {
      for (const row of deviceRows) {
        row.status = 'ERROR'
        row.error = 'Executor reported failure despite passing command checks'
      }
    }
    const notes = (Array.isArray(response.notes) ? response.notes : response.notes == null ? [] : [response.notes])
      .map((note) => redact(message(note)))
    devices.push({ device, port, status: overall(deviceRows), counts: count(deviceRows), notes,
      error: redact(failure) })
    rows.push(...deviceRows)
  }
  return redactValue({ title: redact(validated.title), timestamp, ok: rows.every((row) => row.status === 'PASS'),
    counts: count(rows), devices, rows })
}

function markdown(value) {
  return String(value ?? '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/[\\`*_{}\[\]()#!|~]/gu, '\\$&').replace(/\r\n|\r|\n/gu, '<br>')
}

function csv(value) {
  let text = String(value ?? '')
  // Quote CSV syntax AND neutralize spreadsheet formulas, including leading
  // whitespace/control characters that spreadsheet importers may strip.
  if (/^[=+\-@\s\p{Cc}\p{Cf}]/u.test(text)) text = `'${text}`
  return `"${text.replace(/"/gu, '""')}"`
}

/** Render a runLabTest result. All three formats include timestamp and counts. */
export function renderLabReports(result) {
  const summary = `Total: ${result.counts.total}; PASS: ${result.counts.pass}; FAIL: ${result.counts.fail}; ERROR: ${result.counts.error}; SKIPPED: ${result.counts.skipped}`
  const lines = [`# ${markdown(result.title)}`, '', `Timestamp: ${markdown(result.timestamp)}`,
    '', `Accepted: ${result.ok ? 'yes' : 'no'}`, '', summary, '',
    '| Layer | Device | Port | Command | Expected | Actual | Status | Missing | Error |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |']
  for (const row of result.rows) {
    lines.push(`| ${[row.layer, row.device, row.port, row.command, row.expected.join('\n'),
      row.actual, row.status, row.missing.join('\n'), row.error].map(markdown).join(' | ')} |`)
  }
  for (const device of result.devices) {
    lines.push('', `## ${markdown(device.device ?? 'Device')} (port ${markdown(device.port)}) — ${device.status}`)
    if (device.error) lines.push('', markdown(device.error))
    for (const note of device.notes) lines.push('', markdown(note))
  }
  // One rectangular table: metadata is repeated for portable CSV consumers.
  const csvRows = [['title', 'timestamp', 'accepted', 'total', 'pass', 'fail', 'error', 'skipped',
    'layer', 'device', 'port', 'command', 'expected', 'actual', 'status', 'missing', 'diagnostic', 'notes']]
  let rowIndex = 0
  for (const device of result.devices) {
    for (let index = 0; index < device.counts.total; index += 1) {
      const row = result.rows[rowIndex++]
      csvRows.push([result.title, result.timestamp, result.ok, result.counts.total,
        result.counts.pass, result.counts.fail, result.counts.error, result.counts.skipped,
        row.layer, row.device, row.port, row.command, row.expected.join('\n'), row.actual,
        row.status, row.missing.join('\n'), row.error, device.notes.join('\n')])
    }
  }
  return { markdown: `${lines.join('\n')}\n`, csv: `${csvRows.map((row) => row.map(csv).join(',')).join('\r\n')}\r\n`,
    json: `${JSON.stringify(result, null, 2)}\n` }
}
