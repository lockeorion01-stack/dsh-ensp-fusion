import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:net'
import test from 'node:test'

import { Bridge } from '../lib/bridge-client.js'

const TOKEN = 'offline-resident-token'

test('serve stops dependent input after a failed step when stopOnError is enabled', async t => {
  const remote = await peer(t, (request, _socket, reply) => reply(request.op === 'click' ? { ok: false, error: 'covered' } : { ok: true }))
  const bridge = new OfflineBridge({ mode: 'serve' }, remote.info)
  const out = await bridge.steps([{ op: 'click' }, { op: 'type' }], { stopOnError: true })
  assert.equal(out.ok, false)
  assert.deepEqual(remote.seen.map(r => r.op), ['ping', 'click'])
  assert.equal(out.steps.length, 1)
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// No test can launch Python, a GUI or UAC, even if startup regresses.
class OfflineBridge extends Bridge {
  constructor(config = {}, launch = async () => { throw new Error('offline launch unavailable') }) {
    super(config, {})
    this.launch = launch
    this.launches = 0
    this.jobs = []
  }

  async runtime() {
    throw new Error('Python is forbidden in offline bridge tests')
  }

  async launchResident() {
    this.launches += 1
    return this.launch(this.launches)
  }

  async runJob(steps, opts) {
    this.jobs.push({ steps, opts })
    if (!this.jobResult) throw new Error('unexpected job fallback')
    return this.jobResult
  }
}

async function peer(t, handle = (_request, _socket, reply) => reply({ ok: true })) {
  const seen = []
  const sockets = new Set()
  const errors = []
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    let received = false
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (received || index === -1) return
      received = true
      try {
        const request = JSON.parse(buffer.slice(0, index))
        seen.push(request)
        const reply = (response) => socket.end(`${JSON.stringify(response)}\n`)
        if (request.token !== TOKEN) reply({ ok: false, error: 'bad token' })
        else handle(request, socket, reply)
      } catch (error) {
        errors.push(error)
        socket.destroy()
      }
    })
  })
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
    assert.deepEqual(errors, [])
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const info = () => ({ port: server.address().port, token: TOKEN, logPath: 'offline-only', healthy: false })
  return { seen, info }
}

test('concurrent callers share one launch and wait for a successful readiness response', { timeout: 5000 }, async (t) => {
  const waiting = deferred()
  let probes = 0
  const remote = await peer(t, (request, socket, reply) => {
    if (request.op !== 'ping') { reply({ ok: true, id: request.id }); return }
    probes += 1
    if (probes === 1) reply({ ok: false, error: 'not ready' })
    else if (probes === 2) socket.end()
    else waiting.resolve(() => reply({ ok: true, pid: 42, elevated: true }))
  })
  const bridge = new OfflineBridge({ mode: 'serve' }, remote.info)
  const readyCalls = Array.from({ length: 5 }, () => bridge.ensureServing())
  const requests = Array.from({ length: 5 }, (_, id) => bridge.request({ op: 'echo', id, token: 'caller-token' }))
  const batch = bridge.steps([{ op: 'echo', id: 'batch' }])
  const completed = Promise.all([...readyCalls, ...requests, batch])
  const release = await waiting.promise
  assert.equal(bridge.launches, 1)
  assert.equal(bridge.serving.healthy, false)
  assert.deepEqual(remote.seen.map((request) => request.op), ['ping', 'ping', 'ping'])
  release()
  const results = await completed
  for (const info of results.slice(0, 5)) assert.equal(info, bridge.serving)
  assert.deepEqual(results.slice(5, 10), Array.from({ length: 5 }, (_, id) => ({ ok: true, id })))
  assert.deepEqual(results[10], { ok: true, steps: [{ ok: true, id: 'batch', index: 0, op: 'echo' }], transport: 'serve' })
  assert.equal(bridge.serving.healthy, true)
  assert.deepEqual(bridge.serving.info, { ok: true, pid: 42, elevated: true })
  assert.equal(bridge.starting, null)
  assert.deepEqual(await bridge.request({ op: 'echo', id: 'reused' }), { ok: true, id: 'reused' })
  assert.equal(bridge.launches, 1)
  assert.equal(probes, 3)
  assert.ok(remote.seen.every((request) => request.token === TOKEN))
  assert.deepEqual(bridge.jobs, [])
})

