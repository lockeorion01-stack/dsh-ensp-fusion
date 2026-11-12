import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {pathToFileURL} from 'node:url'
import {recoverAcceptance} from '../lib/acceptance-recovery.js'
import {acceptancePlanHash,readAcceptanceStatus} from '../lib/acceptance-runner.js'
const plan={version:1,deadline_ms:60000,steps:[{name:'change',tool:'ensp_cli',args:{password:'private-test-value'},cleanup:{tool:'ensp_cli',args:{recover_from:'changes/manifest.json',password:'private-test-value',save:false}}}]}
async function root(t){const dir=await mkdtemp(join(tmpdir(),'ensp-recover-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir}
async function fixture(t,p=plan){const dir=await root(t);await writeFile(join(dir,'summary.json'),JSON.stringify({status:'CLEANUP_ERROR',pid:process.pid,plan_sha256:acceptancePlanHash(p),steps:[],cleanup:[],armed:[{name:'change',label:'change-1'}]}));return dir}
test('real killed process leaves persisted cleanup and can recover without replaying the mutation',async t=>{
 const dir=await root(t),script=join(dir,'worker.mjs'),moduleUrl=pathToFileURL(resolve('lib/acceptance-runner.js')).href
 await writeFile(script,`import {runAcceptance} from ${JSON.stringify(moduleUrl)};await runAcceptance({plan:${JSON.stringify(plan)},outputRoot:${JSON.stringify(dir)},tools:['ensp_cli'],execute:async(name,args,{runDir})=>{console.log(runDir);await new Promise(()=>{})}})`)
 const child=spawn(process.execPath,[script],{stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL')})
 const runDir=await new Promise((yes,no)=>{let buffer='';const timer=setTimeout(()=>no(Error('worker timeout')),10000);child.stdout.on('data',b=>{buffer+=b;if(buffer.includes('\n')){clearTimeout(timer);yes(buffer.trim())}});child.once('error',no)})
 const exited=once(child,'exit');child.kill('SIGKILL');await exited
 assert.equal((await readAcceptanceStatus(runDir)).status,'INTERRUPTED')
 const calls=[],r=await recoverAcceptance({runDir,plan,execute:async(name,args)=>{calls.push(args);return {ok:true}}})
 assert.equal(r.status,'RECOVERED');assert.equal(calls.length,1);assert.equal(calls[0].recover_from,'changes/manifest.json');assert.equal(calls[0].commands,undefined)
 assert.equal(JSON.parse(await readFile(join(runDir,'summary.json'),'utf8')).status,'RUNNING')
 assert.doesNotMatch(await readFile(join(runDir,'cleanup-recovery.json'),'utf8'),/private-test-value/)
 await recoverAcceptance({runDir,plan,execute:async()=>assert.fail('must not repeat successful cleanup')})
})
test('live owner, changed original plan and arbitrary cleanup replay are refused before actions',async t=>{
 const dir=await fixture(t),execute=async()=>assert.fail('must not execute')
 await assert.rejects(recoverAcceptance({runDir:dir,plan:{...plan,deadline_ms:60001},execute}),/hash mismatch/)
 const state=JSON.parse(await readFile(join(dir,'summary.json'),'utf8'));state.status='RUNNING';await writeFile(join(dir,'summary.json'),JSON.stringify(state))
 await assert.rejects(recoverAcceptance({runDir:dir,plan,execute}),/still active/)
 const p=structuredClone(plan);p.steps[0].cleanup.args={commands:['undo shutdown'],port:9500}
 await assert.rejects(recoverAcceptance({runDir:await fixture(t,p),plan:p,execute}),/guarded ensp_cli/)
})
test('missing dynamic journal reference and stale recovery lock fail closed',async t=>{
 const p=structuredClone(plan);p.steps[0].cleanup.args.recover_from='${steps.change.change_journal}'
 await assert.rejects(recoverAcceptance({runDir:await fixture(t,p),plan:p,execute:async()=>assert.fail()}),/Unresolved reference/)
 const dir=await fixture(t);await writeFile(join(dir,'cleanup-recovery.lock'),'interrupted')
 await assert.rejects(recoverAcceptance({runDir:dir,plan,execute:async()=>assert.fail()}),{code:'EEXIST'})
})
test('guard rejection stops LIFO recovery and never converts original failure to PASS',async t=>{
 const p=structuredClone(plan);p.steps.unshift({...structuredClone(p.steps[0]),name:'earlier'})
 const dir=await fixture(t,p),state=JSON.parse(await readFile(join(dir,'summary.json'),'utf8'));state.armed.unshift({name:'earlier',label:'earlier-1'});await writeFile(join(dir,'summary.json'),JSON.stringify(state))
 let calls=0;const r=await recoverAcceptance({runDir:dir,plan:p,execute:async()=>{calls++;return {ok:false,error:'drift'}}})
 assert.equal(calls,1);assert.equal(r.status,'RECOVERY_BLOCKED');assert.equal(r.ok,false)
 assert.equal(JSON.parse(await readFile(join(dir,'summary.json'),'utf8')).status,'CLEANUP_ERROR')
})

test('recovery references the final persisted repeat result and status shows recovery separately',async t=>{
 const p=structuredClone(plan);p.steps.unshift({name:'source',tool:'ensp_cli',repeat:2,args:{}})
 p.steps[1].cleanup.args.recover_from='${steps.source.change_journal}'
 const dir=await fixture(t,p),state=JSON.parse(await readFile(join(dir,'summary.json'),'utf8'))
 state.steps=[{name:'source-1',evidence:'source-1.json'},{name:'source-2',evidence:'source-2.json'}]
 await writeFile(join(dir,'summary.json'),JSON.stringify(state))
 for(const n of [1,2])await writeFile(join(dir,`source-${n}.json`),JSON.stringify({ok:true,change_journal:`journal-${n}`}))
 await recoverAcceptance({runDir:dir,plan:p,execute:async(name,args)=>{assert.equal(args.recover_from,'journal-2');return {ok:true}}})
 const status=await readAcceptanceStatus(dir);assert.equal(status.status,'CLEANUP_ERROR');assert.equal(status.cleanup_recovery.status,'RECOVERED')
})

test('missing latest repeat evidence cannot fall back to a stale earlier journal',async t=>{
 const p=structuredClone(plan);p.steps.unshift({name:'source',tool:'ensp_cli',repeat:2,args:{}})
 p.steps[1].cleanup.args.recover_from='${steps.source.change_journal}'
 const dir=await fixture(t,p),state=JSON.parse(await readFile(join(dir,'summary.json'),'utf8'))
 state.steps=[{name:'source-1',evidence:'source-1.json'},{name:'source-2',evidence:'source-2.json'}]
 await writeFile(join(dir,'summary.json'),JSON.stringify(state));await writeFile(join(dir,'source-1.json'),JSON.stringify({ok:true,change_journal:'stale-journal'}))
 await assert.rejects(recoverAcceptance({runDir:dir,plan:p,execute:async()=>assert.fail('stale recovery must not execute')}),/Unresolved reference/)
 delete state.steps[1].evidence;await writeFile(join(dir,'summary.json'),JSON.stringify(state))
 await assert.rejects(recoverAcceptance({runDir:dir,plan:p,execute:async()=>assert.fail('running repeat must not use earlier evidence')}),/Unresolved reference/)
})
