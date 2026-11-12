import { createConnection, isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Resolver } from 'node:dns/promises'
import { createHash } from 'node:crypto'
import { createRedactor, redactValue } from './redaction.js'

const integer = (value, min, max, label) => {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be ${min}..${max}`)
  return value
}
function keys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`invalid ${label} fields`)
}
const host = value => typeof value === 'string' && value.length <= 253 && (isIP(value) || /^(?=.{1,253}$)[a-z\d](?:[a-z\d.-]*[a-z\d])?$/iu.test(value))

export function validateServicePlan(plan) {
  keys(plan, ['title', 'vantage', 'targets', 'rounds', 'interval_ms', 'timeout_ms'], 'plan')
  if (plan.vantage !== 'host') throw new Error('vantage must explicitly be host; probes do not originate from an eNSP PC')
  if (!Array.isArray(plan.targets) || !plan.targets.length || plan.targets.length > 32) throw new Error('targets must contain 1..32 endpoints')
  if (plan.title !== undefined && (typeof plan.title !== 'string' || !plan.title.trim())) throw new Error('title must be a nonempty string')
  const rounds = integer(plan.rounds ?? 1, 1, 120, 'rounds')
  const interval_ms = integer(plan.interval_ms ?? 1000, 0, 30000, 'interval_ms')
  const timeout_ms = integer(plan.timeout_ms ?? 5000, 10, 30000, 'timeout_ms')
  if (rounds * plan.targets.length * timeout_ms + (rounds - 1) * interval_ms > 600000) throw new Error('plan worst-case runtime exceeds ten minutes')
  const names = new Set()
  const targets = plan.targets.map(target => {
    keys(target, ['name', 'kind', 'host', 'port', 'url', 'expect_status', 'expect_body', 'server', 'rrtype', 'query', 'expect_addresses', 'path', 'anonymous', 'expect_sha256'], 'target')
    if (typeof target.name !== 'string' || !/^[\w-]{1,64}$/u.test(target.name) || names.has(target.name)) throw new Error('target names must be unique simple identifiers')
    names.add(target.name)
    const allowed = { http: ['url', 'expect_status', 'expect_body'], dns: ['server', 'port', 'rrtype', 'query', 'expect_addresses'], tcp: ['host', 'port'], ftp: ['host', 'port', 'path', 'anonymous', 'expect_sha256'] }[target.kind]
    if (!allowed || Object.keys(target).some(key => !['name', 'kind', ...allowed].includes(key))) throw new Error('target fields must match kind http/dns/tcp/ftp')
    if (target.kind === 'http') {
      const url = new URL(target.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('HTTP requires a credential-free http/https URL without fragment')
      if ([...url.searchParams.keys()].some(key => /token|password|secret|key|auth/iu.test(key))) throw new Error('HTTP URL must not contain credential query parameters')
      integer(target.expect_status ?? 200, 100, 599, 'expect_status')
      if (target.expect_body !== undefined && (typeof target.expect_body !== 'string' || !target.expect_body.length)) throw new Error('expect_body must be nonempty text')
    } else if (target.kind === 'dns') {
      if (!isIP(target.server) || !host(target.query) || !['A', 'AAAA'].includes(target.rrtype ?? 'A')) throw new Error('DNS requires a server IP, query and A/AAAA rrtype')
      integer(target.port ?? 53, 1, 65535, 'port')
      const family = (target.rrtype ?? 'A') === 'A' ? 4 : 6
      if (!Array.isArray(target.expect_addresses) || !target.expect_addresses.length || target.expect_addresses.some(ip => isIP(ip) !== family)) throw new Error('DNS requires expected addresses matching rrtype')
    } else {
      if (!host(target.host)) throw new Error('invalid endpoint host')
      integer(target.port ?? (target.kind === 'ftp' ? 21 : 0), 1, 65535, 'port')
      if (target.kind === 'ftp' && (target.anonymous !== true || typeof target.path !== 'string' || !/^\/[\x20-\x7e]+$/u.test(target.path)
        || !/^[a-f\d]{64}$/iu.test(target.expect_sha256 ?? ''))) throw new Error('FTP requires explicit anonymous:true, absolute ASCII download path and expect_sha256')
    }
    return { ...target }
  })
  return { title: plan.title ?? 'Service acceptance', vantage: 'host', rounds, interval_ms, timeout_ms, targets }
}

function connect(hostname, port, remaining) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: hostname, port })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('TCP connection timeout')) }, remaining())
    socket.once('error', error => { clearTimeout(timer); reject(error) })
    socket.once('connect', () => { clearTimeout(timer); resolve(socket) })
  })
}

async function httpProbe(target, timeout) {
  return new Promise((resolve, reject) => {
    const url = new URL(target.url)
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: 'GET', agent: false }, response => {
      let bytes = 0, body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > 1048576) request.destroy(new Error('HTTP response exceeds 1 MiB evidence limit'))
        else body += chunk
      })
      response.on('error', reject)
      response.on('end', () => {
        clearTimeout(timer)
        resolve({ pass: response.statusCode === (target.expect_status ?? 200) && (target.expect_body === undefined || body.includes(target.expect_body)),
          evidence: { status: response.statusCode, bytes, body_matched: target.expect_body === undefined ? null : body.includes(target.expect_body) } })
      })
    })
    const timer = setTimeout(() => request.destroy(new Error('HTTP timeout')), timeout)
    request.on('error', error => { clearTimeout(timer); reject(error) })
    request.end()
  })
}

async function dnsProbe(target, timeout) {
  const resolver = new Resolver({ timeout, tries: 1 })
  resolver.setServers([`${isIP(target.server) === 6 ? `[${target.server}]` : target.server}:${target.port ?? 53}`])
  const timer = setTimeout(() => resolver.cancel(), timeout)
  try {
    const addresses = (target.rrtype ?? 'A') === 'A' ? await resolver.resolve4(target.query) : await resolver.resolve6(target.query)
    const canonical = ip => new URL(`http://${isIP(ip) === 6 ? `[${ip}]` : ip}`).hostname
    return { pass: target.expect_addresses.every(ip => addresses.map(canonical).includes(canonical(ip))), evidence: { addresses } }
  } finally { clearTimeout(timer) }
}

