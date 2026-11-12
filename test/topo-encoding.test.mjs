import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {readTopo,writeTopo,renameDevice} from '../lib/topo.js';
import {readTopology,writeTopology} from '../upstream/lizi600jin/src/core/topology.mjs';
test('GBK native topology preserves Chinese annotations on read',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ensp-encoding-'));t.after(()=>rm(dir,{recursive:true,force:true}));const p=join(dir,'lab.topo');
 const bytes=Buffer.concat([Buffer.from('<topo><txttip content="'),Buffer.from([0xd6,0xd0,0xce,0xc4]),Buffer.from('"/></topo>')]);await writeFile(p,bytes);
 const result=await readTopo(p);assert.equal(result.encoding,'gb18030');assert.deepEqual(result.annotations,['中文']);
});

test('editing a native GB18030 topology preserves native bytes and Chinese text',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ensp-encoding-'));t.after(()=>rm(dir,{recursive:true,force:true}));const p=join(dir,'source.topo'),out=join(dir,'edited.topo');
 const bytes=Buffer.concat([Buffer.from('<?xml version="1.0" encoding="UNICODE"?><topo><dev id="x" name="SW" model="S5700" com_port="9500"/><txttip content="'),Buffer.from([0xd6,0xd0,0xce,0xc4]),Buffer.from('"/></topo>')]);
 await writeFile(p,bytes);const source=await readTopo(p);
 await writeTopo(out,renameDevice(source.text,'SW','交换机'),{encoding:source.encoding,flag:'wx'});
 const result=await readTopo(out);assert.equal(result.encoding,'gb18030');assert.equal(result.devices[0].name,'交换机');assert.deepEqual(result.annotations,['中文']);assert.deepEqual(await readFile(p),bytes);
 await assert.rejects(writeTopo(out,result.text,{encoding:source.encoding,flag:'wx'}),/EEXIST/);
 const bad=join(dir,'bad.topo');await assert.rejects(writeTopo(bad,result.text,{encoding:'unknown'}),/Unsupported/);await assert.rejects(access(bad));
});

for(const encoding of ['utf-8','utf-16le','utf-16be'])test(`topology ${encoding} edit roundtrip`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ensp-encoding-'));t.after(()=>rm(dir,{recursive:true,force:true}));const p=join(dir,'lab.topo');
 await writeTopo(p,'<topo><txttip content="中文"/></topo>',{encoding});const result=await readTopo(p);assert.equal(result.encoding,encoding);assert.deepEqual(result.annotations,['中文']);
});

test('exported topology writer emits native Chinese names in GB18030',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ensp-encoding-'));t.after(()=>rm(dir,{recursive:true,force:true}));const p=join(dir,'built.topo');
 await writeTopology(p,{devices:[{id:'one',name:'核心交换机',model:'S5700',comPort:9500,x:10,y:20}],links:[]});
 const native=await readTopo(p),parsed=await readTopology(p);assert.equal(native.encoding,'gb18030');assert.equal(native.devices[0].name,'核心交换机');assert.equal(parsed.devices[0].name,'核心交换机');assert.equal(parsed.encoding,'gb18030');
});
