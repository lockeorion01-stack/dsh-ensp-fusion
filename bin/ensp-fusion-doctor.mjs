#!/usr/bin/env node
import {spawnSync} from 'node:child_process'
import {existsSync,readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
const args=process.argv.slice(2),option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback
if(args.includes('--help')){console.log('ensp-fusion-doctor [--python <python.exe>] [--ensp <eNSP_Client.exe>] [--vbox <VBoxManage.exe>]\nensp-fusion-doctor incident --workspace <directory> --output <new-subdirectory> [--from <ISO8601+timezone>] [--to <ISO8601+timezone>] [--session <path>] [--native-log-root <directory>] [--pc-log-root <directory>] [--execution-root <directory>] [--topology <path>] [--wer-root <directory>]\nRead-only environment or bounded incident collection. Exit 1 means missing requirements or incomplete evidence.');process.exit(0)}
if(args[0]==='incident'){
 try {
  const allowed=new Set(['--workspace','--output','--from','--to','--session','--native-log-root','--pc-log-root','--execution-root','--topology','--wer-root','--ensp'])
  const parsed={},sessions=[]
  for(let i=1;i<args.length;i+=2){const key=args[i],value=args[i+1];if(!allowed.has(key)||!value||value.startsWith('--'))throw Error('Invalid incident option or missing value: '+key);if(key==='--session')sessions.push(value);else{if(parsed[key]!==undefined)throw Error('Duplicate option: '+key);parsed[key]=value}}
  if(!parsed['--workspace']||!parsed['--output'])throw Error('incident requires --workspace and --output')
  const {collectIncident,writeIncidentReport}=await import('../lib/crash-collector.js')
  const incident=await collectIncident({from:parsed['--from'],to:parsed['--to'],sessions,nativeLogRoot:parsed['--native-log-root'],pcLogRoot:parsed['--pc-log-root'],executionRoot:parsed['--execution-root'],topology:parsed['--topology'],werRoot:parsed['--wer-root'],ensp:parsed['--ensp']})
  const result=await writeIncidentReport(incident,{workspace:parsed['--workspace'],output:parsed['--output']})
  console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1
 }catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1}
}else{
const ensp=option('--ensp','C:/Program Files/Huawei/eNSP/eNSP_Client.exe'),vbox=option('--vbox','C:/Program Files/Oracle/VirtualBox/VBoxManage.exe')
const python=option('--python',process.env.ENSP_PYTHON??'python')
const script=`import sys,json,platform,importlib.metadata,importlib
packages={}
for dist,module in [('pywin32','win32gui'),('Pillow','PIL'),('python-docx','docx'),('lxml','lxml'),('typing_extensions','typing_extensions')]:
 try:
  importlib.import_module(module)
  packages[dist]={'version':importlib.metadata.version(dist),'importable':True}
 except Exception: packages[dist]={'version':None,'importable':False}
print(json.dumps({'executable':sys.executable,'version':platform.python_version(),'platform':platform.platform(),'packages':packages}))`
const proc=spawnSync(python,['-c',script],{encoding:'utf8',timeout:15000,windowsHide:true})
let runtime=null
try{runtime=JSON.parse(proc.stdout)}catch{}
const lock=readFileSync(fileURLToPath(new URL('../requirements-windows.lock.txt',import.meta.url)),'utf8')
const pinned=Object.fromEntries([...lock.matchAll(/^([\w-]+)==([\d.]+)/gmu)].map(m=>[m[1],m[2]]))
const missing=Object.keys(pinned).filter(p=>!runtime?.packages[p]?.importable)
const differences=Object.keys(pinned).filter(p=>runtime?.packages[p]?.version!==pinned[p])
const v=existsSync(vbox)?spawnSync(vbox,['--version'],{encoding:'utf8',timeout:10000,windowsHide:true}):null
const report={ok:process.platform==='win32'&&Number(process.versions.node.split('.')[0])>=20&&!!runtime&&!missing.length&&existsSync(ensp)&&v?.status===0,node:process.version,python:runtime,missing_packages:missing,pinned_version_differences:differences,ensp:{path:ensp,exists:existsSync(ensp)},virtualbox:{path:vbox,version:v?.stdout?.trim()??null},notes:['Version differences are reported, not treated as a compatibility failure.','This read-only check does not establish GUI elevation, image registration, boot success or business health.'],error:runtime?null:(proc.error?.message??proc.stderr?.trim()??'Python did not return environment metadata')}
console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1
}
