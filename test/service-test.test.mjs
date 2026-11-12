import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer as httpServer } from 'node:http'
import { createServer as tcpServer } from 'node:net'
import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runServiceTest, validateServicePlan } from '../lib/service-test.js'
import { createRegistry } from '../mcp/server.js'

async function listen(t, server) {
  const sockets = new Set()
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) })
  return server.address().port
}
const plan = targets => ({ vantage: 'host', targets, timeout_ms: 1000 })

test('HTTP content, explicit DNS server and FTP file SHA256 are verified over real sockets', async t => {
  const port = await listen(t, httpServer((request, response) => { response.writeHead(200); response.end('enterprise-service-ok') }))
  const dns = createSocket('udp4')
  dns.on('message', (query, peer) => {
    let end = 12
    while (query[end]) end += query[end] + 1
    end += 5
    const header = Buffer.from(query.subarray(0, 12))
    header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 6)
    dns.send(Buffer.concat([header, query.subarray(12, end), Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 0, 2, 10])]), peer.port, peer.address)
  })
  dns.bind(0, '127.0.0.1'); await once(dns, 'listening'); t.after(() => dns.close())
  const payload = Buffer.from('read-only FTP acceptance payload')
  let dataPeer
  const dataPort = await listen(t, tcpServer(socket => { dataPeer = socket }))
  const seen = []
  const ftpPort = await listen(t, tcpServer(socket => {
    socket.write('220-test server\r\n220 Ready\r\n')
    let pending = ''
    socket.on('data', chunk => {
      pending += chunk
      while (pending.includes('\r\n')) {
        const end = pending.indexOf('\r\n'), command = pending.slice(0, end); pending = pending.slice(end + 2); seen.push(command)
        if (command === 'USER anonymous') socket.write('331 Password required\r\n')
        else if (command.startsWith('PASS ')) socket.write('230 Logged in\r\n')
        else if (command === 'TYPE I') socket.write('200 Binary\r\n')
        else if (command === 'EPSV') socket.write(`229 Entering Extended Passive Mode (|||${dataPort}|)\r\n`)
        else if (command === 'RETR /probe.txt') { socket.write('150 Transfer\r\n'); dataPeer.end(payload); dataPeer.once('close', () => socket.write('226 Complete\r\n')) }
        else if (command === 'QUIT') socket.write('221 Bye\r\n')
      }
    })
  }))
  const result = await runServiceTest(plan([
    { name: 'web', kind: 'http', url: `http://127.0.0.1:${port}/`, expect_body: 'service-ok' },
    { name: 'dns', kind: 'dns', server: '127.0.0.1', port: dns.address().port, query: 'lab.test', expect_addresses: ['192.0.2.10'] },
    { name: 'ftp', kind: 'ftp', host: '127.0.0.1', port: ftpPort, path: '/probe.txt', anonymous: true, expect_sha256: createHash('sha256').update(payload).digest('hex') },
  ]))
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.counts.pass, 3)
  assert.equal(result.rows[2].evidence.bytes, payload.length)
  assert.ok(seen.every(command => /^(USER|PASS|TYPE|EPSV|RETR|QUIT)\b/u.test(command)))
  const mismatched = await runServiceTest(plan([
    { name: 'dns-mismatch', kind: 'dns', server: '127.0.0.1', port: dns.address().port, query: 'lab.test', expect_addresses: ['192.0.2.99'] },
    { name: 'ftp-mismatch', kind: 'ftp', host: '127.0.0.1', port: ftpPort, path: '/probe.txt', anonymous: true, expect_sha256: '0'.repeat(64) },
  ]))
  assert.deepEqual(mismatched.rows.map(row => row.status), ['FAIL', 'FAIL'])
})

