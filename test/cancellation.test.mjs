import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { VrpSession } from '../lib/cli.js'
import { Bridge, runProcess } from '../lib/bridge-client.js'
import { instrumentTool } from '../lib/operation-context.js'
import { executionOptions } from '../lib/execution-control.js'
import { createRegistry, createMcpServer } from '../mcp/server.js'
import { runAcceptance } from '../lib/acceptance-runner.js'
import { waitDevicesReady } from '../lib/device-ready.js'

function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('helper cancellation waits for process exit before returning and closes inherited output files', { timeout: 5000 }, async t => {
  const caller = new AbortController(), root = await mkdtemp(join(tmpdir(), 'ensp-helper-cancel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ready = join(root, 'ready.json')
  const pending = runProcess(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)", ready], { signal: caller.signal, timeoutMs: 4000 })
  let pid
  for (let i = 0; i < 200 && !pid; i++) { try { pid = JSON.parse(await readFile(ready, 'utf8')).pid } catch { await delay(10) } }
  assert(Number.isSafeInteger(pid), 'helper must be running before cancellation')
  caller.abort()
  assert.equal((await pending).code, -1)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})
async function tcpPeer(t, handler) {
  const sockets = new Set(), seen = []
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
    let pending = ''
    socket.on('data', chunk => {
      pending += chunk
      while (pending.includes('\r')) {
        const end = pending.indexOf('\r'), line = pending.slice(0, end); pending = pending.slice(end + 1)
        seen.push(line); handler(line, socket)
      }
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { for (const s of sockets) s.destroy(); await new Promise(r => server.close(r)) })
  return { port: server.address().port, seen }
}

test('cancellation before dispatch opens no console; lost command response stays unconfirmed without replay', async t => {
  const caller = new AbortController()
  const peer = await tcpPeer(t, (line, socket) => { if (!line) socket.write('<R1>'); else caller.abort() })
  const tool = createRegistry({ overrides: { diagnosticLogging: false } }).tools.find(t => t.name === 'ensp_cli')
  const early = new AbortController(); early.abort()
  const skipped = await tool.handler({ port: peer.port, commands: ['sysname R2'] }, { signal: early.signal })
  assert.equal(skipped.execution.status, 'cancelled'); assert.equal(skipped.execution.stop_confirmed, true)
  assert.deepEqual(peer.seen, [])
  const result = await tool.handler({ port: peer.port, commands: ['sysname R2', 'vlan 999'], save: false }, { signal: caller.signal })
  assert.equal(result.execution.status, 'unconfirmed'); assert.equal(result.execution.may_have_applied, true)
  assert.equal(result.execution.stop_confirmed, false); assert.deepEqual(peer.seen, ['', 'sysname R2'])
  assert.equal(result.ok, false)
})

test('cancellation between commands confirms stop and releases the console after socket closure', async t => {
  const caller = new AbortController()
  const peer = await tcpPeer(t, (_, socket) => socket.write('<R1>'))
  const tool = instrumentTool({ name: 'ensp_cli', async execute(args, exec) {
    const session = new VrpSession({ ...executionOptions(exec), port: args.port })
    try { await session.open(); return await session.run(['first', 'never'], { afterCommand: () => caller.abort() }) }
    finally { session.close() }
  } }, { diagnosticLogging: false })
  const result = await tool.execute({ port: peer.port }, { signal: caller.signal })
  assert.equal(result.execution.status, 'cancelled'); assert.equal(result.execution.stop_confirmed, true)
  assert.deepEqual(peer.seen, ['', 'first'])
  await delay(10)
  const replacement = new VrpSession({ port: peer.port })
  try { await replacement.open() } finally { replacement.close() }
})

test('one total deadline bounds multiple command waits and blocks the unsent suffix', async t => {
  const peer = await tcpPeer(t, (line, socket) => { if (!line) socket.write('<R1>'); else if (line === 'first') setTimeout(() => socket.write('<R1>'), 70) })
  const tool = instrumentTool({ name: 'ensp_cli', async execute(args, exec) {
    const session = new VrpSession({ ...executionOptions(exec), port: args.port, commandTimeoutMs: 5000 })
    try { await session.open(); return await session.run(['first', 'second', 'never']) } finally { session.close() }
  } }, { diagnosticLogging: false, timeoutMs: 500 })
  const started = performance.now(), result = await tool.execute({ port: peer.port })
  assert(performance.now() - started < 1200)
  assert.equal(result.ok, false); assert.equal(result.execution.status, 'unconfirmed')
  assert.deepEqual(peer.seen, ['', 'first', 'second'])
})

test('MCP cancellation targets one request and removes mappings on every outcome', async () => {
  const server = createMcpServer({ quiet: true, overrides: { diagnosticLogging: false } }), entered = deferred(), answers = []
  const tool = server.registry.tools.find(t => t.name === 'ensp_cli')
  tool.handler = instrumentTool({ name: 'ensp_cli', async execute(_, exec) {
    entered.resolve(); await new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true })); exec.operation.control.check()
  } }, { diagnosticLogging: false }).execute
  const active = server.handleMessage({ id: 41, method: 'tools/call', params: { name: 'ensp_cli' } }, r => answers.push(r))
  await entered.promise
  await server.handleMessage({ method: 'notifications/cancelled', params: { requestId: 99 } }, () => assert.fail('notification replied'))
  assert.equal(server.activeRequestCount(), 1)
  await server.handleMessage({ method: 'notifications/cancelled', params: { requestId: 41 } }, () => assert.fail('notification replied'))
  await active
  assert.equal(answers.length, 1); assert.equal(answers[0].result.isError, true)
  assert.equal(JSON.parse(answers[0].result.content[0].text).execution.status, 'cancelled')
  assert.equal(server.activeRequestCount(), 0)
})

