import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {readTopo} from '../lib/topo.js';
test('GBK native topology preserves Chinese annotations on read',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ensp-encoding-'));t.after(()=>rm(dir,{recursive:true,force:true}));const p=join(dir,'lab.topo');
 const bytes=Buffer.concat([Buffer.from('<topo><txttip content="'),Buffer.from([0xd6,0xd0,0xce,0xc4]),Buffer.from('"/></topo>')]);await writeFile(p,bytes);
 const result=await readTopo(p);assert.equal(result.encoding,'gb18030');assert.deepEqual(result.annotations,['中文']);
});
