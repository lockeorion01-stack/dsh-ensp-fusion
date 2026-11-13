// Use the installed desktop host's own compatibility gate and services in a
// separate Electron-as-Node process. No profile, model, device or GUI is opened.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, mkdir, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
function option(name) {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`${name} needs a value`)
  return args[i + 1]
}

async function verify(modules) {
  const pluginRoot = resolve(option('--plugin-root') ?? root)
  const host = name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href)
  const [{ Context }, boot, { ToolsService }, { default: SystemPrompt }, { SkillRegistry }, { NativeToolExecutor }] = await Promise.all([
    host('cordis'), host('dsh-app-boot'), host('dsh-tools'), host('dsh-system-prompt'), host('dsh-skill'), host('dsh-tool-executor-native'),
  ])
  const manifest = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))
  const runtime = boot.getDshRuntimeVersion()
  assert.equal(boot.evaluatePluginCompatibility(manifest, {}, runtime), undefined, 'manifest must pass without a version exemption')
  const compatibility = ['0.2.2-rc.1', '0.2.2-rc.3', '0.2.2-rc.2', '0.2.2', '0.2.3-rc.1', '0.0.1-rc.1'].map(version => {
    const compatible = boot.evaluatePluginCompatibility(manifest, {}, version) === undefined
    assert.equal(compatible, ['0.2.2-rc.1', '0.2.2-rc.3'].includes(version), `compatibility boundary: ${version}`)
    return { runtime: version, compatible }
  })
  const previous = { ...manifest, version: '1.1.2', peerDependencies: { ...manifest.peerDependencies, '@deepseek-ai/dsh-tools': '0.2.2-rc.1' } }
  assert.ok(boot.evaluatePluginCompatibility(previous, {}, '0.2.2-rc.3'), 'the rc.1-only manifest must be rejected on rc.3')
  const old = { ...manifest, version: '1.1.0', peerDependencies: { ...manifest.peerDependencies, '@deepseek-ai/dsh-tools': '0.0.1-rc.1' } }
  assert.deepEqual(boot.evaluatePluginCompatibility(old, {}, runtime)?.requirements, { '@deepseek-ai/dsh-tools': '0.0.1-rc.1' })
  const cwd = await mkdtemp(join(tmpdir(), 'ensp-actual-host-'))
  const ctx = new Context(), fibers = []
  try {
    // Profile plugins normally resolve SDK peers through the host's public
    // package-resolution service, rather than physical profile node_modules.
    // Reproduce that service without mounting the profile or copying host SDKs.
    const resolution = await boot.createRuntimeResolution({ installAnchor: join(modules, '..', 'package.json') })
    fibers.push(await ctx.plugin(boot.PluginPackages, { resolution }))
    const plugin = await import(pathToFileURL(join(pluginRoot, 'index.js')).href)
    fibers.push(await ctx.plugin(SystemPrompt, {}))
    fibers.push(await ctx.plugin(ToolsService))
    fibers.push(await ctx.plugin(SkillRegistry, {}))
    const mounted = await ctx.plugin(plugin, plugin.Config({}))
    fibers.push(mounted)
    const disposeExecutor = ctx.tools.setExecutor(new NativeToolExecutor(ctx))
    try {
      assert.equal(ctx.tools.definitions().length, 19)
      const skills = await ctx.skills.list({ cwd })
      assert.deepEqual(skills.map(s => s.name).sort(), ['ensp-automation', 'ensp-fusion'])
      for (const skill of skills) assert.ok((await ctx.skills.get(skill.name, { cwd })).content)
      const prompt = await ctx.systemPrompt.assemble()
      assert.equal(prompt.tools.length, 19)
      assert.ok(prompt.sections.some(s => s.name === 'ensp:automation'))
      const call = async (name, parameters) => (await ctx.tools.execute({
        calls: [{ type: 'tool_call', id: 'host-check', name, arguments: JSON.stringify(parameters) }],
        signal: new AbortController().signal,
        agent: { session: { header: { cwd } } },
      })).results[0].result
      const scenarios = await call('ensp_scenarios', { query: 'ospf' })
      assert.equal(scenarios.isError, false)
      assert.equal(JSON.parse(scenarios.value.data).total, 23)
      assert.deepEqual(JSON.parse(scenarios.content[0].text), scenarios.value)
      const built = await call('ensp_build', { output_path: 'host.topo', devices: [{ name: 'R1', model: 'AR2220' }] })
      assert.equal(built.isError, false)
      assert.equal(built.value.ok, true)
      const topo = await call('ensp_topo', { action: 'list', topology_path: 'host.topo' })
      assert.equal(topo.isError, false)
      assert.ok(topo.content[0].text.includes('R1'))
      const failed = await call('ensp_project', { action: 'inspect', topology_path: 'host.topo' })
      assert.equal(failed.isError, true)
      assert.equal(failed.value, undefined)
      assert.equal(JSON.parse(failed.content[0].text).devices[0].state, 'missing')
      assert.equal((await call('ensp_build', { output_path: 'invalid.topo' })).isError, true)
      await assert.rejects(access(join(cwd, 'invalid.topo')), { code: 'ENOENT' })
      await mounted.dispose()
      assert.equal(ctx.tools.definitions().length, 0)
      assert.equal((await ctx.skills.list({ cwd })).length, 0)
      assert.ok(!(await ctx.systemPrompt.assemble()).sections.some(s => s.name === 'ensp:automation'))
      return {
        ok: true, version: manifest.version, pluginRoot, runtime, compatibility,
        checks: ['host compatibility without exemptions', 'verified prerelease compatibility boundaries', 'old manifests rejected', '19 tools registered', '2 skills registered and loaded', 'system prompt assembled', 'native executor scenario/build/topology calls', 'ok:false propagated as host error with evidence', 'invalid arguments rejected before writing', 'plugin unload cleanup'],
        limits: ['Isolated host services; does not open or modify a user profile.', 'Does not call a model, open eNSP, or certify device business.'],
      }
    } finally { disposeExecutor() }
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
}

async function main() {
  if (args.includes('--help')) {
    console.log('Usage: npm run check:dsh -- [--app <DeepSeek Harness.exe>] [--plugin-root <installed plugin directory>] [--output <report.json>]\nRead-only isolated check using installed desktop host modules. Does not modify profiles.')
    return
  }
  const output = resolve(option('--output') ?? join(tmpdir(), 'dsh-ensp-fusion', 'dsh-host-check.json'))
  const modules = option('--host-modules')
  if (modules) {
    let report
    try { report = { timestamp: new Date().toISOString(), ...await verify(resolve(modules)) } }
    catch (error) { report = { ok: false, error: error.stack }; process.exitCode = 1 }
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, JSON.stringify(report, null, 2) + '\n')
    return
  }
  const app = resolve(option('--app') ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'))
  await access(app)
  const hostModules = join(dirname(app), 'resources', 'app.asar', 'dsh', 'node_modules')
  const temp = await mkdtemp(join(tmpdir(), 'ensp-host-report-'))
  try {
    const reportPath = join(temp, 'result.json')
    const child = spawnSync(app, ['--expose-internals', fileURLToPath(import.meta.url), '--host-modules', hostModules, '--plugin-root', resolve(option('--plugin-root') ?? root), '--output', reportPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 30000,
    })
    if (child.error) throw child.error
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ ...report, report: output }, null, 2))
    if (child.status !== 0 || !report.ok) process.exitCode = 1
  } finally { await rm(temp, { recursive: true, force: true }) }
}

main().catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1 })