async function ftpProbe(target, timeout) {
  const deadline = Date.now() + timeout
  const remaining = () => Math.max(1, deadline - Date.now())
  const control = await connect(target.host, target.port ?? 21, remaining)
  let dataSocket, timer, pending = '', multiline = null, waiter, terminalError, controlBytes = 0
  const replies = []
  const fail = error => { terminalError = error; waiter?.reject(error); waiter = null }
  const accept = reply => { if (waiter) { const current = waiter; waiter = null; current.resolve(reply) } else replies.push(reply) }
  control.on('data', chunk => {
    controlBytes += chunk.length
    if (controlBytes > 65536) { control.destroy(new Error('FTP control response exceeds limit')); return }
    pending += chunk.toString('utf8')
    if (pending.length > 65536) { control.destroy(new Error('FTP control response exceeds limit')); return }
    while (pending.includes('\n')) {
      const end = pending.indexOf('\n'), line = pending.slice(0, end).replace(/\r$/u, '')
      pending = pending.slice(end + 1)
      if (multiline !== null) { if (line.startsWith(`${multiline} `)) { accept({ code: Number(multiline), line }); multiline = null } }
      else if (/^\d{3}-/u.test(line)) multiline = line.slice(0, 3)
      else if (/^\d{3} /u.test(line)) accept({ code: Number(line.slice(0, 3)), line })
    }
  })
  control.on('error', fail)
  control.on('close', () => fail(new Error('FTP control connection closed')))
  const next = () => terminalError ? Promise.reject(terminalError) : replies.length ? Promise.resolve(replies.shift()) : new Promise((resolve, reject) => { waiter = { resolve, reject } })
  const command = async (line, codes) => {
    if (line) control.write(`${line}\r\n`)
    const reply = await next()
    if (!codes.includes(reply.code)) throw new Error(`FTP unexpected reply ${reply.code}`)
    return reply
  }
  timer = setTimeout(() => { control.destroy(new Error('FTP transfer timeout')); dataSocket?.destroy() }, remaining())
  try {
    await command(null, [220])
    if ((await command('USER anonymous', [230, 331])).code === 331) await command('PASS ensp-acceptance@localhost', [230])
    await command('TYPE I', [200])
    const passive = await command('EPSV', [229, 500, 502, 522])
    let port
    if (passive.code === 229) port = Number(/\(\|\|\|(\d+)\|\)/u.exec(passive.line)?.[1])
    else {
      const reply = await command('PASV', [227])
      const tuple = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/u.exec(reply.line)?.slice(1).map(Number)
      if (!tuple || tuple.some(n => n > 255) || tuple.slice(0, 4).join('.') !== control.remoteAddress?.replace(/^::ffff:/u, '')) throw new Error('FTP passive address differs from the control peer')
      port = tuple[4] * 256 + tuple[5]
    }
    integer(port, 1, 65535, 'FTP passive port')
    dataSocket = await connect(control.remoteAddress, port, remaining)
    let bytes = 0
    const hash = createHash('sha256')
    const downloaded = new Promise((resolve, reject) => {
      dataSocket.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 1048576) dataSocket.destroy(new Error('FTP download exceeds 1 MiB limit'))
        else hash.update(chunk)
      })
      dataSocket.once('error', reject)
      dataSocket.once('end', resolve)
      dataSocket.once('close', hadError => { if (hadError || !dataSocket.readableEnded) reject(new Error('FTP data connection interrupted')) })
    })
    downloaded.catch(() => {})
    await command(`RETR ${target.path}`, [125, 150])
    await downloaded
    await command(null, [226, 250])
    await command('QUIT', [221])
    const sha256 = hash.digest('hex')
    return { pass: sha256 === target.expect_sha256.toLowerCase(), evidence: { bytes, sha256, transfer_complete: true } }
  } finally { clearTimeout(timer); dataSocket?.destroy(); control.destroy() }
}