test('failed launch rejects every waiter and permits a later fresh startup', async (t) => {
  const remote = await peer(t)
  const firstLaunch = deferred()
  const bridge = new OfflineBridge({ mode: 'serve' }, (count) => count === 1 ? firstLaunch.promise : remote.info())
  const pending = Promise.allSettled([
    bridge.ensureServing(), bridge.request({ op: 'echo' }), bridge.steps([{ op: 'echo' }]),
  ])
  assert.equal(bridge.launches, 1)
  const error = new Error('fake launcher failed')
  firstLaunch.reject(error)
  for (const result of await pending) {
    assert.equal(result.status, 'rejected')
    assert.equal(result.reason, error)
  }
  assert.equal(bridge.starting, null)
  assert.equal(bridge.serving, null)
  assert.equal((await bridge.ensureServing()).healthy, true)
  assert.equal(bridge.launches, 2)
  assert.deepEqual(remote.seen.map((request) => request.op), ['ping'])
  assert.deepEqual(bridge.jobs, [])
})

test('readiness exhaustion stays unhealthy without relaunching, then can retry', { timeout: 10000 }, async (t) => {
  let ready = false
  const remote = await peer(t, (_request, _socket, reply) => reply({ ok: ready }))
  const bridge = new OfflineBridge({ mode: 'serve' }, remote.info)
  const results = await Promise.allSettled([bridge.ensureServing(), bridge.request({ op: 'echo' })])
  for (const result of results) {
    assert.equal(result.status, 'rejected')
    assert.match(result.reason.message, /did not answer on port/)
  }
  assert.equal(bridge.launches, 1)
  assert.equal(bridge.serving.healthy, false)
  assert.equal(bridge.starting, null)
  assert.equal(remote.seen.length, 40)
  assert.ok(remote.seen.every((request) => request.op === 'ping'))
  ready = true
  assert.equal((await bridge.ensureServing()).healthy, true)
  assert.equal(bridge.launches, 2)
})

for (const mode of ['serve', 'auto']) {
  test(`${mode} batches retain op/index and propagate failed steps without job replay`, async (t) => {
    const remote = await peer(t, (request, _socket, reply) => {
      if (request.op === 'type') reply({ ok: false, error: 'target unavailable', trace: 'offline trace', ms: 3 })
      else reply({ ok: true, op: 'wrong-peer-op', index: 99, ms: 1 })
    })
    const bridge = new OfflineBridge({ mode }, remote.info)
    const result = await bridge.steps([{ op: 'click' }, { op: 'type' }, { op: 'key' }])
    assert.deepEqual(result, {
      ok: false,
      steps: [
        { ok: true, op: 'click', index: 0, ms: 1 },
        { ok: false, error: 'target unavailable', trace: 'offline trace', ms: 3, op: 'type', index: 1 },
        { ok: true, op: 'key', index: 2, ms: 1 },
      ],
      transport: 'serve',
    })
    assert.deepEqual(remote.seen.map((request) => request.op), ['ping', 'click', 'type', 'key'])
    assert.deepEqual(bridge.jobs, [])
  })
}

test('default mode uses serve, empty batches do not launch, and exit clears the resident', async (t) => {
  const remote = await peer(t, (request, _socket, reply) => reply({ ok: true, ...(request.op === 'exit' ? { bye: true } : {}) }))
  const bridge = new OfflineBridge({}, remote.info)
  assert.deepEqual(await bridge.steps([]), { ok: true, steps: [], transport: 'serve' })
  assert.equal(bridge.launches, 0)
  assert.deepEqual(await bridge.ping(), { available: true, ok: true, index: 0, op: 'ping', transport: 'serve' })
  assert.equal((await bridge.steps([{ op: 'exit' }])).ok, true)
  assert.equal(bridge.serving, null)
  assert.equal((await bridge.ensureServing()).healthy, true)
  assert.equal(bridge.launches, 2)
  assert.deepEqual(remote.seen.map((request) => request.op), ['ping', 'ping', 'exit', 'ping'])
  assert.deepEqual(bridge.jobs, [])
})

test('job mode passes steps, options and result through without a resident launch', async () => {
  const bridge = new OfflineBridge({ mode: 'job' })
  const steps = [{ op: 'type', text: 'offline' }]
  const opts = { timeoutMs: 1234 }
  bridge.jobResult = { ok: true, steps: [{ ok: true, op: 'type' }], pid: 10 }
  assert.equal(await bridge.steps(steps, opts), bridge.jobResult)
  assert.equal(bridge.jobs[0].steps, steps)
  assert.equal(bridge.jobs[0].opts, opts)
  assert.equal(bridge.launches, 0)
})

