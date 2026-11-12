import {open,readFile,writeFile,rename,unlink,realpath} from 'node:fs/promises'
import {join,resolve,basename,relative,isAbsolute} from 'node:path'
import {randomUUID} from 'node:crypto'
import {acceptancePlanHash,expandAcceptanceReferences,operationOk,validateAcceptancePlan} from './acceptance-runner.js'
import {createRedactor,credentialValues,redactValue} from './redaction.js'

function alive(pid){
 if(!Number.isInteger(pid)||pid<1)throw Error('Invalid owner PID; manual review required')
 try{process.kill(pid,0);return true}catch(e){if(e.code==='ESRCH')return false;throw e}
}
// Never replay the interrupted business action. Recovery only accepts the original
// registered cleanup, and only through ensp_cli's existing identity/config guard.
export async function recoverAcceptance({runDir,plan,execute,tools=['ensp_cli']}){
 runDir=resolve(runDir)
 validateAcceptancePlan(plan,tools)
 const original=JSON.parse(await readFile(join(runDir,'summary.json'),'utf8'))
 if(original.plan_sha256!==acceptancePlanHash(plan))throw Error('Original plan hash mismatch; recovery refused')
 if(['RUNNING','CLEANING_UP'].includes(original.status)&&alive(original.pid))throw Error('Acceptance owner is still active; recovery refused')
 if(!Array.isArray(original.armed))throw Error('No persisted cleanup ledger; manual review required')
 const lockPath=join(runDir,'cleanup-recovery.lock'),lock=await open(lockPath,'wx',0o600)
 const redact=createRedactor(credentialValues(plan)),clean=value=>redactValue(value,redact)
 const atomic=async value=>{
  const temporary=join(runDir,`${randomUUID()}.tmp`)
  const file=await open(temporary,'wx',0o600)
  try{await file.writeFile(JSON.stringify(clean(value),null,2));await file.sync()}finally{await file.close()}
  await rename(temporary,join(runDir,'cleanup-recovery.json'))
 }
 try{
  await lock.writeFile(JSON.stringify({pid:process.pid,started:new Date().toISOString()}));await lock.sync()
  let previous
  try{previous=JSON.parse(await readFile(join(runDir,'cleanup-recovery.json'),'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
  const completed=new Set([...(original.cleanup??[]),...(previous?.cleanup??[])].filter(r=>r.status==='PASS').map(r=>r.name))
  const context={run_dir:runDir,steps:{}}
  for(const row of original.steps??[]){
   const step=plan.steps.find(s=>{
    const suffix=row.name?.startsWith(`${s.name}-`)?row.name.slice(s.name.length+1):''
    return /^[1-9]\d*$/u.test(suffix)&&Number(suffix)<=(s.repeat??1)
   })
   if(!step)continue
   // A later repeat supersedes the earlier result even when it was interrupted
   // before writing its evidence. Never recover using an earlier round's journal.
   delete context.steps[step.name]
   if(!row.evidence)continue
   if(basename(row.evidence)!==row.evidence)throw Error('Invalid step evidence path')
   try{
    const evidencePath=await realpath(join(runDir,row.evidence)),rel=relative(await realpath(runDir),evidencePath)
    if(isAbsolute(rel)||rel==='..'||rel.startsWith('../')||rel.startsWith('..\\'))throw Error('Step evidence escapes run directory')
    context.steps[step.name]=JSON.parse(await readFile(evidencePath,'utf8'))
   }catch(e){if(e.code!=='ENOENT')throw e}
  }
  const pending=[]
  // Prepare all recoveries before the first external action. Missing result
  // references (e.g. killed before journal evidence was returned) fail closed.
  for(const entry of [...original.armed].reverse()){
   const name=`cleanup-${entry.label}`
   if(completed.has(name))continue
   const step=plan.steps.find(s=>s.name===entry.name)
   if(!step?.cleanup||entry.label!==`${entry.name}-1`)throw Error('Invalid cleanup ledger; manual review required')
   const action=step.cleanup,args=expandAcceptanceReferences(action.args,context)
   if(action.tool!=='ensp_cli'||typeof args.recover_from!=='string'||!args.recover_from
    ||['commands','devices','port','device','recovery_commands'].some(k=>args[k]!==undefined)
    ||args.save===true||JSON.stringify(args).includes('[REDACTED]'))throw Error('Interrupted cleanup requires guarded ensp_cli recover_from without target/command overrides or save:true')
   pending.push({name,tool:action.tool,args})
  }
  const state={version:1,pid:process.pid,started:new Date().toISOString(),original_status:original.status,status:'RECOVERING',ok:false,cleanup:previous?.cleanup??[]}
  await atomic(state)
  for(const action of pending){
   const row={name:action.name,status:'RUNNING',started:new Date().toISOString(),evidence:`recovery-${randomUUID()}.json`}
   state.cleanup.push(row);await atomic(state)
   let result
   try{result=await execute(action.tool,action.args,{runDir,cleanup:true});row.status=operationOk(result)?'PASS':'ERROR'}
   catch(e){result={ok:false,error:redact(e.message)};row.status='ERROR'}
   await writeFile(join(runDir,row.evidence),JSON.stringify(clean(result),null,2),{flag:'wx',mode:0o600})
   row.finished=new Date().toISOString();await atomic(state)
   // A blocked guard can invalidate earlier LIFO states. Stop, do not continue.
   if(row.status!=='PASS')break
  }
  const successful=new Set(state.cleanup.filter(r=>r.status==='PASS').map(r=>r.name))
  state.ok=pending.every(a=>successful.has(a.name))
  state.status=state.ok?'RECOVERED':'RECOVERY_BLOCKED';state.finished=new Date().toISOString()
  await atomic(state)
  return clean(state)
 }finally{await lock.close();await unlink(lockPath)}
}
