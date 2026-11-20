import test from 'node:test'
import assert from 'node:assert/strict'
import { topologyLayout } from '../lib/topology-layout.js'

const source = '<topo><devices><dev id="a" name="核心" model="S5700" settings="a &gt; b" cx="100" cy="100" edit_left="100" edit_top="100"/></devices>' +
  '<txttips><txttip left="100" top="100" right="124" bottom="115" content="1.2"/></txttips>' +
  '<shapes><shape type="1" upleftcorner="100,100" width="26" height="18"/></shapes>' +
  '<extension><dev id="other" cx="1" edit_left="100"/></extension><!-- <dev edit_left="100"/> --><![CDATA[<dev/>]]></topo>'

test('local correction preserves opaque XML and moves each matched badge with its text', () => {
  const inspected = topologyLayout(source)
  const applied = topologyLayout(source,{ correct:true })
  assert.equal(inspected.text, source)
  assert.ok(applied.report.after.count < inspected.report.before.count)
  assert.equal(topologyLayout(applied.text).report.semanticHash, inspected.report.semanticHash)
  assert.equal(topologyLayout(applied.text).report.before.count, applied.report.after.count)
  const [,left,top] = /<txttip left="([^"]+)" top="([^"]+)"/u.exec(applied.text)
  assert.ok(applied.text.includes('upleftcorner="'+left+','+top+'"'))
  assert.ok(applied.text.endsWith(source.slice(source.indexOf('<extension>'))))
  assert.equal(applied.report.nativeVisualVerified,false)
  assert.equal(applied.text,topologyLayout(source,{ correct:true }).text)
})

test('unsupported native bounds are reported and malformed input cannot create a proposal', () => {
  const input = source.replace('right="124"', 'unknown="124"')
  assert.ok(topologyLayout(input,{ correct:true }).report.unsupported.includes('tip:0'))
  assert.throws(() => topologyLayout(source.replace('</devices>','</lines>')), /unbalanced/)
})


test('detects centred names, clipped labels and a port label crossed by its own cable', () => {
  const xml = '<topo><devices><dev id="a" name="Core-LSW1" cx="36" cy="100" edit_left="8" edit_top="104"/></devices>' +
    '<lines><line srcDeviceID="a" destDeviceID="b"><interfacePair srcBoundRect_X="110" srcBoundRect_Y="110" srcBoundRectIsMoved="0" srcOffset_X="0" srcOffset_Y="0" tarBoundRect_X="210" tarBoundRect_Y="150" tarBoundRectIsMoved="0" tarOffset_X="0" tarOffset_Y="0"/></line></lines></topo>'
  const before = topologyLayout(xml).report.before.examples
  assert.ok(before.some(p => p.includes('name:a') && p.includes('canvas:origin')))
  assert.ok(before.some(p => p.includes('pair:0') && p.includes('pair:0:src')))
  const result = topologyLayout(xml,{ correct:true })
  assert.equal(result.report.after.count,0)
  assert.equal(topologyLayout(result.text).report.before.count,0)
})