for (const mode of [undefined, 'auto']) {
  test(`${mode ?? 'default'} mode falls back to job when startup fails before any step`, async () => {
    const bridge = new OfflineBridge({ mode })
    const steps = [{ op: 'click' }]
    const opts = { timeoutMs: 1234 }
    bridge.jobResult = { ok: true, steps: [{ ok: true, op: 'click', index: 0 }] }
    assert.equal(await bridge.steps(steps, opts), bridge.jobResult)
    assert.equal(bridge.jobs.length, 1)
    assert.equal(bridge.jobs[0].steps, steps)
    assert.equal(bridge.jobs[0].opts, opts)
    assert.equal(bridge.launches, 1)
  })
}

test('serve mode reports startup failure without a job fallback', async () => {
  const bridge = new OfflineBridge({ mode: 'serve' })
  await assert.rejects(bridge.steps([{ op: 'click' }]), /offline launch unavailable/)
  assert.equal(bridge.launches, 1)
  assert.deepEqual(bridge.jobs, [])
})

for (const [name, close] of [
  ['EOF with no response', (socket) => socket.end()],
  ['EOF with a partial response', (socket) => socket.end('{"ok":true')],
  ['socket close', (socket) => socket.destroy()],
  ['socket reset', (socket) => socket.resetAndDestroy()],
]) {
  test(`requestTo rejects ${name} promptly and invalidates health`, { timeout: 2000 }, async (t) => {
    const remote = await peer(t, (_request, socket) => close(socket))
    const info = { ...remote.info(), healthy: true }
    const bridge = new OfflineBridge()
    const started = performance.now()
    await assert.rejects(bridge.requestTo(info, { op: 'echo' }, { timeoutMs: 5000 }), (error) => {
      assert.ok(error.code === 'ECONNRESET' || /closed before a complete response/.test(error.message))
      return true
    })
    assert.ok(performance.now() - started < 1500, 'must reject before the request timeout')
    assert.equal(info.healthy, false)
    assert.equal(bridge.launches, 0)
  })
}

test('requestTo reassembles fragmented UTF-8 JSON and uses the resident token', async (t) => {
  const remote = await peer(t, (_request, socket) => {
    const response = Buffer.from('{"ok":true,"text":"网络"}\n')
    const split = response.indexOf(Buffer.from('网')) + 1
    socket.write(response.subarray(0, split))
    setImmediate(() => socket.end(response.subarray(split)))
  })
  const bridge = new OfflineBridge()
  const info = { ...remote.info(), healthy: true }
  const payload = { op: 'echo', token: 'wrong-caller-token' }
  assert.deepEqual(await bridge.requestTo(info, payload), { ok: true, text: '网络' })
  assert.equal(payload.token, 'wrong-caller-token', 'caller payload is not mutated')
  assert.equal(remote.seen[0].token, TOKEN)
  assert.equal(info.healthy, true, 'close after a complete response must not invalidate health')
  assert.deepEqual(await bridge.requestTo({ ...info, token: 'wrong-resident-token' }, { op: 'echo' }), { ok: false, error: 'bad token' })
  assert.equal(bridge.launches, 0)
})

test('requestTo rejects malformed JSON and invalidates health', async (t) => {
  const remote = await peer(t, (_request, socket) => socket.end('invalid-json\n'))
  const info = { ...remote.info(), healthy: true }
  await assert.rejects(new OfflineBridge().requestTo(info, { op: 'echo' }), SyntaxError)
  assert.equal(info.healthy, false)
})

test('requestTo times out a silent connection and invalidates health', async (t) => {
  const remote = await peer(t, () => {})
  const info = { ...remote.info(), healthy: true }
  await assert.rejects(new OfflineBridge().requestTo(info, { op: 'echo' }, { timeoutMs: 100 }), /request timed out/)
  assert.equal(remote.seen.length, 1)
  assert.equal(info.healthy, false)
})

for (const droppedIndex of [0, 1]) {
  test(`auto never replays mutations when response ${droppedIndex + 1} is lost`, async (t) => {
    let mutations = 0
    const remote = await peer(t, (request, socket, reply) => {
      if (request.op !== 'ping' && mutations++ === droppedIndex) socket.end()
      else reply({ ok: true })
    })
    const bridge = new OfflineBridge({ mode: 'auto', timeoutMs: 5000 }, remote.info)
    bridge.jobResult = { ok: true, steps: [] }
    await assert.rejects(bridge.steps([{ op: 'click' }, { op: 'type' }, { op: 'key' }]), /closed before a complete response/)
    assert.deepEqual(remote.seen.map((request) => request.op), ['ping', 'click', 'type'].slice(0, droppedIndex + 2))
    assert.equal(bridge.serving.healthy, false)
    assert.equal(bridge.launches, 1)
    assert.deepEqual(bridge.jobs, [])
  })
}
