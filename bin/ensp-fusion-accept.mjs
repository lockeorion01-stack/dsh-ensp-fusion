#!/usr/bin/env node
import {readFile,realpath} from 'node:fs/promises'
import {resolve,relative,isAbsolute} from 'node:path'
import {createRegistry} from '../mcp/server.js'
import {runAcceptance,readAcceptanceStatus} from '../lib/acceptance-runner.js'
import {preflightAcceptance,validateToolArguments} from '../lib/acceptance-preflight.js'
import {recoverAcceptance} from '../lib/acceptance-recovery.js'
import {evaluateBusinessEvidence} from '../lib/business-evidence.js'
import {prepareNativeServices} from '../lib/native-service-recovery.js'
import {readTopo} from '../lib/topo.js'
import {evaluateUsgHealth} from '../lib/usg-health.js'
const [command,path,workspace=process.cwd(),output='acceptance-runs']=process.argv.slice(2)
async function main(){
 if(!command||command==='--help'){console.log('ensp-fusion-accept run <plan.json> [workspace] [output-directory]\nensp-fusion-accept status <run-directory>\nensp-fusion-accept recover <run-directory> <original-plan.json> [workspace]\nensp-fusion-accept assess <business-evidence.json>\nensp-fusion-accept usg-health <resource-samples-and-limits.json>\nensp-fusion-accept services-check <manifest.json> <topology.topo> [workspace]');return}
 if(command==='usg-health'){
  const evidence=JSON.parse((await readFile(resolve(path),'utf8')).replace(/^\uFEFF/u,''))
  const result=evaluateUsgHealth(evidence)
  console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;return
 }
 if(command==='services-check'){
  const manifest=JSON.parse((await readFile(resolve(path),'utf8')).replace(/^\uFEFF/u,''))
  const prepared=await prepareNativeServices({manifest,workspace:process.argv[5]??process.cwd(),topology:await readTopo(resolve(process.argv[4]))})
  console.log(JSON.stringify({ok:true,status:'PREFLIGHT_ONLY',business_verified:false,prepared},null,2));return
 }
 if(command==='assess'){
  const evidence=JSON.parse((await readFile(resolve(path),'utf8')).replace(/^\uFEFF/u,'')),result=evaluateBusinessEvidence(evidence)
  console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;return
 }
 if(command==='status'){console.log(JSON.stringify(await readAcceptanceStatus(resolve(path)),null,2));return}
 if(command==='recover'){
  const root=await realpath(resolve(process.argv[5]??process.cwd()))
  const runDir=await realpath(resolve(path)),rel=relative(root,runDir)
  if(isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../'))throw Error('Run directory escapes workspace')
  const plan=JSON.parse((await readFile(resolve(process.argv[4]),'utf8')).replace(/^\uFEFF/u,''))
  const registry=createRegistry({workspace:root,overrides:{timeoutMs:240000}})
  preflightAcceptance(plan,registry.tools)
  const result=await recoverAcceptance({runDir,plan,tools:registry.tools.map(t=>t.name),execute:async(name,args)=>{
   const tool=registry.tools.find(t=>t.name===name);validateToolArguments(args,tool.inputSchema);return tool.handler(args,registry.exec)
  }})
  console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1
  return
 }
 if(command!=='run')throw Error('Unknown acceptance command')
 const root=await realpath(resolve(workspace)),target=resolve(root,output)
 const rel=relative(root,target)
 if(isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../'))throw Error('Output directory escapes workspace')
 // Check the existing parent through realpath; reject output symlink escapes.
 let ancestor=target,parent
 for(;;){try{parent=await realpath(ancestor);break}catch(e){if(e.code!=='ENOENT')throw e;const next=resolve(ancestor,'..');if(next===ancestor)throw e;ancestor=next}}
 const parentRel=relative(root,parent)
 if(isAbsolute(parentRel)||parentRel==='..'||parentRel.startsWith('..\\')||parentRel.startsWith('../'))throw Error('Output parent escapes workspace')
 const plan=JSON.parse((await readFile(resolve(path),'utf8')).replace(/^\uFEFF/u,''))
 const registry=createRegistry({workspace:root,overrides:{timeoutMs:240000}}),controller=new AbortController()
 preflightAcceptance(plan,registry.tools)
 const cancel=()=>controller.abort(new Error('Operator cancelled acceptance'))
 process.once('SIGINT',cancel);process.once('SIGTERM',cancel)
 try{
 const result=await runAcceptance({plan,outputRoot:target,tools:registry.tools.map(t=>t.name),signal:controller.signal,
  execute:async(name,args)=>{const tool=registry.tools.find(t=>t.name===name);validateToolArguments(args,tool.inputSchema);return tool.handler(args,registry.exec)}})
 console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1
 }finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel)}
}
main().catch(e=>{console.error(e.message);process.exitCode=1})
