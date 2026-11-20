import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createRegistry } from '../mcp/server.js'
import { Bridge } from '../lib/bridge-client.js'

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'ensp-gui-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const calls = []
  t.mock.method(Bridge.prototype, 'steps', async (steps, opts = {}) => {
    const results = []
    for (const s of steps) {
      calls.push(s)
      results.push({ ...s, ok: s.op !== 'cursor', ...(s.op === 'windows' ? { windows: [] } : {}) })
      if (s.op === 'cursor' && opts.stopOnError) break
    }
    return { steps: results }
  })
  const registry = createRegistry({ workspace })
  return { workspace, calls, run: (args) => registry.tools.find(t => t.name === 'ensp_gui').handler(args, registry.exec) }
}
test('GUI validates every topology before earlier GUI mutations', async t => {
  const f = await fixture(t)
  await writeFile(join(f.workspace, 'bad.topo'), '<topo><dev id="1" name="R1" com_port="22010"/></topo>')
  await assert.rejects(f.run({ steps: [{ op: 'click', x: 1, y: 1 }, { op: 'open', path: 'bad.topo' }] }), /invalid com_port/)
  assert.equal(f.calls.length, 0)
  await writeFile(join(f.workspace,'bad-server.topo'),'<topo><dev id="server" name="FILE-01" model="Server" settings="-domain 0 -eth -ipaddr -ipaddr 10.20.30.10"/></topo>')
  await assert.rejects(f.run({steps:[{op:'click',x:1,y:1},{op:'open',path:'bad-server.topo'}]}),/missing value for -eth/u)
  assert.equal(f.calls.length,0)
})
test('stop_all uses atomic canvas selection and validates port closure before next step', async t => {
  const f = await fixture(t)
  await writeFile(join(f.workspace, 'lab.topo'), '<topo><dev id="1" name="R1" com_port="9998"/></topo>')
  const out = await f.run({ topology_path: 'lab.topo', steps: [{ op: 'stop_all' }, { op: 'cursor' }] })
  assert.equal(out.ok, false)
  assert.equal(out.requiresCursorTakeover, true)
  assert.deepEqual(f.calls[0], { op: 'device_control', ensp: true, toolbar: [698, 56] })
  assert.equal(out.steps.find(s => s.op === 'stop_all').ok, true)
})

test('malformed native arguments block startup while still allowing a verified stop',async t=>{
 const f=await fixture(t)
 await writeFile(join(f.workspace,'damaged.topo'),'<topo><dev id="one" name="SW1" com_port="9998"/><dev id="server" name="FILE-01" model="Server" settings="-eth -ipaddr 10.20.30.10"/></topo>')
  await assert.rejects(f.run({topology_path:'damaged.topo',steps:[{op:'click',x:1,y:1},{op:'start_all'}]}),/missing value for -eth/u)
 assert.equal(f.calls.length,0)
 const stopped=await f.run({topology_path:'damaged.topo',steps:[{op:'stop_all'}]})
 assert.equal(stopped.ok,true);assert.equal(stopped.steps.find(s=>s.op==='stop_all').portStateVerified,true)
})
test('wait_ports reports failure when a supposedly stopped port remains open', async t => {
  const f = await fixture(t)
  const server = createServer(s => s.end())
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise(r => server.close(r)))
  const port = server.address().port
  const out = await f.run({ steps: [{ op: 'wait_ports', ports: [port], want: 'closed', timeout_ms: 0 }] })
  assert.equal(out.ok, false)
  assert.deepEqual(out.steps[0].missing, [port])
})
test('start_all defaults to guarded keyboard operation without pointer input', async t => {
  const f=await fixture(t)
  await writeFile(join(f.workspace,'lab.topo'),'<topo><dev id="1" name="R1" com_port="9998"/></topo>')
  const out=await f.run({topology_path:'lab.topo',steps:[{op:'start_all'},{op:'key',key:'enter'}],start_wait_ms:1})
  assert.equal(out.requiresCursorTakeover,false)
  assert.ok(f.calls.every(s=>s.op==='start_devices'))
  assert.equal(f.calls.length,1,'a timeout must not replay the start control')
  assert.equal(out.steps.find(s=>s.op==='start_all').transportReady,false)
  assert.equal(out.steps.find(s=>s.op==='start_all').attempts,1)
  assert.equal(out.steps.find(s=>s.op==='start_all').retrySuppressed,true)
  assert(out.steps.some(s=>s.op==='key'&&s.skipped))
})

test('explicit start and stop window handle never falls back to the other eNSP instance',async t=>{
 const f=await fixture(t)
 await writeFile(join(f.workspace,'lab.topo'),'<topo><dev id="1" name="R1" com_port="9998"/></topo>')
 await f.run({topology_path:'lab.topo',steps:[{op:'start_all',hwnd:123456}],start_wait_ms:1})
 assert.ok(f.calls.length>0);assert.ok(f.calls.every(s=>s.hwnd===123456&&!s.ensp))
 f.calls.length=0
 await f.run({topology_path:'lab.topo',steps:[{op:'stop_all',hwnd:123456}]})
 assert.equal(f.calls[0].hwnd,123456);assert.equal(f.calls[0].ensp,undefined)
 f.calls.length=0
  await assert.rejects(f.run({topology_path:'lab.topo',steps:[{op:'click',x:1,y:1},{op:'stop_all',hwnd:0}]}),/positive integer/)
 assert.equal(f.calls.length,0)
})