export async function probeService(target, timeout) {
  if (target.kind === 'http') return httpProbe(target, timeout)
  if (target.kind === 'dns') return dnsProbe(target, timeout)
  if (target.kind === 'ftp') return ftpProbe(target, timeout)
  const socket = await connect(target.host, target.port, () => timeout)
  socket.destroy()
  return { pass: true, evidence: { connected: true, application_verified: false } }
}

export async function runServiceTest(input, { probe = probeService, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const plan = validateServicePlan(input), started = Date.now(), rows = []
  for (let round = 1; round <= plan.rounds; round++) {
    for (const target of plan.targets) {
      const at = new Date().toISOString(), before = Date.now()
      try {
    const result = await probe(target, plan.timeout_ms)
        rows.push({ round, target: target.name, kind: target.kind, at, elapsed_ms: Date.now() - before, status: result.pass ? 'PASS' : 'FAIL', evidence: result.evidence })
      } catch (error) { rows.push({ round, target: target.name, kind: target.kind, at, elapsed_ms: Date.now() - before, status: 'ERROR', error: error.code ?? error.message }) }
    }
    if (round < plan.rounds) await sleep(plan.interval_ms)
  }
  const recoveries = []
  for (const target of plan.targets) {
    let failedAt = null, consecutive = 0, longest = 0
    for (const row of rows.filter(row => row.target === target.name)) {
      if (row.status !== 'PASS') { failedAt ??= row.at; longest = Math.max(longest, ++consecutive) }
      else if (failedAt) { recoveries.push({ target: target.name, first_failed_at: failedAt, recovered_at: row.at, sampled_recovery_ms: Date.parse(row.at) - Date.parse(failedAt) }); failedAt = null; consecutive = 0 }
    }
    if (failedAt) recoveries.push({ target: target.name, first_failed_at: failedAt, recovered_at: null, sampled_recovery_ms: null })
    for (const recovery of recoveries.filter(row => row.target === target.name)) recovery.max_consecutive_failures = longest
  }
  return redactValue({ title: plan.title, vantage: 'host', timestamp: new Date(started).toISOString(), elapsed_ms: Date.now() - started,
    ok: rows.every(row => row.status === 'PASS'), counts: { total: rows.length, pass: rows.filter(row => row.status === 'PASS').length, fail: rows.filter(row => row.status === 'FAIL').length, error: rows.filter(row => row.status === 'ERROR').length }, rows, recoveries,
    notes: ['Probes originate from the host OS, not an eNSP guest. No configuration or failover trigger is sent.', 'Sampled recovery intervals include probe/scheduling time; they are not precise failover RTO measurements. HTTP redirects are not followed; FTP is anonymous binary download with SHA256 verification.'] }, createRedactor())
}

export function renderServiceReports(result) {
  const cell = value => `"${String(value ?? '').replace(/^[=+@-]/u, "'$&").replace(/"/gu, '""')}"`
  return { json: `${JSON.stringify(result, null, 2)}\n`,
    md: `# Service acceptance\n\nVantage: host; PASS ${result.counts.pass}, FAIL ${result.counts.fail}, ERROR ${result.counts.error}\n\n| Round | Target | Kind | Status | Elapsed ms |\n| --- | --- | --- | --- | --- |\n${result.rows.map(row => `| ${row.round} | ${row.target} | ${row.kind} | ${row.status} | ${row.elapsed_ms} |`).join('\n')}\n`,
    csv: `round,target,kind,status,at,elapsed_ms,error\r\n${result.rows.map(row => [row.round, row.target, row.kind, row.status, row.at, row.elapsed_ms, row.error].map(cell).join(',')).join('\r\n')}\r\n` }
}
