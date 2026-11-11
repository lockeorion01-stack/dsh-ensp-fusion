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
      results.push({ ...s, ok: s.op !== 'bad', ...(s.op === 'windows' ? { windows: [] } : {}) })
      if (s.op === 'bad' && opts.stopOnError) break
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
})
test('stop_all uses atomic canvas selection and validates port closure before next step', async t => {
  const f = await fixture(t)
  await writeFile(join(f.workspace, 'lab.topo'), '<topo><dev id="1" name="R1" com_port="9998"/></topo>')
  const out = await f.run({ topology_path: 'lab.topo', steps: [{ op: 'stop_all' }, { op: 'bad' }] })
  assert.equal(out.ok, false)
  assert.equal(out.requiresCursorTakeover, true)
  assert.deepEqual(f.calls[0], { op: 'device_control', ensp: true, toolbar: [698, 56] })
  assert.equal(out.steps.find(s => s.op === 'stop_all').ok, true)
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
  const out = await f.run({ steps: [{ op: 'bad' }, { op: 'type', text: 'danger' }, { op: 'close_console', device: 'R1' }] })
  assert.equal(out.ok, false)
  assert.deepEqual(f.calls.map(s => s.op), ['bad'])
  assert(out.steps.some(s => s.op === 'skipped' && s.skipped.includes('type')))
})

test('all GUI readiness inputs and control prerequisites validate before any mutation', async t => {
  const f = await fixture(t)
  for (const args of [
    { steps: [{ op: 'click' }, { op: 'start_all' }] },
    { steps: [{ op: 'click' }], ready_wait_ms: NaN },
    { steps: [{ op: 'click' }], ready_devices: [{ device: 'R1', new_password: 'secret' }] },
    { steps: [{ op: 'close_project', save: 'unknown' }] },
  ]) await assert.rejects(f.run(args))
  assert.equal(f.calls.length, 0)
})
