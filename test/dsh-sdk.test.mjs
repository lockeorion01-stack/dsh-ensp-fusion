import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as plugin from '../index.js'

test('target DSH SDK registers, dispatches, validates and unloads the plugin', async t => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const sdk = JSON.parse(await readFile(new URL('../node_modules/@deepseek-ai/dsh-tools/package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-tools'], '0.2.2-rc.1')
  assert.equal(sdk.version, manifest.peerDependencies['@deepseek-ai/dsh-tools'])
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
  assert.equal(ctx.tools.definitions().length, 16)
  const pipeline = new ToolExecutionPipeline(ctx)
  ctx.tools.setExecutor({
    describe: tools => ({ schemas: tools.map(({ name, description, parameters }) => ({ name, description, parameters })) }),
    execute: input => executeToolBatch(input, pipeline, () => 1),
  })
  const assembly = await ctx.systemPrompt.assemble()
  assert.equal(assembly.tools.length, 16)
  assert.ok(assembly.sections.some(s => s.name === 'ensp:automation'))
  const call = async (name, args) => (await ctx.tools.execute({
    calls: [{ type: 'tool_call', id: 'sdk-check', name, arguments: JSON.stringify(args) }],
    signal: new AbortController().signal,
    agent: { session: { header: { cwd } } },
  })).results[0].result
  const scenarios = await call('ensp_scenarios', { query: 'ospf' })
  assert.equal(scenarios.isError, false)
  assert.equal(JSON.parse(scenarios.value.data).total, 23)
  assert.deepEqual(JSON.parse(scenarios.content[0].text), scenarios.value)
  const built = await call('ensp_build', { output_path: 'sdk.topo', devices: [{ name: 'R1', model: 'AR2220' }] })
  assert.equal(built.isError, false)
  assert.equal(built.value.ok, true)
  assert.match(await readFile(join(cwd, 'sdk.topo'), 'utf8'), /name="R1"/u)
  const topo = await call('ensp_topo', { action: 'list', topology_path: 'sdk.topo' })
  assert.equal(topo.isError, false)
  assert.ok(topo.content[0].text.includes('R1'))
  const invalid = await call('ensp_build', { output_path: 'invalid.topo' })
  assert.equal(invalid.isError, true)
  await assert.rejects(readFile(join(cwd, 'invalid.topo')), { code: 'ENOENT' })
  await mounted.dispose()
  assert.equal(ctx.tools.definitions().length, 0)
})