test('failed device control leaves port state explicitly unknown and skips later input', async t => {
  const f = await fixture(t)
  await writeFile(join(f.workspace, 'lab.topo'), '<topo><dev id="1" name="R1" com_port="9998"/></topo>')
  t.mock.method(Bridge.prototype, 'steps', async steps => ({ steps: steps.map(s => ({ ...s, ok: false, error: 'desktop unavailable' })) }))
  const out = await f.run({ topology_path: 'lab.topo', steps: [{ op: 'stop_all' }, { op: 'type', text: 'danger' }] })
  const stop = out.steps.find(s => s.op === 'stop_all')
  assert.equal(out.ok, false)
  assert.equal(stop.portStateVerified, false)
  assert.equal(stop.open, null)
  assert.equal(stop.missing, null)
  assert.match(stop.error, /state is unconfirmed/)
  assert(out.steps.some(s => s.op === 'type' && s.skipped))
})
test('closing an already closed console is idempotent', async t => {
  const f = await fixture(t)
  const out = await f.run({ steps: [{ op: 'close_console', device: 'R1' }] })
  assert.equal(out.ok, true)
  assert.equal(out.steps[0].alreadyClosed, true)
  assert(!f.calls.some(s => s.op === 'close'))
})

test('failed raw input skips later keystrokes and convenience operations', async t => {
  const f = await fixture(t)
  const out = await f.run({ steps: [{ op: 'cursor' }, { op: 'type', text: 'danger' }, { op: 'close_console', device: 'R1' }] })
  assert.equal(out.ok, false)
  assert.deepEqual(f.calls.map(s => s.op), ['cursor'])
  assert(out.steps.some(s => s.op === 'skipped' && s.skipped.includes('type')))
})

test('all GUI readiness inputs and control prerequisites validate before any mutation', async t => {
  const f = await fixture(t)
  for (const args of [
    { steps: [{ op: 'click' }, { op: 'start_all' }] },
    { steps: [{ op: 'click' }], ready_wait_ms: NaN },
    { steps: [{ op: 'click' }], ready_devices: [{ device: 'R1', new_password: 'secret' }] },
    { steps: [{ op: 'close_project', save: 'unknown' }] },
    { steps: [{ op: 'click' }, { op: 'select_list', index: 1, text: 'HTTP' }] },
    { steps: [{ op: 'click' }, { op: 'select_list', text: '' }] },
    { steps: [{ op: 'click' }, { op: 'select_list', index: -1 }] },
    { steps: [{ op: 'click' }, { op: 'select_list', index: 1, expected_count: 0 }] },
  ]) await assert.rejects(f.run(args))
  assert.equal(f.calls.length, 0)
})

test('late GUI argument and path errors reject the entire batch without bridge input', async t => {
  const f = await fixture(t)
  await writeFile(join(f.workspace, 'not-directory'), 'ordinary file')
  for (const step of [
    { op: 'shot', ensp: true }, { op: 'screen' }, { op: 'click', y: 2 },
    { op: 'postclick', hwnd: 1, y: 2 }, { op: 'drag', x1: 0, y1: 0, x2: 2 },
    { op: 'resize', hwnd: 1, x: 0, y: 0, w: 10 }, { op: 'type' },
    { op: 'key', key: 'Control+O' }, { op: 'key', key: 'unknown-key' },
    { op: 'screen', out: 'one.png', path: 'two.png' },
    { op: 'screen', out: '../escape.png' }, { op: 'screen', out: 'not-directory/out.png' },
    { op: 'screen', out: '.' }, { op: 'open_console', device: 'MISSING' },
    { op: 'wait_ports' }, { op: 'info' }, { op: 'not-an-op' },
  ]) {
    await assert.rejects(f.run({ steps: [{ op: 'key', key: 'enter', ensp: true }, step] }))
    assert.equal(f.calls.length, 0, JSON.stringify(step))
  }
  await assert.rejects(f.run({ steps: [{ op: 'key', key: 'enter' }, { op: 'click', y: 2 }] }), error => {
    assert.equal(error.code, 'ENSP_GUI_VALIDATION')
    assert.equal(error.stepIndex, 1)
    assert.equal(error.field, 'x')
    assert.equal(error.execution.may_have_applied, false)
    return true
  })
})

test('screenshot path alias is normalized on owned records before bridge dispatch', async t => {
  const f = await fixture(t)
  const source = Object.freeze({ op: 'shot', ensp: true, path: 'shots/out.png' })
  const out = await f.run({ steps: Object.freeze([source]) })
  assert.equal(out.ok, true)
  assert.equal(source.out, undefined)
  assert.equal(f.calls[0].out, join(f.workspace, 'shots', 'out.png'))
  assert.equal(f.calls[0].path, undefined)
})