test('FTP rejects passive endpoint redirection and refuses write/authenticated plans before connecting', async t => {
  let transfers = 0
  const port = await listen(t, tcpServer(socket => {
    socket.write('220 Ready\r\n')
    let pending = ''
    socket.on('data', chunk => {
      pending += chunk
      while (pending.includes('\r\n')) {
        const end = pending.indexOf('\r\n'), command = pending.slice(0, end); pending = pending.slice(end + 2)
        if (command.startsWith('USER')) socket.write('230 Logged in\r\n')
        else if (command === 'TYPE I') socket.write('200 Binary\r\n')
        else if (command === 'EPSV') socket.write('500 No EPSV\r\n')
        else if (command === 'PASV') socket.write('227 Passive (192,0,2,99,20,20)\r\n')
        else if (command.startsWith('RETR')) transfers++
      }
    })
  }))
  const target = { name: 'ftp', kind: 'ftp', host: '127.0.0.1', port, path: '/probe.txt', anonymous: true, expect_sha256: '0'.repeat(64) }
  const result = await runServiceTest(plan([target]))
  assert.equal(result.rows[0].status, 'ERROR')
  assert.match(result.rows[0].error, /passive address/)
  assert.equal(transfers, 0)
  assert.throws(() => validateServicePlan(plan([{ ...target, username: 'admin' }])), /invalid target/)
})

test('HTTP redirects are not followed, content mismatch fails, silent response times out', async t => {
  let redirected = 0
  const port = await listen(t, httpServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { Location: '/next' }); response.end() }
    else if (request.url === '/silent') return
    else { redirected++; response.end('wrong') }
  }))
  const result = await runServiceTest({ ...plan([
    { name: 'redirect', kind: 'http', url: `http://127.0.0.1:${port}/redirect` },
    { name: 'body', kind: 'http', url: `http://127.0.0.1:${port}/next`, expect_body: 'expected' },
    { name: 'timeout', kind: 'http', url: `http://127.0.0.1:${port}/silent` },
  ]), timeout_ms: 100 })
  assert.deepEqual(result.rows.map(row => row.status), ['FAIL', 'FAIL', 'ERROR'])
  assert.equal(redirected, 1)
})

test('whole service plan validates before probes; repeated sampling retains failures and recovery', async () => {
  let contacted = false
  await assert.rejects(runServiceTest(plan([{ name: 'good', kind: 'tcp', host: '127.0.0.1', port: 80 },
    { name: 'bad', kind: 'ftp', host: '127.0.0.1', path: '/bad\r\nDELE /file', anonymous: true }]), { probe() { contacted = true } }), /FTP requires/)
  assert.equal(contacted, false)
  let count = 0
  const result = await runServiceTest({ ...plan([{ name: 'web', kind: 'http', url: 'http://127.0.0.1/' }]), rounds: 4, interval_ms: 0 }, {
    probe: async () => ({ pass: ++count !== 2, evidence: {} }), sleep: async () => {},
  })
  assert.equal(result.ok, false)
  assert.equal(result.counts.fail, 1)
  assert.equal(result.recoveries.length, 1)
  assert.ok(result.recoveries[0].recovered_at)
  assert.throws(() => validateServicePlan({ ...plan([]), vantage: 'ensp-pc' }), /vantage/)
  assert.throws(() => validateServicePlan(plan([{ name: 'web', kind: 'http', url: 'http://user:pass@localhost/' }])), /credential-free/)
})

test('service tool reserves evidence before probes and confines input/output junctions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ensp-services-')), outside = await mkdtemp(join(tmpdir(), 'ensp-outside-'))
  t.after(() => rm(root, { recursive: true, force: true })); t.after(() => rm(outside, { recursive: true, force: true }))
  let requests = 0
  const port = await listen(t, httpServer((request, response) => { requests++; response.end('ok') }))
  await writeFile(join(root, 'plan.json'), JSON.stringify(plan([{ name: 'web', kind: 'http', url: `http://127.0.0.1:${port}/` }])))
  const registry = createRegistry({ workspace: root }), tool = registry.tools.find(tool => tool.name === 'ensp_services')
  const call = args => tool.handler(args, registry.exec)
  const result = await call({ plan_path: 'plan.json', report_prefix: 'service' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(JSON.parse(await readFile(join(root, 'service.json'), 'utf8')).vantage, 'host')
  assert.equal((await call({ plan_path: 'plan.json', report_prefix: 'service' })).ok, false)
  assert.equal(requests, 1)
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await call({ plan_path: 'plan.json', report_prefix: 'escape/report' })).ok, false)
  assert.equal(requests, 1)
})
