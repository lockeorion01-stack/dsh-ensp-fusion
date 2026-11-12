import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { generateLab, resolveLabPlan, topologyDiagram, writeTopologyDiagram } from '../lib/lab-plan.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fixturePath = join(root, 'test/fixtures/minimal.topo')
const fixture = await readFile(fixturePath, 'utf8')
const cli = join(root, 'bin/dsh-ensp-lab.mjs')

async function setup(t, xml = fixture) {
  const dir = await mkdtemp(join(tmpdir(), 'ensp-lab-plan-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const topology = join(dir, 'base.topo')
  const plan = join(dir, 'input.json')
  const out = join(dir, 'generated')
  await writeFile(topology, xml)
  const input = { topology: 'base.topo', devices: [{ device: 'SW1', commands: ['display version'] }] }
  const save = (value = input) => writeFile(plan, JSON.stringify(value))
  await save()
  return { dir, topology, plan, out, input, save }
}

test('generate resolves relative topology, templates and metadata; copies exact BOM/CRLF bytes', async (t) => {
  const f = await setup(t, '\uFEFF' + fixture.replace(/\r?\n/gu, '\r\n'))
  f.input.templates = { vlan: ['sysname {{name}}', 'vlan {{id}}', 'description {{enabled}}'] }
  f.input.devices = [
    { device: 'SW1', template: 'vlan', vars: { name: 'Edge $&', id: 10, enabled: true }, expect: [null, ['{{id}}']], system_view: true, save: false },
    { device: 'PC1', commands: ['ping 192.0.2.1'] },
  ]
  await f.save()
  const result = await generateLab(f)
  assert.deepEqual(await readFile(join(f.out, 'topology.topo')), await readFile(f.topology))
  assert.deepEqual(result.plan.devices, [
    { device: 'SW1', port: 2001, commands: ['sysname Edge $&', 'vlan 10', 'description true'], expect: [null, ['10']], system_view: true, save: false },
    { device: 'PC1', port: 0, commands: ['ping 192.0.2.1'] },
  ])
  assert.equal(await readFile(join(f.out, '001-device.txt'), 'utf8'), 'sysname Edge $&\nvlan 10\ndescription true\n')
  assert.deepEqual(JSON.parse(await readFile(join(f.out, 'plan.json'), 'utf8')), result.plan)
  assert.equal(result.plan.topology, 'topology.topo')
  assert.deepEqual((await readdir(f.out)).sort(), ['001-device.txt', '002-device.txt', 'plan.json', 'topology.topo'])
})

test('every invalid plan is rejected before any output is created', async (t) => {
  const f = await setup(t)
  const bad = [
    ['missing device', { devices: [{ device: 'unknown', commands: ['display version'] }] }, /not found/],
    ['duplicate device', { devices: [f.input.devices[0], f.input.devices[0]] }, /duplicate plan device/],
    ['empty devices', { devices: [] }, /nonempty/],
    ['empty commands', { devices: [{ device: 'SW1', commands: [] }] }, /nonempty/],
    ['blank command', { devices: [{ device: 'SW1', commands: ['  '] }] }, /nonempty/],
    ['multiline command', { devices: [{ device: 'SW1', commands: ['one\ntwo'] }] }, /single-line/],
    ['missing variable', { devices: [{ device: 'SW1', commands: ['sysname {{missing}}'] }] }, /missing variable/],
    ['prototype variable', { devices: [{ device: 'SW1', commands: ['sysname {{constructor}}'] }] }, /missing variable/],
    ['unknown variable', { devices: [{ device: 'SW1', commands: ['display version'], vars: { typo: 'x' } }] }, /unknown\/unused/],
    ['newline variable', { devices: [{ device: 'SW1', commands: ['sysname {{x}}'], vars: { x: 'x\rquit' } }] }, /single-line/],
    ['unicode newline', { devices: [{ device: 'SW1', commands: ['sysname {{x}}'], vars: { x: 'x\u2028quit' } }] }, /single-line/],
    ['nested variable', { devices: [{ device: 'SW1', commands: ['sysname {{x}}'], vars: { x: '{{y}}' } }] }, /nested/],
    ['object variable', { devices: [{ device: 'SW1', commands: ['sysname {{x}}'], vars: { x: {} } }] }, /finite number/],
    ['malformed token', { devices: [{ device: 'SW1', commands: ['sysname {{ bad }}'] }] }, /invalid placeholder/],
    ['unknown template', { devices: [{ device: 'SW1', template: 'constructor' }] }, /unknown template/],
    ['both sources', { templates: { a: ['display version'] }, devices: [{ device: 'SW1', commands: ['display version'], template: 'a' }] }, /exactly one/],
    ['unknown field', { devices: [{ ...f.input.devices[0], port: 23 }] }, /unknown field/],
    ['invalid boolean', { devices: [{ ...f.input.devices[0], save: 'false' }] }, /boolean/],
    ['invalid expect', { devices: [{ ...f.input.devices[0], expect: ['a', 'b'] }] }, /no longer/],
    ['invalid late device', { devices: [f.input.devices[0], { device: 'SW2', commands: [''] }] }, /nonempty/],
    ['missing topology', { topology: 'absent.topo' }, /ENOENT/],
  ]
  for (const [label, patch, error] of bad) {
    await f.save({ ...f.input, ...patch })
    await assert.rejects(generateLab(f), error, label)
    assert.equal((await readdir(f.dir)).includes('generated'), false, label)
  }
  await writeFile(f.plan, '{broken')
  await assert.rejects(generateLab(f), SyntaxError)
  assert.equal((await readdir(f.dir)).includes('generated'), false)
})

test('topology names, IDs, and raw console ports are validated across all devices', async (t) => {
  const f = await setup(t)
  const bad = [
    [fixture.replace('name="SW2"', 'name="sw1"'), /duplicate topology device name/],
    [fixture.replace('id="2"', 'id="1"'), /duplicate topology device ID/],
    [fixture.replace('name="SW2"', ''), /topology device name must be a nonempty/],
    ...['-1', '65536', '2001x', '2.5', '', '0', '1e3'].map((port) => [fixture.replace('com_port="2002"', `com_port="${port}"`), /invalid com_port/]),
    [fixture.replace('com_port="2002"', 'com_port="2001"'), /duplicate com_port/],
    [fixture.replace('com_port="2002"', ''), /invalid com_port/],
    ['<topo></topo>', /missing device/],
    ['not xml', /unsupported topology/],
  ]
  for (const [xml, error] of bad) {
    await writeFile(f.topology, xml)
    await assert.rejects(generateLab(f), error)
    assert.equal((await readdir(f.dir)).includes('generated'), false)
  }
  await writeFile(f.topology, fixture.replace('</devices>', '<dev id="4" name="PC2" model="PC" com_port="0"/></devices>'))
  await resolveLabPlan(f.plan) // Multiple PC zero ports are intentionally valid.
})

test('device names cannot escape output directory; overwrite is refused', async (t) => {
  const f = await setup(t, fixture.replace('name="SW1"', 'name="../../CON:bad\\name"'))
  f.input.devices[0].device = '../../CON:bad\\name'
  await f.save()
  await generateLab(f)
  const original = await readFile(join(f.out, '001-device.txt'))
  await assert.rejects(generateLab(f), /refusing to overwrite/)
  assert.deepEqual(await readFile(join(f.out, '001-device.txt')), original)
  const empty = join(f.dir, 'empty')
  await mkdir(empty)
  await assert.rejects(generateLab({ plan: f.plan, out: empty }), /refusing to overwrite/)
  assert.deepEqual(await readdir(empty), [])
})

test('fixture and checked-in example produce device-only diagrams and a valid lab', async (t) => {
  const f = await setup(t)
  const diagram = await topologyDiagram(fixturePath)
  assert.deepEqual(diagram.warnings, [])
  assert.equal(diagram.mermaid, await readFile(join(root, 'examples/minimal.mmd'), 'utf8'))
  const result = await generateLab({ plan: join(root, 'examples/lab-plan.json'), out: f.out })
  assert.equal(result.plan.devices[0].commands[1], 'vlan 10')
})

test('known eNSP line schema preserves parallel pairs, endpoints, and escaped labels', async (t) => {
  const xml = fixture.replace('name="SW1"', 'name="SW1 &quot;] --&gt; bad &amp; &lt;b&gt;#quot;"')
    .replace('</topo>', `<lines>
      <line srcDeviceID="1" destDeviceID="2">
        <interfacePair srcIndex="0" tarIndex="1"/>
        <interfacePair srcIndex="2" destIndex="3"/>
        <interfacePair srcIndex="GE&quot;|&lt;b&gt;" tarIndex="4"/>
      </line>
    </lines></topo>`)
  const f = await setup(t, xml)
  const result = await topologyDiagram(f.topology)
  assert.deepEqual(result.warnings, [])
  assert.match(result.mermaid, /d1\["SW1 #34;#93; #45;#45;#62; bad #38; #60;b#62;#35;quot#59;"\]/u)
  assert.match(result.mermaid, /d1 ---\|"0 ↔ 1"\| d2/u)
  assert.match(result.mermaid, /d1 ---\|"2 ↔ 3"\| d2/u)
  assert.match(result.mermaid, /GE#34;#124;#60;b#62; ↔ 4/u)
  assert.equal(result.mermaid.includes('<b>'), false)
  assert.equal(result.mermaid.includes('bad &'), false)
})

test('unknown link schemas, IDs, missing ports warn and never invent edges', async (t) => {
  const f = await setup(t, fixture.replace('</topo>', `<lines>
    <line source="1" target="2"/>
    <line srcDeviceID="1" destDeviceID="missing"><interfacePair srcIndex="0" tarIndex="1"/></line>
    <line srcDeviceID="1" destDeviceID="2"><interfacePair srcIndex="0"/></line>
    </lines><links><link from="1" to="2"/></links></topo>`))
  const result = await topologyDiagram(f.topology)
  assert.equal(result.warnings.length, 4)
  assert.equal(result.mermaid.includes('---'), false)
  const out = join(f.dir, 'diagram.mmd')
  await writeTopologyDiagram({ topology: f.topology, out })
  await assert.rejects(writeTopologyDiagram({ topology: f.topology, out }), /refusing to overwrite/)
  assert.equal(await readFile(out, 'utf8'), result.mermaid)
})

test('commented devices and links are ignored', async (t) => {
  const f = await setup(t, fixture.replace('</topo>', '<!-- <dev id="1" name="bad"/><lines><line srcDeviceID="1" destDeviceID="2"><interfacePair srcIndex="1" tarIndex="2"/></line></lines> --></topo>'))
  await resolveLabPlan(f.plan)
  const result = await topologyDiagram(f.topology)
  assert.deepEqual(result.warnings, [])
  assert.equal(result.mermaid.includes('bad'), false)
  assert.equal(result.mermaid.includes('---'), false)
})

function run(args, cwd, extra = []) {
  return spawnSync(process.execPath, [...extra, cli, ...args], { cwd, encoding: 'utf8' })
}

// Intercept only the dynamic registry import in child processes. No real device
// commands or network connections are made by these acceptance-CLI tests.
async function registryStub(dir, source) {
  const hook = join(dir, 'registry-hook.mjs')
  await writeFile(hook, `import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, next) {
      if (url.endsWith('/mcp/server.js')) return {format:'module', shortCircuit:true, source:${JSON.stringify(source)}};
      return next(url, context);
    }});`)
  return ['--import', pathToFileURL(hook).href]
}

test('CLI offline paths never load registry; help, warnings, errors and overwrite are clear', async (t) => {
  const f = await setup(t)
  const extra = await registryStub(f.dir, 'throw new Error("offline command loaded registry")')
  assert.equal(run(['--help'], f.dir, extra).status, 0)
  assert.match(run(['test', '--help'], f.dir, extra).stdout, /only subcommand that may connect/u)
  assert.equal(run(['generate', '--plan', 'input.json', '--out', 'generated'], f.dir, extra).status, 0)
  assert.equal(run(['generate', '--plan', 'input.json', '--out', 'generated'], f.dir, extra).status, 2)
  await writeFile(f.topology, fixture.replace('</topo>', '<links><link from="1" to="2"/></links></topo>'))
  const diagram = run(['diagram', '--topology', 'base.topo', '--out', 'diagram.mmd'], f.dir, extra)
  assert.equal(diagram.status, 0, diagram.stderr)
  assert.match(diagram.stderr, /Warning:.*unrecognized/u)
  for (const args of [
    ['nope'], ['generate', '--plan'], ['generate', '--plan', 'input.json'],
    ['generate', '--plan', 'input.json', '--plan', 'input.json', '--out', 'other'],
    ['diagram', '--topology', 'base.topo', '--out', 'x', '--workspace', '.'],
    ['test', '--plan', 'input.json', '--out', 'x', '--wat', 'value'],
  ]) assert.equal(run(args, f.dir, extra).status, 2, JSON.stringify(args))
})

test('explicit test CLI delegates absolute paths, workspace and exec; uses exit 0/1/2', async (t) => {
  const f = await setup(t)
  for (const ok of [true, false]) {
    const extra = await registryStub(f.dir, `export function createRegistry(options) {
      const exec = {sentinel: true};
      return {exec, tools: [{name:'ensp_labtest', async handler(args, context) {
        if (context !== exec) throw new Error('incorrect exec context');
        return {ok:${ok}, options, args};
      }}]};
    }`)
    for (const workspace of [undefined, join(f.dir, 'workspace')]) {
      const args = ['test', '--plan', 'input.json', '--out', 'reports/result']
      if (workspace) args.push('--workspace', workspace)
      const result = run(args, f.dir, extra)
      assert.equal(result.status, ok ? 0 : 1, result.stderr)
      const report = JSON.parse(result.stdout)
      assert.deepEqual(report.args, { plan_path: f.plan, report_prefix: resolve(f.dir, 'reports/result'), allow_overwrite: false })
      assert.equal(report.options.workspace, workspace ?? f.dir)
    }
  }
  for (const source of [
    'export function createRegistry() {return {tools:[]}}',
    'export function createRegistry() {throw new Error("validation exception")}',
    'export function createRegistry() {return {tools:[{name:"ensp_labtest",handler(){throw new Error("bad plan")}}]}}',
    'export function createRegistry() {return {tools:[{name:"ensp_labtest",handler(){return {}}}]}}',
  ]) {
    const extra = await registryStub(f.dir, source)
    const result = run(['test', '--plan', 'input.json', '--out', 'report'], f.dir, extra)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Error:/u)
  }
})
