import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, mkdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SCENARIO_IDS } from '../upstream/lizi600jin/src/core/presets.mjs'
import { parseTopology, serialiseTopology } from '../upstream/lizi600jin/src/core/topology.mjs'
import { addressCommand, describeScenario, prepareScenario, scenarioSupport, generateScenarioLab } from '../lib/scenario-lab.js'
import { generateTopology } from '../lib/topology-builder.js'
import { prepareCliEntries } from '../lib/cli-plan.js'
import { createRegistry } from '../mcp/server.js'

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ensp-scenario-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('every supported blueprint builds with valid unique ports, links and CLI entries', () => {
  assert.equal(SCENARIO_IDS.length, 50)
  let supported = 0
  const blocked = []
  for (const id of SCENARIO_IDS) {
    if (!scenarioSupport(id).supported) { blocked.push(id); continue }
    const prepared = prepareScenario(id)
    const parsed = parseTopology(serialiseTopology(prepared.topology))
    assert.equal(parsed.devices.length, prepared.devices.length, id)
    assert.equal(parsed.links.length, prepared.links.length, id)
    const ports = parsed.devices.map(device => device.comPort).filter(Boolean)
    assert.equal(new Set(ports).size, ports.length, id)
    if (prepared.configuration.devices.length) {
      const entries = prepareCliEntries({ devices: prepared.configuration.devices }, parsed.devices)
      assert.equal(entries.length, prepared.configuration.devices.length, id)
      assert.ok(entries.every(entry => entry.save === false && entry.system_view === true), id)
    }
    supported++
  }
  assert.equal(supported, 47)
  assert.deepEqual(blocked, ['ppp-hdlc', 'wlan-basic', 'wlan-roaming'])
})

test('CIDR conversion enforces family limits and does not wrap IPv4 prefix shifts', () => {
  assert.equal(addressCommand('0.0.0.0/0'), 'ip address 0.0.0.0 0.0.0.0')
  assert.equal(addressCommand('192.0.2.1/32'), 'ip address 192.0.2.1 255.255.255.255')
  assert.equal(addressCommand('192.0.2.1/24'), 'ip address 192.0.2.1 255.255.255.0')
  assert.equal(addressCommand('2001:db8::1/64'), 'ipv6 address 2001:db8::1/64')
  for (const invalid of ['192.0.2.1/33', '192.0.2.1/', '999.1.1.1/24', '2001:db8::1/129',
    '2001:db8::1/-1', '192.0.2.1/2e1', '192.0.2.1/24/reboot', '192.0.2.1\nreboot/24']) {
    assert.throws(() => addressCommand(invalid), /CIDR/)
  }
})

test('IPv6 and Vlanif scaffolds include prerequisites but no invented protocol configuration', () => {
  const v6 = prepareScenario('ipv6').configuration.devices
  assert.ok(v6.some(device => device.commands.includes('ipv6')))
  for (const device of v6) {
    for (const [index, command] of device.commands.entries()) {
      if (command.startsWith('ipv6 address')) assert.equal(device.commands[index - 1], 'ipv6 enable')
    }
    assert.ok(!device.commands.some(command => /^ospf|^bgp|^save$/u.test(command)))
  }
  const vlan = prepareScenario('vlanif-routing').configuration.devices[0].commands
  assert.ok(vlan.indexOf('vlan 10') < vlan.indexOf('interface Vlanif10'))
})

test('DHCP PCs carry no accidental static addresses and reject ambiguous settings', () => {
  const { topology } = prepareScenario('dhcp')
  const pcs = topology.devices.filter(device => device.model === 'PC')
  assert.equal(pcs.length, 2)
  for (const pc of pcs) {
    assert.match(pc.settings, /-simpc_dhcp_state 1 /u)
    assert.match(pc.settings, /-simpc_ip 0\.0\.0\.0 /u)
    assert.match(pc.settings, /-simpc_dns_auto_state 1 /u)
  }
  assert.throws(() => generateTopology({ devices: [{ name: 'PC1', model: 'PC', options: { pc: { dhcp: true, ip: '192.0.2.1' } } }] }), /cannot be combined/)
  assert.throws(() => generateTopology({ devices: [{ name: 'S1', model: 'Server', options: { pc: { dhcp: true } } }] }), /PC/)
})

test('native Server addresses go into topology settings with an explicit unset gateway', () => {
  for (const id of ['firewall-zones', 'campus-network']) {
    const prepared = prepareScenario(id)
    const server = prepared.topology.devices.find(device => device.name === 'SRV1')
    assert.match(server.settings, /-ipaddr 10\.1\.40\.10 /u)
    assert.match(server.settings, /-ipmask 255\.255\.255\.0 /u)
    assert.match(server.settings, /-gateway 0\.0\.0\.0 /u)
    assert.ok(!prepared.configuration.devices.some(device => device.device === 'SRV1'))
    assert.ok(prepared.notes.some(note => note.includes('SRV1') && note.includes('no default gateway')))
  }
})

