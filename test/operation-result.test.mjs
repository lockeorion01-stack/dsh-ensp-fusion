import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeOperationResult as normalize, operationSucceeded, assertOperationSucceeded } from '../lib/operation-result.js'
import { installOutcomeAdapter } from '../lib/tool-outcome.js'
import { createMcpServer } from '../mcp/server.js'
import { classifyCommandEffects, shouldAutoSave } from '../lib/command-effects.js'

test('known nested failures, skipped devices and assertions fail consistently without interpreting output text', async () => {
  const failures = [
    { ok: true, data: { ok: false } }, { ok: true, data: '{"ok":false}' },
    { ok: true, devices: [{ ok: true }, { ok: false }] },
    { ok: true, results: [{ ok: true, output: 'applied' }], checks: [{ pass: false }] },
    { ok: true, skipped: ['next command'] }, { ok: true, data: '{broken' }, { ok: 'false' }, {},
    { ok: true, results: [{}] }, { ok: true, results: 'not-an-array' }, { ok: true, devices: {} },
    { ok: false, execution: { schema_version: 1, status: 'success' } },
  ]
  let around
  installOutcomeAdapter({ on: (_, fn) => { around = fn } }, ['ensp_cli'])
  const server = createMcpServer({ quiet: true, overrides: { diagnosticLogging: false } })
  const tool = server.registry.tools.find(t => t.name === 'ensp_cli')
  for (const value of failures) {
    assert.equal(operationSucceeded('ensp_cli', value), false)
    assert.throws(() => assertOperationSucceeded('ensp_cli', value), { code: 'ENSP_OPERATION_FAILED' })
    assert.equal((await around({ name: 'ensp_cli' }, async () => ({ isError: false, value }))).isError, true)
    tool.handler = async () => value
    const sent = []
    await server.handleMessage({ id: 1, method: 'tools/call', params: { name: 'ensp_cli' } }, r => sent.push(r))
    assert.equal(sent[0].result.isError, true)
  }
  const good = { ok: true, results: [{ ok: true, output: '{"ok":false}' }], saved: { performed: false } }
  assert.equal(operationSucceeded('ensp_cli', good), true)
  assert.equal(assertOperationSucceeded('ensp_cli', good), good)
  assert.equal(normalize('ensp_cli', failures[2]).execution.status, 'partial')
})

test('GUI dispatch and business acceptance retain distinct verification levels', () => {
  const gui = normalize('ensp_gui', { ok: true, steps: [{ ok: true }], outcome: { taskVerified: false } })
  assert.equal(gui.ok, true); assert.equal(gui.execution.operation_verification, 'dispatched')
  assert.equal(gui.execution.business_verification, 'not_requested')
  const lldp = normalize('ensp_lldp', { ok: true, data: '{"status":"INCONCLUSIVE"}' })
  assert.equal(lldp.ok, false); assert.equal(lldp.execution.assertion_verification, 'inconclusive')
  assert.equal(lldp.execution.business_verification, 'not_requested')
  assert.deepEqual(normalize('ensp_lldp', lldp), lldp, 'normalization must be idempotent across adapters')
  assert.equal(normalize('ensp_doc', { captioned: 'result.docx', verification: { ok: false } }).ok, false)
  assert.equal(normalize('ensp_gui', { ok: false, steps: [{ ok: false }] }).execution.operation_verification, 'unconfirmed')
  assert.equal(normalize('ensp_topo', { unexpected: true }).ok, false)
  assert.equal(normalize('ensp_topo', { ok: 'false', topologyPath: 'x', devices: [] }).ok, false)
  assert.equal(normalize('ensp_wait', { ok: true, data: 'truncated response' }).ok, false)
  assert.equal(normalize('ensp_wait', { ok: true }).ok, false)
  for (const result of [
    { ok: false, results: [{ ok: false }] },
    { ok: false, devices: [{ ok: false, failure: { outcome: 'unconfirmed' } }] },
  ]) {
    const failed = normalize('ensp_cli', result)
    assert.equal(failed.execution.may_have_applied, true)
    assert.deepEqual(normalize('ensp_cli', failed), failed)
  }
})

test('effect classification never grants replay and preserves legacy auto-save separately', () => {
  for (const [command, kind] of [['display version','query'],['ping 127.0.0.1','active_probe'],['save','persistence'],['reset counters interface','state_change'],['refresh','state_change'],['system-view','session_control'],['display diagnostic-information','unknown'],['display version;save','unknown']]) {
    const effect = classifyCommandEffects(command)
    assert.equal(effect.kind, kind); assert.equal(effect.replay_allowed, false)
  }
  assert.equal(shouldAutoSave(['save', 'reset counters interface', 'display version']), false)
  assert.equal(shouldAutoSave(['interface GigabitEthernet0/0/1']), true)
})
