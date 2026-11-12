import test from 'node:test'
import assert from 'node:assert/strict'
import { compareLldp, parseLldp, diagnoseOutput } from '../lib/network-analysis.js'
import { createRegistry } from '../mcp/server.js'
import { topologyLldpLinks } from '../lib/topology-links.js'
import { generateTopology } from '../lib/fusion-tools.js'
import { serialiseTopology } from '../upstream/lizi600jin/src/core/topology.mjs'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const link = { a:'R1', a_port:'GigabitEthernet0/0/0', b:'R2', b_port:'GE0/0/1' }
test('LLDP requires per-link reverse evidence; fresh scans cannot be replaced with stale differences', () => {
  const now = Date.parse('2026-11-11T10:00:00Z'), collected_at = '2026-11-11T09:59:30Z'
  const a = { device: 'R1', output: 'GE0/0/0  R2  GE0/0/1  120', collected_at }
  const empty = { device: 'R2', output: 'no LLDP neighbors', collected_at }
  const result = compareLldp([link], [a, empty], { now, maxAgeMs: 60000 })
  assert.equal(result.status, 'INCONCLUSIVE')
  assert.equal(result.unidirectional.length, 1)
  const b = { device: 'R2', output: 'GE0/0/1  R1  GE0/0/0  120', collected_at }
  assert.equal(compareLldp([link], [a, b], { now, maxAgeMs: 60000 }).status, 'MATCH')
  const stale = { ...a, output: 'GE0/0/0  R3  GE0/0/1  120', collected_at: '2026-11-11T09:00:00Z' }
  assert.equal(compareLldp([link], [stale, b], { now, maxAgeMs: 60000 }).status, 'INCONCLUSIVE')
  assert.equal(compareLldp([link], [a, { ...b, collected_at: undefined }], { now, maxAgeMs: 60000 }).status, 'INCONCLUSIVE')
  assert.equal(compareLldp([link], [a, empty], { now, maxAgeMs: 60000, requireBidirectional: false }).status, 'MATCH')
})

test('native declared indices map USG slots and exclude endpoint links without guessing unknown ports', () => {
  const xml = serialiseTopology(generateTopology({ devices: [{ name: 'FW', model: 'USG6000V' }, { name: 'SW', model: 'S5700' }, { name: 'PC', model: 'PC' }],
    links: [{ a: 'FW', a_port: 'GigabitEthernet1/0/1', b: 'SW', b_port: 'GigabitEthernet0/0/2' },
      { a: 'PC', a_port: 'Ethernet0/0/1', b: 'SW', b_port: 'GigabitEthernet0/0/1' }] }))
  const result = topologyLldpLinks(xml)
  assert.equal(result.links.length, 1)
  assert.equal(result.links[0].a_port, 'GigabitEthernet1/0/1')
  assert.equal(result.excluded.length, 1)
  const broken = xml.replace(/srcIndex="\d+"/u, 'srcIndex="999"')
  assert.equal(topologyLldpLinks(broken).unresolved.length, 1)
  assert.ok(topologyLldpLinks(xml.replace('interfacename="GE" count="24"', 'interfacename="Ethernet" count="24"')).unresolved.length)
  assert.throws(() => topologyLldpLinks('<!DOCTYPE topo>' + xml), /DTD/)
})

test('legacy model metadata and mixed Ethernet/GE declarations resolve declared indices', () => {
  const xml = serialiseTopology(generateTopology({ devices: [{ name: 'FW', model: 'USG5500' }, { name: 'SW', model: 'S3700' }],
    links: [{ a: 'FW', a_port: 'GigabitEthernet0/0/0', b: 'SW', b_port: 'GigabitEthernet0/0/1' }] }))
  assert.deepEqual(topologyLldpLinks(xml).links, [{ a: 'FW', a_port: 'GigabitEthernet0/0/0', b: 'SW', b_port: 'GigabitEthernet0/0/1' }])
})

