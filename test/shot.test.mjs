import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRegistry } from '../mcp/server.js'
import { Bridge } from '../lib/bridge-client.js'

for (const state of ['visible', 'hidden', 'minimized', 'invalid']) {
  test(`device screenshot with explicit hwnd: ${state}`, async t => {
    const workspace = await mkdtemp(join(tmpdir(), 'ensp-shot-'))
    t.after(() => rm(workspace, { recursive: true, force: true }))
    const calls = []
    t.mock.method(Bridge.prototype, 'steps', async steps => {
      calls.push(...steps)
      return { steps: steps.map(s => s.op === 'info'
        ? { ok: state !== 'invalid', window: state === 'invalid' ? undefined : { hwnd: 123, visible: state !== 'hidden', minimized: state === 'minimized' } }
        : { ok: true, width: 640, height: 480, window: { hwnd: s.hwnd } }) }
    })
    const r = createRegistry({ workspace })
    const run = () => r.tools.find(t => t.name === 'ensp_shot').handler({ target: 'device', hwnd: 123, out: 'shot.png' }, r.exec)
    if (state === 'visible') {
      const result = await run()
      assert.equal(result.width, 640)
      assert.equal(calls.at(-1).hwnd, 123)
    } else {
      await assert.rejects(run, /invalid|visible/)
      assert.equal(calls.some(s => s.op === 'shot'), false)
    }
  })
}
