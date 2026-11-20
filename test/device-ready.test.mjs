import test from 'node:test'
import assert from 'node:assert/strict'
import { waitDevicesReady } from '../lib/device-ready.js'

test('readiness requires a successful VRP response, not a listening TCP port', async () => {
  const closed = []
  const out = await waitDevicesReady([{ name: 'AR', comPort: 8000 }], { timeoutMs: 30, sessionFactory: () => ({
    open: async () => ({ prompt: '<Other>' }), command: async () => ({ ok: true, output: 'HTTP server', prompt: '<Other>' }), close: () => closed.push(true),
  }) })
  assert.equal(out.ok, false)
  assert.equal(out.devices[0].state, 'not_vrp')
  assert.equal(out.devices[0].retryable, false)
  assert.equal(out.devices[0].attempts, 1)
  assert(closed.length)
})
test('readiness probes only display version and reports every device', async () => {
  const calls = []
  const out = await waitDevicesReady([{ name: 'AR', comPort: 8000 }, { name: 'SW', comPort: 8100 }], { sessionFactory: o => ({
    open: async () => calls.push(o.port), command: async cmd => { calls.push(cmd); return { ok: true, output: 'Huawei VRP software', prompt: '<Huawei>' } }, close() {},
  }) })
  assert.equal(out.ok, true)
  assert.deepEqual(calls, [8000, 'display version', 8100, 'display version'])
})
test('authentication stops polling that device and never leaks credentials or changes passwords', async () => {
  let attempts = 0
  const out = await waitDevicesReady([{ name: 'FW', comPort: 8200, password: 'secret' }], { sessionFactory: () => ({
    open: async () => { attempts++; throw Object.assign(Error('secret banner'), { kind: 'authentication' }) },
    command: async () => assert.fail('must not send commands'), close() {},
  }) })
  assert.equal(out.ok, false)
  assert.equal(out.devices[0].state, 'authentication_required')
  assert.equal(attempts, 1)
  assert(!JSON.stringify(out).includes('secret'))
})
test('readiness retries transient boot errors and closes every session', async () => {
  let attempts = 0, closed = 0
  const out = await waitDevicesReady([{ name: 'AR', comPort: 8000 }], { timeoutMs: 1200, sessionFactory: () => ({
    open: async () => { if (++attempts === 1) throw Error('booting') },
    command: async () => ({ ok: true, output: 'VRP', prompt: '<AR>' }), close: () => closed++,
  }) })
  assert.equal(out.ok, true)
  assert.equal(closed, 2)
})

test('a console stuck during login cannot exceed the shared readiness deadline', async () => {
  let closed = 0
  const start = Date.now()
  const out = await waitDevicesReady([{ name: 'AR', comPort: 8000 }], { timeoutMs: 50, sessionFactory: () => ({
    open: () => new Promise(() => {}), command: () => assert.fail('not ready'), close: () => closed++,
  }) })
  assert.equal(out.ok, false)
  assert(Date.now() - start < 500)
  assert(closed > 0)
})

test('interactive state is terminal within a readiness call and a later call observes fresh state', async () => {
  let attempts = 0, commands = 0
  const factory = () => ({
    open: async () => { if (++attempts === 1) throw Object.assign(Error('pending question'), { kind: 'input_required' }) },
    command: async () => { commands++; return { ok: true, output: 'Huawei VRP', prompt: '<AR>' } }, close() {},
  })
  const first = await waitDevicesReady([{ name: 'AR', comPort: 8000 }], { sessionFactory: factory })
  assert.equal(first.devices[0].state, 'interaction_required')
  assert.equal(first.devices[0].attempts, 1)
  assert.equal(commands, 0)
  const later = await waitDevicesReady([{ name: 'AR', comPort: 8000 }], { sessionFactory: factory })
  assert.equal(later.ok, true)
  assert.equal(commands, 1, 'no stale port-level terminal cache may block a fresh observation')
})

test('readiness deadline is monotonic and does not follow wall-clock changes', async t => {
  t.mock.method(Date, 'now', () => 0)
  let attempts = 0
  const start = performance.now()
  const out = await waitDevicesReady([{ name: 'AR', comPort: 8000 }], { timeoutMs: 30, sessionFactory: () => ({
    open: async () => { attempts++; throw Error('unreachable') }, command() { assert.fail('not connected') }, close() {},
  }) })
  assert.equal(out.ok, false)
  assert(attempts >= 1 && attempts <= 2, 'a timer may wake just before the deadline; retries remain bounded')
  assert(performance.now() - start < 500)
})

test('duplicate readiness ports are rejected before any connection', async () => {
  await assert.rejects(waitDevicesReady([{ name: 'A', comPort: 8000 }, { name: 'B', comPort: 8000 }], {
    sessionFactory: () => assert.fail('duplicate targets must not connect'),
  }), /unique console ports/u)
})