test('LLDP topo_path, name mapping, timestamps and workspace junction boundaries integrate', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ensp-lldp-')), outside = await mkdtemp(join(tmpdir(), 'ensp-lldp-out-'))
  t.after(() => rm(root, { recursive: true, force: true })); t.after(() => rm(outside, { recursive: true, force: true }))
  const xml = serialiseTopology(generateTopology({ devices: [{ name: 'R1', model: 'AR2220' }, { name: 'R2', model: 'AR2220' }], links: [{ ...link, b_port: 'GigabitEthernet0/0/1' }] }))
  await writeFile(join(root, 'pair.topo'), xml)
  await writeFile(join(outside, 'pair.topo'), xml)
  const r = createRegistry({ workspace: root }), tool = r.tools.find(tool => tool.name === 'ensp_lldp')
  const args = { topo_path: 'pair.topo', name_map: [{ topology_name: 'R1', sysname: 'actual-R1' }], observations: [
    { device: 'actual-R1', output: 'GE0/0/0  R2  GE0/0/1  120', collected_at: new Date().toISOString() },
    { device: 'R2', output: 'GE0/0/1  actual-R1  GE0/0/0  120', collected_at: new Date().toISOString() },
  ] }
  const result = await tool.handler(args, r.exec)
  assert.equal(JSON.parse(result.data).status, 'MATCH', JSON.stringify(result))
  assert.equal(JSON.parse((await tool.handler({ ...args, observations: args.observations.map(({ collected_at, ...o }) => o) }, r.exec)).data).status, 'INCONCLUSIVE')
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await tool.handler({ ...args, topo_path: 'escape/pair.topo' }, r.exec)).ok, false)
})
test('LLDP reversals and interface abbreviations deduplicate; missing coverage is explicit', () => {
  const a = { device:'R1', output:'GE0/0/0  R2  GE0/0/1  120' }
  const b = { device:'R2', output:'GE0/0/1  R1  GE0/0/0  120' }
  assert.equal(compareLldp([link],[a,b]).status,'MATCH')
  assert.equal(compareLldp([link],[a,b]).matched.length,1)
  assert.equal(compareLldp([link],[a]).status,'INCONCLUSIVE')
  assert.equal(compareLldp([link],[]).status,'INCONCLUSIVE')
  assert.equal(compareLldp([link],[{device:'R1',output:'Error: LLDP is not enabled'}]).scans[0].status,'ERROR')
})
test('mismatch retains parallel-link evidence and unrelated observed links', () => {
  const result = compareLldp([link],[{ device:'R1', output:'GE0/0/2  R2  GE0/0/1  120\nGE0/0/3  R3  GE0/0/0  120' }])
  assert.equal(result.status,'DIFFERENT')
  assert.equal(result.mismatched.length,1)
  assert.equal(result.lldp_only.length,2)
})
test('detail parsing preserves fields separated by blank lines and multiple neighbors', () => {
  const output = 'LLDP neighbor-information of port GE0/0/0:\nNeighbor index : 1\nPort ID : GE0/0/1\n\nSystem name : R2\nNeighbor index : 2\nPort ID : GE0/0/2\nSystem name : R3'
  assert.equal(parseLldp('R1',output).neighbors.length,2)
  assert.equal(parseLldp('R1','unexpected garbage').status,'UNKNOWN')
})
test('diagnostic rules distinguish unknown from good health and parse decimal ping loss', () => {
  assert.equal(diagnoseOutput('Everything looks fine').status,'UNKNOWN')
  assert.equal(diagnoseOutput('Error: Unrecognized command').findings[0].category,'unrecognized_command')
  assert.equal(diagnoseOutput('25.5% packet loss').findings[0].loss_percent,25.5)
  assert.equal(diagnoseOutput('operation timed out').findings[0].category,'timeout')
})
test('USG real detail format handles SysName/PortId and does not infer identity from brief', () => {
  const brief = 'Interface GigabitEthernet1/0/1 has 1 Neighbors:\nNeighbor 1:\n    PortId: GigabitEthernet0/0/2\nInterface GigabitEthernet1/0/2 has 0 Neighbors:'
  assert.equal(parseLldp('FW', brief).status, 'UNKNOWN')
  const detail = brief.replace('    PortId:', '    SysName: SW\n    PortId:')
  const scan = parseLldp('FW', detail)
  assert.equal(scan.status, 'OK')
  assert.deepEqual(scan.neighbors, [{ a:'FW',a_port:'GigabitEthernet1/0/1',b:'SW',b_port:'GigabitEthernet0/0/2' }])
  assert.equal(diagnoseOutput('Error:The global LLDP function is disabled.').findings[0].category, 'lldp_disabled')
})
test('new tools share the registry and enforce runtime validation', async () => {
  const r = createRegistry()
  const call = (name,args) => r.tools.find(t => t.name === name).handler(args,r.exec)
  assert.equal((await call('ensp_diagnose',{output:'Error: Incomplete command'})).ok,true)
  await assert.rejects(call('ensp_lldp',{links:[{}],observations:[]}), /missing required property/u)
  assert.equal((await call('ensp_lldp',{links:[{a:'',a_port:'GE0/0/0',b:'R2',b_port:'GE0/0/1'}],observations:[]})).ok,false)
  assert.equal((await call('ensp_inspect',{port:0})).ok,false)
})
