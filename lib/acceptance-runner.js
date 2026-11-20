import { mkdir, writeFile, rename, appendFile, readFile, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createRedactor, credentialValues, redactValue } from './redaction.js'
import { operationSucceeded } from './operation-result.js'
import { createExecutionControl } from './execution-control.js'

export function validateAcceptancePlan(plan, tools) {
  if (plan?.version !== 1 || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > 1000) throw new Error('Acceptance plan requires version:1 and 1..1000 steps')
  if (!Number.isInteger(plan.deadline_ms) || plan.deadline_ms < 1 || plan.deadline_ms > 86400000) throw new Error('deadline_ms must be 1..86400000')
  if (plan.cleanup_deadline_ms !== undefined && (!Number.isInteger(plan.cleanup_deadline_ms) || plan.cleanup_deadline_ms < 1 || plan.cleanup_deadline_ms > 3600000)) throw new Error('cleanup_deadline_ms must be 1..3600000')
  const names = new Set()
  function action(a) {
    if (!a || !tools.includes(a.tool) || !a.args || typeof a.args !== 'object' || Array.isArray(a.args)) throw new Error('Unknown tool or invalid action arguments')
  }
  for (const step of plan.steps) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(step.name) || names.has(step.name)) throw new Error('Step names must be unique simple identifiers')
    names.add(step.name); action(step)
    if (step.cleanup) action(step.cleanup)
    if (step.expect_ok !== undefined) throw new Error('Negative business assertions must be evaluated by the probe, not by accepting tool failure')
    if (step.repeat !== undefined && (!Number.isInteger(step.repeat) || step.repeat < 1 || step.repeat > 10000)) throw new Error('repeat must be 1..10000')
    if (step.cleanup && (step.repeat??1)>1) throw new Error('Repeated mutation/cleanup steps require distinct names and records')
    if (step.interval_ms !== undefined && (!Number.isInteger(step.interval_ms) || step.interval_ms < 0 || step.interval_ms > 3600000)) throw new Error('interval_ms must be 0..3600000')
  }
  return plan
}
function expand(value, context) {
  if (typeof value === 'string' && /^\$\{[^}]+\}$/u.test(value)) {
    const found=value.slice(2,-1).split('.').reduce((v,key)=>v?.[key],context)
    if(found===undefined)throw new Error(`Unresolved reference: ${value}`)
    return structuredClone(found)
  }
  if (typeof value === 'string') return value.replace(/\$\{([^}]+)\}/gu, (_, path) => {
    const found = path.split('.').reduce((v, key) => v?.[key], context)
    if (typeof found !== 'string' && typeof found !== 'number') throw new Error(`Unresolved reference: ${path}`)
    return String(found)
  })
  if (Array.isArray(value)) return value.map(v => expand(v, context))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,expand(v,context)]))
  return value
}
export function operationOk(result, toolName) { return operationSucceeded(toolName, result) }
export async function runAcceptance({plan, outputRoot, execute, tools, signal}) {
  validateAcceptancePlan(plan, tools)
  const root = resolve(outputRoot)
  await mkdir(root,{recursive:true})
  const runId = `${new Date().toISOString().replace(/[:.]/gu,'-')}-${randomUUID()}`
  const runDir = join(root,runId)
  await mkdir(runDir)
  const redact=createRedactor(credentialValues(plan)), clean=v=>redactValue(v,redact)
  const state={version:1,run_id:runId,pid:process.pid,started:new Date().toISOString(),status:'RUNNING',ok:false,steps:[],cleanup:[],armed:[],plan_sha256:acceptancePlanHash(plan),plan:clean(plan)}
  const context={run_dir:runDir,steps:{}}, armed=[]
  const control=createExecutionControl({signal,timeoutMs:plan.deadline_ms})
  const controller={signal:control.signal}
  const save=async()=>{
    const temporary=join(runDir,`${randomUUID()}.tmp`)
    const file=await open(temporary,'wx',0o600)
    try{await file.writeFile(JSON.stringify(clean(state),null,2));await file.sync()}finally{await file.close()}
    await rename(temporary,join(runDir,'summary.json'))
  }
  const event=async data=>appendFile(join(runDir,'events.jsonl'),JSON.stringify(clean({at:new Date().toISOString(),...data}))+'\n',{mode:0o600})
  const artifact=async(name,result)=>writeFile(join(runDir,`${name}.json`),JSON.stringify(clean(result),null,2),{flag:'wx',mode:0o600})
  try {
    await save()
    // Reserve distinct report files before any external action.
    await writeFile(join(runDir,'report.md'),'Acceptance RUNNING\n',{flag:'wx',mode:0o600})
    await writeFile(join(runDir,'report.csv'),'name,status\n',{flag:'wx',mode:0o600})
  } catch(error) {control.dispose();throw error}
  let outcome='FAIL'
  let uncertain=false
  try {
    for(const step of plan.steps) {
      for(let round=1;round<=(step.repeat??1);round++) {
        controller.signal.throwIfAborted()
        const label=`${step.name}-${round}`,row={name:label,tool:step.tool,status:'RUNNING',started:new Date().toISOString()}
        state.steps.push(row)
        if(step.cleanup){armed.push({step,label});state.armed.push({name:step.name,label})} // Persist before the action: it may partly succeed.
        await save();await event({type:'step-started',name:label})
        let result
        try {
          result=await execute(step.tool,expand(step.args,context),{signal:controller.signal,deadline:control.deadline,runDir})
          uncertain ||= result?.execution?.status==='unconfirmed'
          context.steps[step.name]=result
          row.status=operationOk(result,step.tool)?'PASS':'FAIL'
        } catch(error) { result={ok:false,error:redact(error.message),...(error.execution?{execution:error.execution}:{})};uncertain ||= error.execution?.status==='unconfirmed'||(controller.signal.aborted&&error.execution?.stop_confirmed!==true);row.status='ERROR' }
        row.finished=new Date().toISOString();row.evidence=`${label}.json`
        await artifact(label,result);await save();await event({type:'step-finished',...row})
        if(row.status!=='PASS')throw new Error(`Acceptance step ${label} ${row.status}`)
        if(round<(step.repeat??1)&&step.interval_ms)await delay(step.interval_ms,undefined,{signal:controller.signal})
      }
    }
    controller.signal.throwIfAborted()
    outcome='PASS'
  } catch(error) { outcome=uncertain?'UNCONFIRMED':controller.signal.aborted?'CANCELLED':'FAIL';state.error=redact(error.message) }
  finally {
    control.dispose()
    const cleanupControl=createExecutionControl({timeoutMs:plan.cleanup_deadline_ms??30000})
    state.status='CLEANING_UP';state.ok=false
    // Cleanup deliberately ignores the cancelled action signal and runs in LIFO order.
    for(const {step,label} of armed.reverse()) {
      const row={name:`cleanup-${label}`,status:'RUNNING',started:new Date().toISOString()}
      state.cleanup.push(row)
      if(uncertain){row.status='SKIPPED_UNCONFIRMED';row.reason='Original action or preceding cleanup has no confirmed stop';continue}
      try {await save()}catch(error){state.evidence_error=redact(error.message);outcome='EVIDENCE_ERROR'}
      let result
      try {cleanupControl.check();result=await execute(step.cleanup.tool,expand(step.cleanup.args,context),{runDir,cleanup:true,signal:cleanupControl.signal,deadline:cleanupControl.deadline});row.status=operationOk(result,step.cleanup.tool)?'PASS':'ERROR'}
      catch(error){result={ok:false,error:redact(error.message),...(error.execution?{execution:error.execution}:{})};uncertain ||= cleanupControl.signal.aborted&&error.execution?.stop_confirmed!==true;row.status='ERROR'}
      uncertain ||= result?.execution?.status==='unconfirmed'
      row.finished=new Date().toISOString()
      if(row.status!=='PASS')outcome='CLEANUP_ERROR'
      try {await artifact(row.name,result);await event({type:'cleanup-finished',...row});await save()}
      catch(error){state.evidence_error=redact(error.message);if(outcome!=='CLEANUP_ERROR')outcome='EVIDENCE_ERROR'}
    }
    cleanupControl.dispose()
    if(uncertain){outcome='UNCONFIRMED';state.stop_confirmed=false}
    if(state.steps.length<plan.steps.reduce((n,s)=>n+(s.repeat??1),0))state.incomplete=true
    state.finished=new Date().toISOString()
    state.status=outcome;state.ok=outcome==='PASS'
    try {
      await writeFile(join(runDir,'report.md'),`# Acceptance ${state.status}\n\nRun: ${runId}\n\n| Step | Status |\n| --- | --- |\n${[...state.steps,...state.cleanup].map(r=>`| ${r.name} | ${r.status} |`).join('\n')}\n`)
      await writeFile(join(runDir,'report.csv'),'name,status\n'+[...state.steps,...state.cleanup].map(r=>`${r.name},${r.status}`).join('\n')+'\n')
    } catch(error) {state.evidence_error=redact(error.message);state.ok=false;if(state.status!=='CLEANUP_ERROR')state.status='EVIDENCE_ERROR'}
    await save()
  }
  return {ok:state.ok,status:state.status,run_dir:runDir,steps:state.steps,cleanup:state.cleanup}
}
export function acceptancePlanHash(plan) {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex')
}
export {expand as expandAcceptanceReferences}
export async function readAcceptanceStatus(runDir) {
  const state=JSON.parse(await readFile(join(runDir,'summary.json'),'utf8'))
  try{state.cleanup_recovery=JSON.parse(await readFile(join(runDir,'cleanup-recovery.json'),'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
  if(['RUNNING','CLEANING_UP'].includes(state.status)) {
    try {process.kill(state.pid,0)}catch(error){if(error.code==='ESRCH')return {...state,status:'INTERRUPTED',ok:false}}
  }
  return state
}
