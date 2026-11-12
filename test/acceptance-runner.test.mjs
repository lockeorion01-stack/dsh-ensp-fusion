import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,unlink,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {runAcceptance} from '../lib/acceptance-runner.js'
async function root(t){const dir=await mkdtemp(join(tmpdir(),'ensp-accept-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir}
test('failed partial mutation still cleans up LIFO, preserves failure and redacts evidence',async t=>{
 const seen=[],outputRoot=await root(t)
 const plan={version:1,deadline_ms:1000,steps:[{name:'first',tool:'cli',args:{password:'test-secret'},cleanup:{tool:'undo',args:{}}},{name:'second',tool:'bad',args:{},cleanup:{tool:'undo2',args:{}}},{name:'never',tool:'cli',args:{}}]}
 const r=await runAcceptance({plan,outputRoot,tools:['cli','bad','undo','undo2'],execute:async name=>{seen.push(name);return {ok:name!=='bad',output:'test-secret'}}})
 assert.deepEqual(seen,['cli','bad','undo2','undo']);assert.equal(r.ok,false);assert.equal(r.status,'FAIL')
 assert.doesNotMatch(await readFile(join(r.run_dir,'summary.json'),'utf8'),/test-secret/u)
 assert.doesNotMatch(await readFile(join(r.run_dir,'first-1.json'),'utf8'),/test-secret/u)
 assert.equal(JSON.parse(await readFile(join(r.run_dir,'summary.json'),'utf8')).incomplete,true)
})
test('cleanup failure overrides successful probes and output runs never collide',async t=>{
 const outputRoot=await root(t),plan={version:1,deadline_ms:1000,steps:[{name:'change',tool:'cli',args:{},cleanup:{tool:'bad',args:{}}}]}
 const options={plan,outputRoot,tools:['cli','bad'],execute:async name=>({ok:name==='cli'})}
 const a=await runAcceptance(options),b=await runAcceptance(options)
 assert.equal(a.status,'CLEANUP_ERROR');assert.notEqual(a.run_dir,b.run_dir)
})
test('cancellation stops further actions but waits for armed cleanup',async t=>{
 const controller=new AbortController(),seen=[],plan={version:1,deadline_ms:1000,steps:[{name:'change',tool:'cli',args:{},cleanup:{tool:'undo',args:{}}},{name:'never',tool:'cli',args:{}}]}
 const r=await runAcceptance({plan,outputRoot:await root(t),tools:['cli','undo'],signal:controller.signal,execute:async name=>{seen.push(name);if(name==='cli')controller.abort();return {ok:true}}})
 assert.equal(r.status,'CANCELLED');assert.deepEqual(seen,['cli','undo'])
})
test('nested tool failure cannot become an acceptance PASS',async t=>{
 const r=await runAcceptance({plan:{version:1,deadline_ms:1000,steps:[{name:'probe',tool:'probe',args:{}}]},outputRoot:await root(t),tools:['probe'],execute:async()=>({ok:true,data:'{"ok":false}'})})
 assert.equal(r.ok,false)
})

test('object data failure cannot become an acceptance PASS',async t=>{
 const r=await runAcceptance({plan:{version:1,deadline_ms:1000,steps:[{name:'probe',tool:'probe',args:{}}]},outputRoot:await root(t),tools:['probe'],execute:async()=>({ok:true,data:{ok:false}})})
 assert.equal(r.ok,false);assert.equal(r.status,'FAIL')
})

test('report write failure cannot leave a PASS summary and does not skip cleanup',async t=>{
 let cleaned=false
 const r=await runAcceptance({plan:{version:1,deadline_ms:1000,steps:[{name:'change',tool:'cli',args:{},cleanup:{tool:'undo',args:{}}}]},outputRoot:await root(t),tools:['cli','undo'],execute:async(name,args,{runDir})=>{
  if(name==='cli'){await unlink(join(runDir,'report.md'));await mkdir(join(runDir,'report.md'))}else cleaned=true
  return {ok:true}
 }})
 assert.equal(cleaned,true);assert.equal(r.status,'EVIDENCE_ERROR');assert.equal(r.ok,false)
 assert.equal(JSON.parse(await readFile(join(r.run_dir,'summary.json'),'utf8')).ok,false)
})

test('whole references preserve typed data but embedded references are strings',async t=>{
 const seen=[]
 const plan={version:1,deadline_ms:1000,steps:[{name:'source',tool:'probe',args:{}},{name:'consumer',tool:'probe',args:{port:'${steps.source.port}',text:'port=${steps.source.port}',items:'${steps.source.items}'}}]}
 const r=await runAcceptance({plan,outputRoot:await root(t),tools:['probe'],execute:async(name,args)=>{seen.push(args);return {ok:true,port:2000,items:['display version']}}})
 assert.equal(r.ok,true);assert.deepEqual(seen[1],{port:2000,text:'port=2000',items:['display version']})
})
