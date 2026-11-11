import test from 'node:test'
import assert from 'node:assert/strict'
import { generateTopology } from '../lib/fusion-tools.js'
import { interfaceName, interfaceIndex, serialiseTopology, parseTopology } from '../upstream/lizi600jin/src/core/topology.mjs'
import { vrpToFlatIndex } from '../upstream/lizi600jin/src/core/build.mjs'

test('USG6000V management and seven business ports match native eNSP declaration', () => {
  const ports = ['GigabitEthernet0/0/0', ...Array.from({length:7}, (_,i) => `GigabitEthernet1/0/${i}`)]
  for (const [index, name] of ports.entries()) {
    assert.equal(interfaceName('USG6000V', index), name)
    assert.equal(interfaceIndex('USG6000V', name), index)
    assert.equal(vrpToFlatIndex('USG6000V', name), index)
  }
  assert.equal(vrpToFlatIndex('USG6000V', 'GigabitEthernet1/0/7'), null)
  const topo = generateTopology({devices:[{name:'FW',model:'USG6000V'},{name:'SW',model:'S5700'}],links:[{a:'FW',a_port:'GigabitEthernet1/0/1',b:'SW',b_port:'GigabitEthernet0/0/1'}]})
  const xml = serialiseTopology(topo)
  assert.match(xml, /<slot id="1">/)
  assert.match(xml, /slotIndex="1" cardIndex="0" interfaceIndex="6"/)
  const parsed = parseTopology(xml)
  assert.equal(parsed.devices[0].interfaces, 8)
  assert.equal(parsed.links[0].srcIndex, 2)
  assert.equal(parsed.links[0].srcPort, 'GigabitEthernet1/0/1')
})
