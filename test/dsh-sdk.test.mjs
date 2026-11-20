import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { ToolsService, defineTool } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { Bridge } from '../lib/bridge-client.js'
import { instrumentTool } from '../lib/operation-context.js'
import * as plugin from '../index.js'

test('target DSH SDK registers, dispatches, validates and unloads the plugin', async t => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const sdk = JSON.parse(await readFile(new URL('../node_modules/@deepseek-ai/dsh-tools/package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-tools'], '0.2.2-rc.1 || 0.2.2-rc.3 || 0.2.2-rc.5')
  assert.ok(['0.2.2-rc.1', '0.2.2-rc.3', '0.2.2-rc.5'].includes(sdk.version), `unverified SDK: ${sdk.version}`)
  const cwd = await mkdtemp(join(tmpdir(), 'ensp-dsh-sdk-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const ctx = new Context()
  const prompt = await ctx.plugin(SystemPrompt, {})
  const registry = await ctx.plugin(ToolsService)
  t.after(async () => { await registry.dispose(); await prompt.dispose() })
  // SkillRegistry is supplied by the host; check:dsh verifies the actual service.
  ctx.provide('skills', { register() {} })
  const mounted = await ctx.plugin(plugin, plugin.Config({}))
  t.after(() => mounted.dispose())
  assert.equal(ctx.tools.definitions().length, 19)
  const pipeline = new ToolExecutionPipeline(ctx)
  ctx.tools.setExecutor({
    describe: tools => ({ schemas: tools.map(({ name, description, parameters }) => ({ name, description, parameters })) }),
    execute: input => executeToolBatch(input, pipeline, () => 1),
  })
  const assembly = await ctx.systemPrompt.assemble()
  assert.equal(assembly.tools.length, 19)
  assert.ok(assembly.sections.some(s => s.name === 'ensp:automation'))
  const call = async (name, args, signal = new AbortController().signal) => (await ctx.tools.execute({
    calls: [{ type: 'tool_call', id: 'sdk-check', name, arguments: JSON.stringify(args) }],
    signal,
    agent: { session: { header: { cwd } } },
  })).results[0].result
  const callRaw = async (name, args) => (await ctx.tools.execute({
    calls: [{ type: 'tool_call', id: 'sdk-check-raw', name, arguments: args }],
    signal: new AbortController().signal,
    agent: { session: { header: { cwd } } },
  })).results[0].result
  const scenarios = await call('ensp_scenarios', { query: 'ospf' })
  assert.equal(scenarios.isError, false)
  assert.equal(JSON.parse(scenarios.value.data).total, 50)
  assert.deepEqual(JSON.parse(scenarios.content[0].text), scenarios.value)
  const built = await call('ensp_build', { output_path: 'sdk.topo', devices: [{ name: 'R1', model: 'AR2220' }] })
  assert.equal(built.isError, false)
  assert.equal(built.value.ok, true)
  assert.match(await readFile(join(cwd, 'sdk.topo'), 'utf8'), /name="R1"/u)
  const scenarioBuild = await call('ensp_build', { output_path: 'sdk-scenario.topo', scenario_id: 'ospf-single' })
  assert.equal(scenarioBuild.isError, false)
  const scenarioData = JSON.parse(scenarioBuild.value.data)
  assert.equal(scenarioData.summary.devices, 3)
  const scenarioPreview = await call('ensp_cli', scenarioData.cli_plan)
  assert.equal(scenarioPreview.isError, false)
  assert.equal(scenarioData.cli_plan.dry_run, true)
  const sockets = new Set()
  const peer = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      while (buffer.includes('\r')) {
        const end = buffer.indexOf('\r'); buffer = buffer.slice(end + 1)
        socket.write('<Offline>')
      }
    })
  })
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => peer.close(resolve)) })
  peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
  const cli = await call('ensp_cli', { port: peer.address().port, commands: ['display version'], save: false })
  assert.equal(cli.isError, false, JSON.stringify(cli))
  assert.equal(cli.value.command_effects[0].kind, 'query', 'command effects must survive host output schema validation')
  const topo = await call('ensp_topo', { action: 'list', topology_path: 'sdk.topo' })
  assert.equal(topo.isError, false)
  assert.ok(topo.content[0].text.includes('R1'))

  const guiCalls = []
  t.mock.method(Bridge.prototype, 'steps', async steps => {
    guiCalls.push(...steps)
    return { steps: steps.map(step => ({ ...step, ok: true })) }
  })
  const opened = await call('ensp_gui', { steps: [{ op: 'open', path: 'sdk.topo' }] })
  assert.equal(opened.isError, false)
  assert.equal(opened.value.ok, true)
  assert.deepEqual(guiCalls, [{ op: 'open', path: join(cwd, 'sdk.topo') }])
  assert.equal(opened.value.outcome.taskVerified, false)
  assert.equal(opened.value.steps[0].completion, 'dispatched')

  const failed = await call('ensp_project', { action: 'inspect', topology_path: 'sdk.topo' })
  assert.equal(failed.isError, true, 'ok:false must propagate to the host error envelope')
  assert.equal(failed.value, undefined, 'failure must follow SDK contract without success value')
  assert.equal(JSON.parse(failed.content[0].text).devices[0].state, 'missing')
  assert.equal(failed.error.info.code, 'ENSP_OPERATION_FAILED')
  const failureEvidence = JSON.parse(failed.content[0].text)
  assert.ok(failed.error.message.includes(failureEvidence.execution.operation_id))
  assert.match(failed.error.message, /ensp_logexport/u)
  await writeFile(join(cwd, 'failure-session.jsonl'), '\n' + JSON.stringify({ type: 'tool/ptc-dispatch', data: {
    subCallId: failureEvidence.execution.call_id, name: 'ensp_project', isError: true, content: failed.content,
  } }) + '\n')
  for (const selector of [{ operation_id: failureEvidence.execution.operation_id }, { call_id: failureEvidence.execution.call_id }]) {
    const destination = Object.keys(selector)[0] + '.json'
    const exported = await call('ensp_logexport', { source: 'failure-session.jsonl', destination, ...selector })
    assert.equal(exported.isError, false, JSON.stringify(exported))
    assert.equal(exported.value.structuredResults, 1)
    const artifact = JSON.parse(await readFile(join(cwd, destination), 'utf8'))
    assert.equal(artifact.records[0].line, 2)
    assert.deepEqual(artifact.results[0].result, failureEvidence)
    assert.equal(artifact.results[0].isError, true)
  }
  const badExport = await call('ensp_logexport', { source: 'failure-session.jsonl', destination: 'invalid-selector.json',
    operation_id: failureEvidence.execution.operation_id, call_id: failureEvidence.execution.call_id })
  assert.equal(badExport.isError, true)
  await assert.rejects(readFile(join(cwd, 'invalid-selector.json')), { code: 'ENOENT' })

  const incomplete = await call('ensp_lldp', { links: [], observations: [] })
  assert.equal(incomplete.isError, true, 'inconclusive nested LLDP must propagate through the real DSH pipeline')
  assert.equal(JSON.parse(incomplete.content[0].text).execution.status, 'inconclusive')

  const malformed = await callRaw('ensp_status', '{"z_end_turn_review":"')
  assert.equal(malformed.isError, true)
  assert.equal(guiCalls.length, 1, 'invalid JSON must be rejected before any bridge/device operation')

  const invalid = await call('ensp_build', { output_path: 'invalid.topo' })
  assert.equal(invalid.isError, true)
  await assert.rejects(readFile(join(cwd, 'invalid.topo')), { code: 'ENOENT' })
  const invalidGui = await call('ensp_gui', { steps: [{ op: 'key', key: 'enter', ensp: true }, { op: 'screen' }] })
  assert.equal(invalidGui.isError, true)
  const guiError = JSON.parse(invalidGui.content[0].text)
  assert.equal(guiError.code, 'ENSP_GUI_VALIDATION')
  assert.equal(guiError.stepIndex, 1)
  assert.equal(guiError.field, 'out')
  assert.equal(guiError.execution.may_have_applied, false)
  const cancelled = new AbortController()
  t.mock.method(Bridge.prototype, 'steps', async (_steps, opts) => {
    opts.operation.control.dispatch()
    cancelled.abort()
    return { ok: false, steps: [{ ok: false, error: 'response lost' }] }
  })
  const interrupted = await call('ensp_gui', { steps: [{ op: 'sleep', t: 1 }] }, cancelled.signal)
  assert.equal(interrupted.isError, true)
  assert.equal(interrupted.error.info.code, 'ABORTED', 'DSH retains its canonical cancellation contract')
  const retained = JSON.parse(interrupted.content[0].text)
  assert.equal(retained.execution.status, 'unconfirmed')
  assert.equal(retained.execution.may_have_applied, true)
  // An internal deadline does not abort the host's caller signal: the shortened
  // cancellation result must pass output validation without normal payloads.
  const unregister = ctx.tools.register(instrumentTool(defineTool({ name: 'deadline_probe', description: 'Offline deadline probe', parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { payload: { type: 'string', required: true } } }, render: (_, value) => JSON.stringify(value) },
    async execute(_, exec) {
      if (!exec.signal.aborted) await new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true }))
      exec.operation.control.check()
    },
  }), { diagnosticLogging: false, timeoutMs: 30 }))
  try {
    const expired = await call('deadline_probe', {})
    assert.equal(expired.isError, false, 'the eNSP outcome adapter must leave an unrelated test tool alone')
    assert.equal(expired.value.ok, false)
    assert.equal(expired.value.execution.status, 'cancelled')
    assert.equal(expired.value.payload, undefined)
  } finally { unregister() }
  await mounted.dispose()
  assert.equal(ctx.tools.definitions().length, 0)
})