test('real MCP stdio cancellation bypasses a blocked call and cancels a queued call before dispatch', { timeout: 5000 }, async t => {
  const first = deferred()
  const peer = await tcpPeer(t, (line, socket) => { if (!line) socket.write('<R1>'); else first.resolve() })
  const child = spawn(process.execPath, ['bin/dsh-ensp-mcp.mjs', '--workspace', process.cwd()], { windowsHide: true,
    env: { ...process.env, ENSP_FUSION_DIAGNOSTICS: 'off' }, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  const lines = [], done = deferred(); let buffer = ''
  child.stdout.on('data', chunk => { buffer += chunk; while (buffer.includes('\n')) { const end = buffer.indexOf('\n'); lines.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); if (lines.length === 2) done.resolve() } })
  child.stderr.resume()
  const send = value => child.stdin.write(JSON.stringify(value) + '\n')
  const call = id => ({ id, method: 'tools/call', params: { name: 'ensp_cli', arguments: { port: peer.port, commands: ['first', 'never'], save: false } } })
  send(call(1)); send(call(2)); await first.promise
  send({ method: 'notifications/cancelled', params: { requestId: 2 } }); send({ method: 'notifications/cancelled', params: { requestId: 1 } })
  await done.promise
  assert.equal(lines[0].result.isError, true); assert.equal(lines[1].result.isError, true)
  assert.deepEqual(peer.seen, ['', 'first'])
  assert.equal(JSON.parse(lines[1].result.content[0].text).execution.status, 'cancelled')
  child.stdin.end(); await once(child, 'close')
})

test('unconfirmed action blocks every armed cleanup; confirmed cancellation cleanup gets a separate bounded signal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ensp-cancel-accept-')); t.after(() => rm(root, { recursive: true, force: true }))
  const plan = { version: 1, deadline_ms: 1000, cleanup_deadline_ms: 80, steps: [{ name: 'change', tool: 'cli', args: {}, cleanup: { tool: 'undo', args: {} } }] }
  const seen = []
  const uncertain = await runAcceptance({ plan, outputRoot: root, tools: ['cli','undo'], execute: async name => { seen.push(name); return { ok: false, execution: { schema_version: 1, status: 'unconfirmed' } } } })
  assert.deepEqual(seen, ['cli']); assert.equal(uncertain.status, 'UNCONFIRMED')
  assert.equal(uncertain.cleanup[0].status, 'SKIPPED_UNCONFIRMED')
  const caller = new AbortController()
  const confirmed = await runAcceptance({ plan, outputRoot: root, tools: ['cli','undo'], signal: caller.signal, execute: async (name, _, context) => {
    if (name === 'cli') { caller.abort(); return { ok: true } }
    assert.equal(context.signal.aborted, false); assert(Number.isFinite(context.deadline))
    await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }))
    return { ok: false, execution: { schema_version: 1, status: 'cancelled' } }
  } })
  assert.equal(confirmed.status, 'CLEANUP_ERROR')
  assert.equal(JSON.parse(await readFile(join(confirmed.run_dir, 'summary.json'), 'utf8')).ok, false)
})

