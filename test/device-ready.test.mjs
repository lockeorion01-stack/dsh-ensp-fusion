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
