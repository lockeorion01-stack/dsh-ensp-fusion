import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync,spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {readAcceptanceStatus} from '../lib/acceptance-runner.js'
import {acceptancePlanHash} from '../lib/acceptance-runner.js'
const cli=fileURLToPath(new URL('../bin/ensp-fusion-accept.mjs',import.meta.url))
async function workspace(t){const dir=await mkdtemp(join(tmpdir(),'ensp-accept-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir}

test('CLI USG resource assessment fails incomplete evidence and never claims capacity acceptance',async t=>{
 const root=await workspace(t),file=join(root,'resources.json')
 const limits={min_samples:1,cpu_percent:85,management_memory_percent:90,device_memory_percent:90,dynamic_memory_percent:90}
 await writeFile(file,JSON.stringify({limits,samples:[{cpu:'CPU Usage : 17.7% Max: 100%',memory:'',sessions:'Current Total Sessions : 0'}]}))
 const r=spawnSync(process.execPath,[cli,'usg-health',file],{encoding:'utf8',windowsHide:true})
 assert.equal(r.status,1);const parsed=JSON.parse(r.stdout)
 assert.equal(parsed.status,'INCONCLUSIVE');assert.equal(parsed.performance_accepted,false)
 assert.equal(parsed.samples[0].cpu_historical_max_percent,100)
})
const build={name:'build',tool:'ensp_build',args:{output_path:'new.topo',devices:[{name:'SW',model:'S5700'}]}}
test('CLI preflight prevents an earlier mutation when a later tool argument is malformed',async t=>{
 const root=await workspace(t),file=join(root,'plan.json')
 await writeFile(file,JSON.stringify({version:1,deadline_ms:20000,steps:[build,{name:'bad',tool:'ensp_cli',args:{port:9500,commands:[{cmd:42}]}}]}))
 const r=spawnSync(process.execPath,[cli,'run',file,root],{encoding:'utf8',windowsHide:true})
 assert.equal(r.status,1);assert.match(r.stderr,/commands|expected string|oneOf/u);await assert.rejects(access(join(root,'new.topo')))
})
test('real CLI preserves the failed step and invokes armed cleanup after a successful file action',async t=>{
 const root=await workspace(t),file=join(root,'plan.json')
 const plan={version:1,deadline_ms:20000,steps:[{...build,cleanup:{tool:'ensp_scenarios',args:{query:'ospf'}}},{name:'duplicate',tool:'ensp_build',args:build.args}]}
 await writeFile(file,JSON.stringify(plan))
 const r=spawnSync(process.execPath,[cli,'run',file,root],{encoding:'utf8',windowsHide:true}),result=JSON.parse(r.stdout)
 assert.equal(r.status,1);assert.equal(result.status,'FAIL');assert.equal(result.steps[0].status,'PASS');assert.equal(result.cleanup[0].status,'PASS')
 assert.match(await readFile(join(root,'new.topo'),'utf8'),/name="SW"/u)
 assert.equal((await readAcceptanceStatus(result.run_dir)).status,'FAIL')
})
test('forced worker termination is INTERRUPTED rather than PASS',async t=>{
 const root=await workspace(t)
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'})
 const exited=new Promise(resolve=>child.once('exit',resolve));await new Promise(resolve=>child.once('spawn',resolve))
 await writeFile(join(root,'summary.json'),JSON.stringify({status:'RUNNING',pid:child.pid,ok:false}))
 assert.equal((await readAcceptanceStatus(root)).status,'RUNNING');child.kill('SIGKILL');await exited
 assert.equal((await readAcceptanceStatus(root)).status,'INTERRUPTED')
})

test('CLI business assessment returns nonzero for real loss despite a successful final round',async t=>{
 const root=await workspace(t),file=join(root,'evidence.json')
 await writeFile(file,JSON.stringify({version:1,kind:'stability',samples:[{completed:true,transmitted:5,received:4,loss_percent:20},{completed:true,transmitted:5,received:5,loss_percent:0}]}))
 const r=spawnSync(process.execPath,[cli,'assess',file],{encoding:'utf8',windowsHide:true})
 assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).received,9);assert.equal(JSON.parse(r.stdout).status,'FAIL')
})

test('CLI recovery refuses the live owner before opening device connections',async t=>{
 const root=await workspace(t),file=join(root,'plan.json')
 const plan={version:1,deadline_ms:1000,steps:[{name:'change',tool:'ensp_cli',args:{port:9500,commands:['display version']},cleanup:{tool:'ensp_cli',args:{recover_from:'missing-manifest.json'}}}]}
 await writeFile(file,JSON.stringify(plan));await writeFile(join(root,'summary.json'),JSON.stringify({status:'RUNNING',pid:process.pid,plan_sha256:acceptancePlanHash(plan),armed:[{name:'change',label:'change-1'}]}))
 const r=spawnSync(process.execPath,[cli,'recover',root,file,root],{encoding:'utf8',windowsHide:true})
 assert.equal(r.status,1);assert.match(r.stderr,/still active/)
 await assert.rejects(access(join(root,'cleanup-recovery.json')))
})
