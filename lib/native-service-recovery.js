import {readFile,realpath} from 'node:fs/promises'
import {resolve,relative,isAbsolute,basename} from 'node:path'
import {createHash} from 'node:crypto'
import {isIP} from 'node:net'
import {operationOk} from './acceptance-runner.js'

async function contained(root,path){
 const actual=await realpath(resolve(root,path)),rel=relative(root,actual)
 if(isAbsolute(rel)||rel==='..'||rel.startsWith('../')||rel.startsWith('..\\'))throw Error('Native service content escapes workspace')
 return actual
}
export async function prepareNativeServices({manifest,workspace,topology}){
 if(manifest?.version!==1||isIP(manifest.address)!==4||manifest.dns?.answer!==manifest.address
  ||typeof manifest.dns?.name!=='string'||! /^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z\d-]+$/iu.test(manifest.dns.name))throw Error('Invalid native service manifest address or DNS record')
 const devices=topology?.devices??[],server=devices.filter(d=>d.name===manifest.server),client=devices.filter(d=>d.name===manifest.client)
 if(server.length!==1||client.length!==1||server[0].model!=='Server'||client[0].model!=='Client')throw Error('Native manifest must resolve unique Server and Client identities')
 const tokens=text=>{if(typeof text!=='string')throw Error('Native settings must be text');return text.trim().split(/\s+/u)},settings=tokens(server[0].settings),clientSettings=tokens(client[0].settings)
 for(const [items,keys] of [[settings,['-ipaddr','-dnslist']],[clientSettings,['-ipv4dns']]])for(const key of keys){
  const positions=items.flatMap((item,index)=>item===key?[index]:[])
  if(positions.length!==1||!items[positions[0]+1]||items[positions[0]+1].startsWith('-'))throw Error('Native settings contain missing or duplicate IP/DNS options')
 }
 const option=(items,key)=>items[items.indexOf(key)+1]
 const dnsFields=(option(settings,'-dnslist')??'').split('_').slice(1)
 const dnsMatches=dnsFields.some((field,index)=>index%2===0&&field===manifest.dns.name&&dnsFields[index+1]===manifest.address)
 if(!settings.includes('-ipaddr')||option(settings,'-ipaddr')!==manifest.address
  ||!settings.includes('-dnslist')||!dnsMatches
  ||!clientSettings.includes('-ipv4dns')||option(clientSettings,'-ipv4dns')!==manifest.address)throw Error('Native topology IP/DNS settings differ from manifest; review saved topology before GUI changes')
 const root=await realpath(resolve(workspace)),services={}
 for(const [kind,port] of [['http',80],['ftp',21]]){
  const entry=manifest[kind]
  if(entry?.port!==port||typeof entry.directory!=='string'||typeof entry.file!=='string'||!entry.file||basename(entry.file)!==entry.file
   ||entry.file==='.'||entry.file==='..'||! /^[a-f\d]{64}$/iu.test(entry.sha256??''))throw Error(`Invalid native ${kind} content manifest`)
  const directory=await contained(root,entry.directory),file=await contained(root,resolve(directory,entry.file))
  // A symlink within the workspace is still not allowed to select a file outside
  // the actual directory being served by the native application.
  const rel=relative(directory,file)
  if(isAbsolute(rel)||rel==='..'||rel.startsWith('../')||rel.startsWith('..\\'))throw Error('Native content escapes service directory')
  const bytes=await readFile(file),hash=createHash('sha256').update(bytes).digest('hex')
  if(hash!==entry.sha256.toLowerCase())throw Error(`Native ${kind} content hash mismatch`)
  services[kind]={directory,file,sha256:hash,bytes:bytes.length,port}
 }
 return {server:manifest.server,client:manifest.client,address:manifest.address,dns:manifest.dns,services}
}

export async function recoverNativeServices({activate,probe,...options}){
 if(typeof activate!=='function'||typeof probe!=='function')throw Error('Native recovery requires activation and real guest protocol probes')
 const prepared=await prepareNativeServices(options)
 const activation=await activate(prepared)
 if(!operationOk(activation))return {ok:false,status:'ACTIVATION_FAILED',business_verified:false}
 // A button click is never evidence that a service is available.
 const result=await probe(prepared)
 const verified=result?.ok===true&&['http','dns','ftp'].every(k=>result?.[k]?.ok===true&&result[k].completed===true)
  &&result?.vantage==='guest'&&result.source===prepared.client&&result.target===prepared.address
  &&result?.http?.status===200&&result.http.sha256===prepared.services.http.sha256
  &&result?.dns?.query===prepared.dns.name&&Array.isArray(result.dns.answers)&&result.dns.answers.includes(prepared.address)
  &&result?.ftp?.code===226&&result.ftp.sha256===prepared.services.ftp.sha256
 return {ok:verified,status:verified?'RECOVERED':'PROTOCOL_VERIFICATION_FAILED',business_verified:verified,
  automatic_native_persistence:false,protocols:result}
}