test('unknown and unsupported scenarios fail before claiming output directories', async t => {
  const dir = await workspace(t)
  for (const id of ['__proto__', 'constructor', 'missing', 'ppp-hdlc', 'wlan-basic', 'wlan-roaming']) {
    const out = join(dir, id)
    await assert.rejects(generateScenarioLab({ id, out }), /unknown scenario|cannot be generated/)
    await assert.rejects(access(out), { code: 'ENOENT' })
  }
  await assert.rejects(generateScenarioLab({ id: 'ospf-single', out: join(dir, 'bad-port'), first_com_port: 9999 }), /comPort/)
  assert.equal((await readdir(dir)).length, 0)
  assert.equal(describeScenario('wlan-basic').generation.supported, false)
})

test('generated lab plans preview through the real registry and never overwrite files', async t => {
  const dir = await workspace(t), out = join(dir, 'ospf')
  const generated = await generateScenarioLab({ id: 'ospf-single', out })
  assert.equal(generated.summary.devices, 3)
  const plan = JSON.parse(await readFile(join(out, 'cli-plan.json'), 'utf8'))
  assert.equal(plan.dry_run, true)
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.files, generated.files)
  assert.deepEqual((await readdir(out)).sort(), [...generated.files].sort())
  const registry = createRegistry({ workspace: out })
  const result = await registry.tools.find(tool => tool.name === 'ensp_cli').handler(plan, registry.exec)
  assert.equal(result.ok, true, JSON.stringify(result))
  const original = await readFile(join(out, 'topology.topo'))
  await assert.rejects(generateScenarioLab({ id: 'ospf-single', out }), /overwrite/)
  assert.deepEqual(await readFile(join(out, 'topology.topo')), original)
  const empty = join(dir, 'empty')
  await mkdir(empty)
  await assert.rejects(generateScenarioLab({ id: 'ospf-single', out: empty }), /overwrite/)
  const layer2 = await generateScenarioLab({ id: 'vlan-access', out: join(dir, 'l2') })
  assert.equal(layer2.configuration_available, false)
  assert.ok(!layer2.files.includes('cli-plan.json'))
})

test('MCP/DSH shared handlers expose rich scenarios and exclusive scenario topology generation', async t => {
  const dir = await workspace(t), registry = createRegistry({ workspace: dir })
  const call = (name, args) => registry.tools.find(tool => tool.name === name).handler(args, registry.exec)
  const scenarios = JSON.parse((await call('ensp_scenarios', {})).data)
  assert.equal(scenarios.total, 50)
  assert.equal(scenarios.scenarios.filter(item => item.generation.supported).length, 47)
  const details = JSON.parse((await call('ensp_scenarios', { id: 'ospf-single' })).data)
  assert.equal(details.devices.length, 3)
  assert.equal(details.addressing.length, 9)
  const built = await call('ensp_build', { scenario_id: 'ospf-single', output_path: 'lab.topo', first_com_port: 2200 })
  assert.equal(built.ok, true, built.error)
  const value = JSON.parse(built.data)
  assert.equal(value.cli_plan.dry_run, true)
  assert.equal(value.scenario.scope, 'addressing-only')
  assert.equal(value.summary.consoles.R1, 2200)
  assert.equal((await call('ensp_cli', value.cli_plan)).ok, true)
  assert.equal((await call('ensp_build', { scenario_id: 'ospf-single', output_path: 'lab.topo' })).ok, false)
  assert.equal((await call('ensp_build', { scenario_id: 'ospf-single', devices: [], output_path: 'mixed.topo' })).ok, false)
  assert.equal((await call('ensp_build', { scenario_id: 'wlan-basic', output_path: 'unsupported.topo' })).ok, false)
  assert.equal((await call('ensp_build', { scenario_id: 'ospf-single', output_path: '../outside.topo' })).ok, false)
})

test('scenario CLI works outside the source directory without runtime dependencies', async t => {
  const dir = await workspace(t), out = join(dir, 'ospf')
  const cli = fileURLToPath(new URL('../bin/dsh-ensp-lab.mjs', import.meta.url))
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', timeout: 10000, windowsHide: true })
  const result = run('scenario', '--id', 'ospf-single', '--out', out, '--first-com-port', '2400')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(parseTopology(await readFile(join(out, 'topology.topo'), 'utf8')).devices[0].comPort, 2400)
  assert.equal(run('scenario', '--id', 'ospf-single', '--out', out).status, 2)
  assert.equal(run('scenario', '--id', 'ospf-single', '--out', join(dir, 'bad'), '--first-com-port', 'NaN').status, 2)
})