for (const confirms of [true, false]) test(`resident cancellation ${confirms ? 'confirms quiescence' : 'keeps stalled native call unconfirmed'} without job replay`, { timeout: 5000 }, async t => {
  const entered = deferred(), caller = new AbortController(), seen = [], sockets = new Set()
  let stopped = false, activeId
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
    let pending = ''
    socket.on('data', chunk => {
      pending += chunk; if (!pending.includes('\n')) return
      const req = JSON.parse(pending.slice(0, pending.indexOf('\n'))); seen.push(req.op)
      assert.equal(req.token, 'test-resident')
      if (req.op === 'click') { activeId = req.task_id; entered.resolve(); return }
      if (req.op === 'cancel_task') { if (confirms) setTimeout(() => { stopped = true }, 40) }
      socket.end(JSON.stringify({ ok: true, task_id: req.task_id, stop_confirmed: stopped, state: stopped ? 'cancelled' : 'running' }) + '\n')
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { for (const s of sockets) s.destroy(); await new Promise(r => server.close(r)) })
  const info = { port: server.address().port, token: 'test-resident', healthy: true }
  const bridge = new Bridge({ mode: 'auto' }, {})
  bridge.ensureServing = async () => info
  bridge.runJob = () => assert.fail('never replay a dispatched action')
  const tool = instrumentTool({ name: 'ensp_gui', execute: async (_, exec) => bridge.steps([{ op: 'click' }, { op: 'never' }], { operation: exec.operation }) }, { diagnosticLogging: false })
  const pending = tool.execute({}, { signal: caller.signal })
  await entered.promise; const start = performance.now(); caller.abort()
  const result = await pending
  assert.equal(result.execution.status, confirms ? 'cancelled' : 'unconfirmed')
  assert.equal(result.execution.stop_confirmed, confirms); assert.equal(result.execution.may_have_applied, true)
  assert(performance.now() - start < 2800)
  assert.equal(seen.filter(v => v === 'click').length, 1); assert(!seen.includes('never'))
  assert.equal(result.execution.task_refs[0].task_id, activeId)
  stopped = true
  assert.equal((await bridge.queryTask(activeId)).stop_confirmed, true)
})

test('a resident reply that explicitly lacks stop confirmation cannot release the next step or trigger fallback', async t => {
  const seen = [], sockets = new Set()
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      if (!buffer.includes('\n')) return
      const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); seen.push(request.op)
      socket.end(JSON.stringify({ ok: true, task_id: request.task_id, stop_confirmed: false, state: 'running' }) + '\n')
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) })
  const bridge = new Bridge({ mode: 'auto' }, {})
  bridge.ensureServing = async () => ({ port: server.address().port, token: 'offline-only', healthy: true })
  bridge.runJob = () => assert.fail('uncertain replies must not replay')
  const tool = instrumentTool({ name: 'ensp_gui', execute: (_, exec) => bridge.steps([{ op: 'click' }, { op: 'never' }], { operation: exec.operation }) }, { diagnosticLogging: false })
  await assert.rejects(tool.execute({}), error => {
    assert.equal(error.execution.status, 'unconfirmed'); assert.equal(error.execution.stop_confirmed, false)
    assert.equal(error.execution.task_refs.length, 1); return true
  })
  assert.deepEqual(seen, ['click'])
})

test('cancelled readiness cannot send a late command after a blocked open eventually resolves', async () => {
  const caller = new AbortController(), opened = deferred(), entered = deferred(); let commands = 0, closed = 0
  const pending = waitDevicesReady([{ name: 'R1', comPort: 12345 }], { signal: caller.signal, sessionFactory: () => ({
    open() { entered.resolve(); return opened.promise }, command() { commands++; return { ok: true } }, close() { closed++ },
  }) })
  await entered.promise; caller.abort()
  await assert.rejects(pending)
  opened.resolve(); await delay(10)
  assert.equal(commands, 0); assert(closed > 0)
})

for (const acceptance of [false, true]) test(`${acceptance ? 'acceptance' : 'tool'} CLI forwards SIGINT through its actual entry and exits after socket cleanup`, { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ensp-cli-cancel-')); t.after(() => rm(root, { recursive: true, force: true }))
  const entry = resolve(acceptance ? 'bin/ensp-fusion-accept.mjs' : 'bin/ensp-fusion.mjs')
  const bootstrap = `
import {createServer} from 'node:net';import {once} from 'node:events';import {writeFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
const seen=[], root=process.argv[1], entry=process.argv[2], acceptance=process.argv[3]==='true';
const server=createServer(socket=>{let text='';socket.on('error',()=>{});socket.on('data',chunk=>{text+=chunk;while(text.includes('\\r')){const end=text.indexOf('\\r'),line=text.slice(0,end);text=text.slice(end+1);seen.push(line);if(!line)socket.write('<R1>');else process.emit('SIGINT')}})});
server.listen(0,'127.0.0.1');await once(server,'listening');server.unref();
const args={port:server.address().port,commands:['first','never'],save:false}, path=root+'/input.json';
await writeFile(path,JSON.stringify(acceptance?{version:1,deadline_ms:3000,steps:[{name:'change',tool:'ensp_cli',args,cleanup:{tool:'ensp_cli',args:{...args,commands:['undo']}}}]}:args));
process.argv=[process.execPath,entry,...(acceptance?['run',path,root,'runs']:['call','ensp_cli',path,root])];
process.on('beforeExit',()=>{if(JSON.stringify(seen)!==JSON.stringify(['','first']))process.exitCode=97});
await import(pathToFileURL(entry));
`
  const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap, root, entry, String(acceptance)],
    { windowsHide: true, env: { ...process.env, ENSP_FUSION_DIAGNOSTICS: 'off' } })
  t.after(() => child.kill())
  let stdout = '', stderr = ''; child.stdout.on('data', c => { stdout += c }); child.stderr.on('data', c => { stderr += c })
  const [code] = await once(child, 'close')
  assert.equal(code, 130, stderr + stdout)
  const result = JSON.parse(stdout)
  assert.equal(acceptance ? result.status : result.execution.status, acceptance ? 'UNCONFIRMED' : 'unconfirmed')
  if (acceptance) assert.equal(result.cleanup[0].status, 'SKIPPED_UNCONFIRMED')
})
