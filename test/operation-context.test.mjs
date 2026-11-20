import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { instrumentTool } from '../lib/operation-context.js'
import { openExecutionLog } from '../lib/execution-events.js'

test('concurrent operations retain separate IDs and log only whitelisted metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ensp-context-')); t.after(() => rm(root, { recursive: true, force: true }))
  const tool = instrumentTool({ name: 'ensp_cli', async execute(args, exec) {
    await exec.operation.event('dispatched', { port: args.port, password: args.password, command: args.command })
    return { ok: true, results: [{ ok: true, output: 'answer' }] }
  } }, { diagnosticDirectory: root })
  const old = process.env.ENSP_FUSION_DIAGNOSTICS; delete process.env.ENSP_FUSION_DIAGNOSTICS
  t.after(() => { if (old === undefined) delete process.env.ENSP_FUSION_DIAGNOSTICS; else process.env.ENSP_FUSION_DIAGNOSTICS = old })
  const exec = { callId: 'host-id', entrypoint: 'test' }
  const results = await Promise.all([1, 2].map(port => tool.execute({ port, password: 'Synthetic-Secret!', command: 'private command' }, exec)))
  assert.notEqual(results[0].execution.operation_id, results[1].execution.operation_id)
  assert.equal(exec.operation, undefined)
  for (const file of (await readdir(root)).filter(f => f.endsWith('.jsonl'))) {
    const text = await readFile(join(root, file), 'utf8')
    assert(!text.includes('Synthetic-Secret!')); assert(!text.includes('private command'))
    const rows = text.trim().split('\n').map(JSON.parse)
    assert.equal(new Set(rows.map(r => r.operation_id)).size, 1)
    assert.equal(rows[0].type, 'started'); assert.equal(rows.at(-1).type, 'finished')
  }
  assert(results.every(r => r.execution.evidence_persisted))
})

test('optional logging failure preserves operation truth and bounded retention protects active files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ensp-log-limit-')); t.after(() => rm(root, { recursive: true, force: true }))
  const active = join(root, 'abcd.active.jsonl'); await writeFile(active, 'important')
  await assert.rejects(openExecutionLog(root, 'aaaa', { maxBytes: 16384 }), /capacity/u)
  assert.equal(await readFile(active, 'utf8'), 'important')
  await writeFile(join(root, 'blocked'), 'not directory')
  const result = await instrumentTool({ name: 'ensp_cli', execute: async () => ({ ok: true }) }, { diagnosticDirectory: join(root, 'blocked', 'child') }).execute({})
  assert.equal(result.ok, true); assert.equal(result.execution.evidence_persisted, false)
})

test('metadata overflow retains terminal state and removes only expired closed records', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ensp-log-overflow-')); t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'abcd.closed.jsonl'), 'expired')
  await writeFile(join(root, 'dcba.active.jsonl'), 'active')
  for (const name of ['abcd.closed.jsonl','dcba.active.jsonl']) await utimes(join(root, name), new Date(0), new Date(0))
  const log = await openExecutionLog(root, 'aaaa', { operationBytes: 3072 })
  await log.event({ type: 'started' })
  await assert.rejects(log.event({ type: 'observed', text: 'x'.repeat(4096) }), /limit/u)
  await log.event({ type: 'finished', omitted_events: 1 }); await log.close()
  assert(!(await readdir(root)).includes('abcd.closed.jsonl'))
  assert.equal(await readFile(join(root, 'dcba.active.jsonl'), 'utf8'), 'active')
  const rows = (await readFile(join(root, 'aaaa.closed.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(rows.at(-1).type, 'finished'); assert.equal(rows.at(-1).omitted_events, 1)
})

test('instrumented exceptions keep diagnostic identity while redacting known secrets', async () => {
  const tool = instrumentTool({ name: 'ensp_cli', execute: async () => {
    throw Object.assign(new TypeError('Synthetic-Secret! rejected'), { kind: 'authentication', output: 'Synthetic-Secret!', code: 'TEST_FAILURE' })
  } }, { diagnosticLogging: false })
  await assert.rejects(tool.execute({ password: 'Synthetic-Secret!' }), error => {
    assert.equal(error.name, 'TypeError'); assert.equal(error.kind, 'authentication'); assert.equal(error.code, 'TEST_FAILURE')
    assert(!error.message.includes('Synthetic-Secret!')); assert(!error.output.includes('Synthetic-Secret!'))
    assert.match(error.execution.operation_id, /^[a-f\d-]{36}$/u); return true
  })
})
