import test from 'node:test'
import assert from 'node:assert/strict'
import {parseTopo,validateTopoConsolePorts,validateNativeEndpointSettings,setDeviceIpv4} from '../lib/topo.js'

test('native endpoints reject malformed legacy flags before IP editing or launch',()=>{
 const wrap=settings=>`<topo><dev id="server" name="FILE-01" model="Server" settings="${settings}"/></topo>`
 const good='-domain 0 -eth 54-89-98-44-73-2D -ipaddr 10.20.30.10 -ipmask 255.255.255.240 -gateway 10.20.30.14 -ipv6addr :: -ipv6gateway :: -prefixlen 0 -ipv4dns 0.0.0.0 -ipv6dns :: -dnslist NULL'
 assert.doesNotThrow(()=>validateNativeEndpointSettings(wrap(good)))
 assert.doesNotThrow(()=>validateNativeEndpointSettings(wrap('')))
 for(const settings of [good.replace('-eth 54-89-98-44-73-2D','-eth'),good+' -ipaddr 10.20.30.11',good.replace('10.20.30.10','999.20.30.10'),good.replace('-prefixlen 0','-prefixlen 129')]){
  assert.throws(()=>validateNativeEndpointSettings(wrap(settings)),/Native endpoint FILE-01/u)
  assert.throws(()=>setDeviceIpv4(wrap(settings),'FILE-01',{ip:'10.20.30.12'}),/Native endpoint/u)
 }
})
test('unnamed devices remain visible to inventory and cannot pass GUI port verification',()=>{
 const xml='<topo><devices><dev id="one" name="SW1" com_port="9500"/><dev id="two" name="" com_port="9501"/></devices></topo>'
 assert.deepEqual(parseTopo(xml).devices.map(d=>d.comPort),[9500,9501])
 assert.throws(()=>validateTopoConsolePorts(xml),/missing id or name/u)
 assert.throws(()=>validateTopoConsolePorts(xml.replace('id="two"','id=""')),/missing id or name/u)
})
