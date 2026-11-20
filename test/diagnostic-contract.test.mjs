import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { VrpSession } from '../lib/cli.js'
import { createMcpServer } from '../mcp/server.js'
import { spawnSync } from 'node:child_process'
import * as plugin from '../index.js'

test('diagnostic branches survive the real DSH lossless JSON and output boundary', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'ensp-diagnose-contract-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const ctx = new Context()
  const prompt = await ctx.plugin(SystemPrompt, {})
  const registry = await ctx.plugin(ToolsService)
  ctx.provide('skills', { register() {} })
  const mounted = await ctx.plugin(plugin, plugin.Config({ diagnosticLogging: false }))
  t.after(async () => { await mounted.dispose(); await registry.dispose(); await prompt.dispose() })
  const pipeline = new ToolExecutionPipeline(ctx)
  ctx.tools.setExecutor({
    describe: tools => ({ schemas: tools.map(({ name, description, parameters }) => ({ name, description, parameters })) }),
    execute: input => executeToolBatch(input, pipeline, () => 1),
  })
  await writeFile(join(cwd, 'campus.topo'), '<topo><dev id="sw" name="SW1" model="S5700" com_port="8101"/></topo>')
  await mkdir(join(cwd, 'Log'))
  const call = async (overrides, signal = new AbortController().signal) => {
    const result = (await ctx.tools.execute({
      calls: [{ type: 'tool_call', id: 'diagnostic-contract', name: 'ensp_console_diagnose',
        arguments: JSON.stringify({ topology_path: 'campus.topo', device: 'SW1', native_log_root: cwd, ...overrides }) }],
      signal, agent: { session: { header: { cwd } } },
    })).results[0].result
    assert(!/lossless JSON|invalid output/u.test(JSON.stringify(result)), JSON.stringify(result))
    return { result, value: result.value ?? JSON.parse(result.content[0].text) }
  }
  const unavailable = await call({})
  assert.equal(unavailable.result.isError, true)
  assert.equal(unavailable.value.status, 'INSUFFICIENT_LOG_EVIDENCE')
  for (const category of ['Conserver', 'VBoxServer']) {
    await writeFile(join(cwd, 'Log', category + '_2026-11-19.log'), 'no matching errors\n')
  }
  const clean = await call({})
  assert.equal(clean.result.isError, false)
  assert.equal(clean.value.sources.length, 2)
  assert(clean.value.sources.every(row => !Object.hasOwn(row, 'device')))
  assert.equal(clean.value.readiness.state, 'not_probed')
  t.mock.method(VrpSession.prototype, 'open', async () => ({ prompt: '<SW1>' }))
  t.mock.method(VrpSession.prototype, 'command', async () => ({ ok: true, prompt: '<SW1>', output: 'Huawei Versatile Routing Platform VRP' }))
  const ready = await call({ probe: true, timeout_ms: 100 })
  assert.equal(ready.result.isError, false)
  assert.equal(ready.value.readiness.state, 'ready')
  t.mock.restoreAll()
  await writeFile(join(cwd, 'Log', 'Conserver_2026-11-19.log'), 'Failed to put vrpcfg.zip.\n')
  const finding = await call({})
  assert.equal(finding.result.isError, true)
  assert.equal(finding.value.findingCounts.PROJECT_SYNC_FAILURE, 1)
  for (const kind of ['authentication', 'input_required', 'transport']) {
    t.mock.method(VrpSession.prototype, 'open', async () => {
      throw Object.assign(new Error('synthetic diagnostic failure'), { kind, output: kind === 'transport' ? '##' : '' })
    })
    const failure = await call({ probe: true, timeout_ms: 100 })
    assert.equal(failure.result.isError, true)
    assert.equal(failure.value.readiness.kind, kind)
    t.mock.restoreAll()
  }
  const missing = await call({ device: 'MISSING' })
  assert.equal(missing.result.isError, true)
  assert.match(missing.value.error, /unique CLI port/u)
  t.mock.method(VrpSession.prototype, 'open', async () => { throw new TypeError('synthetic lower layer exception') })
  const exception = await call({ probe: true, timeout_ms: 100 })
  assert.equal(exception.result.isError, true)
  assert.equal(exception.value.readiness.kind, 'transport')
  t.mock.restoreAll()
  let sent = 0
  t.mock.method(VrpSession.prototype, 'open', async () => { await new Promise(resolve => setTimeout(resolve, 125)) })
  t.mock.method(VrpSession.prototype, 'command', async () => { sent++; throw Error('late command must not run') })
  const expired = await call({ probe: true, timeout_ms: 100 })
  assert.equal(expired.result.isError, true)
  assert.equal(sent, 0)
  t.mock.restoreAll()
  const caller = new AbortController()
  t.mock.method(VrpSession.prototype, 'open', async () => { caller.abort() })
  t.mock.method(VrpSession.prototype, 'command', async () => { sent++; throw Error('cancelled command must not run') })
  const cancelled = await call({ probe: true, timeout_ms: 100 }, caller.signal)
  assert.equal(cancelled.result.isError, true)
  assert.match(JSON.stringify(cancelled.result), /ABORTED|cancelled/u)
  assert.equal(sent, 0)
})

test('diagnostic MCP errors and CLI exit codes agree with sampled log findings', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'ensp-diagnostic-entrypoints-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(join(cwd, 'campus.topo'), '<topo><dev id="sw" name="SW1" model="S5700" com_port="8101"/></topo>')
  await mkdir(join(cwd, 'Log'))
  for (const category of ['Conserver', 'VBoxServer']) await writeFile(join(cwd, 'Log', category + '_2026-11-19.log'), 'clean sample')
  const server = createMcpServer({ workspace: cwd, quiet: true, overrides: { diagnosticLogging: false } })
  const args = { topology_path: 'campus.topo', device: 'SW1', native_log_root: cwd }
  const cliArgs = join(cwd, 'args.json')
  await writeFile(cliArgs, JSON.stringify(args))
  for (const expectedOk of [true, false]) {
    if (!expectedOk) await writeFile(join(cwd, 'Log', 'Conserver_2026-11-19.log'), 'Failed to put vrpcfg.zip.')
    const replies = []
    await server.handleMessage({ id: 1, method: 'tools/call', params: { name: 'ensp_console_diagnose', arguments: args } }, row => replies.push(row))
    assert.equal(replies[0].result.isError, !expectedOk)
    assert.equal(JSON.parse(replies[0].result.content[0].text).ok, expectedOk)
    const cli = spawnSync(process.execPath, ['bin/ensp-fusion.mjs', 'call', 'ensp_console_diagnose', cliArgs, cwd], {
      encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, ENSP_FUSION_DIAGNOSTICS: 'off' },
    })
    assert.equal(cli.status, expectedOk ? 0 : 1, cli.stderr)
    assert.equal(JSON.parse(cli.stdout).ok, expectedOk)
    assert(!/lossless JSON|invalid output/u.test(cli.stdout))
  }
})
