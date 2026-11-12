import {readFile,readdir,realpath,stat} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {resolve,dirname,relative,isAbsolute,sep} from 'node:path'
import {spawnSync} from 'node:child_process'

const root=fileURLToPath(new URL('../',import.meta.url))
const findings=[]
const issue=(file,reason)=>findings.push({file,reason})
function run(command,args,input){
 const r=spawnSync(command,args,{cwd:root,encoding:'utf8',input,windowsHide:true,maxBuffer:8*1024*1024,shell:process.platform==='win32'&&command==='npm.cmd'})
 if(r.error||r.status!==0)throw Error(command+' check failed: '+(r.error?.message??r.stderr.trim()))
 return r.stdout
}
async function walk(dir){
 const result=[]
 for(const entry of await readdir(resolve(root,dir),{withFileTypes:true})){
  const name=dir+'/'+entry.name
  if(entry.isDirectory())result.push(...await walk(name));else result.push(name)
 }
 return result
}
async function main(){
 const pkg=JSON.parse(await readFile(resolve(root,'package.json'),'utf8')),lock=JSON.parse(await readFile(resolve(root,'package-lock.json'),'utf8'))
 if(pkg.version!==lock.version||pkg.version!==lock.packages?.['']?.version)issue('package-lock.json','package versions differ')
 if(JSON.stringify(pkg.peerDependencies)!==JSON.stringify(lock.packages?.['']?.peerDependencies))issue('package-lock.json','peer dependency versions differ')
 if(pkg.private!==true)issue('package.json','local package publication boundary changed')
 const required=['README.md','CHANGELOG.md','CONTRIBUTING.md','NOTICE.md','LICENSE','LICENSE-MIT','docs/GITHUB-RELEASE.zh-CN.md','docs/KNOWN-ISSUES.zh-CN.md','docs/TOTAL-ACCEPTANCE.zh-CN.md','docs/releases/'+pkg.version+'.zh-CN.md']
 for(const file of required){try{if(!(await stat(resolve(root,file))).isFile())issue(file,'required release file is not a file')}catch{issue(file,'required release file missing')}}
 const docs=['README.md','CHANGELOG.md','CONTRIBUTING.md','NOTICE.md',...(await walk('docs')).filter(f=>f.endsWith('.md'))]
 let links=0
 for(const file of docs){
  let source;try{source=await readFile(resolve(root,file),'utf8')}catch{continue}
  const text=source.replace(/```[^\n]*\n[\s\S]*?```/gu,'')
  for(const m of text.matchAll(/\[[^\]\n]*\]\(([^)]+)\)/gu)){
   const href=m[1].replace(/^<|>$/gu,'')
   if(/^(?:[a-z][a-z0-9+.-]*:|#)/iu.test(href))continue
   links++
   let target;try{target=resolve(root,dirname(file),decodeURIComponent(href.split('#')[0]))}catch{issue(file,'invalid relative link');continue}
   try{
    const canonical=await realpath(target),rel=relative(root,canonical)
    if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))issue(file,'relative link escapes repository')
   }catch{issue(file,'missing relative link: '+href)}
  }
 }
 const candidate=run('git',['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean)
 const forbidden=/(?:^|\/)(?:\.env(?:\..+)?|[^/]+\.local\.(?:json|ya?ml|toml|ini|env)|[^/]+\.(?:pem|key|p12|pfx|pcapng?|vdi|vmdk|qcow2|iso|tgz))$/iu
 const privateDir=/^(?:node_modules|test-results|acceptance-runs|change-runs|captures|deliverables|labs|__pycache__)\//u
 const patterns=[
  ['private key',/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u],
  ['GitHub token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/u],
  ['AWS access key',/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u],
  ['local workspace path',/[A-Za-z]:[\\/]AgentProject_EXP[\\/]/u],
  ['personal Windows path',/[A-Za-z]:[\\/]Users[\\/](?!Public\b|<|path\b)[A-Za-z0-9_.-]+[\\/]/iu],
 ]
 let scanned=0
 for(const file of candidate){
  if((forbidden.test(file)&&!/(?:^|\/)\.env\.(?:example|template)$/u.test(file))||privateDir.test(file))issue(file,'local/private artifact is a Git candidate')
  let bytes;try{bytes=await readFile(resolve(root,file))}catch(e){if(e.code==='ENOENT')continue;throw e}
  if(bytes.length>2*1024*1024){issue(file,'large candidate requires explicit manual review');continue}
  const text=bytes.subarray(0,2).equals(Buffer.from([255,254]))?bytes.subarray(2).toString('utf16le'):bytes.toString('utf8')
  if(text.includes('\0'))continue
  scanned++
  for(const [name,pattern] of patterns)if(pattern.test(text))issue(file,name+' detected; inspect locally')
 }
 const probes=['.env','.env.production','acceptance-plan.local.json','test-results/run/summary.json','acceptance-runs/run/summary.json','capture.pcapng','disk.vdi','private.pem']
 const ignored=new Set(run('git',['check-ignore','--no-index','--stdin'],probes.join('\n')+'\n').trim().split(/\r?\n/u))
 for(const file of probes)if(!ignored.has(file))issue('.gitignore','expected local artifact is not ignored: '+file)
 const npm=process.platform==='win32'?'npm.cmd':'npm'
 const pack=JSON.parse(run(npm,['pack','--dry-run','--ignore-scripts','--json']))[0]
 const packed=new Set(pack.files.map(f=>f.path))
 for(const file of ['README.md','CHANGELOG.md','CONTRIBUTING.md','docs/releases/'+pkg.version+'.zh-CN.md','docs/KNOWN-ISSUES.zh-CN.md','LICENSE','LICENSE-MIT'])if(!packed.has(file))issue(file,'required distributed documentation missing from package')
 for(const file of packed)if(forbidden.test(file)||privateDir.test(file))issue(file,'local/private artifact is packed')
 const report={ok:findings.length===0,version:pkg.version,publication:'pending; no Git mutation or network operation',checks:{documents:docs.length,relative_links:links,git_candidates:candidate.length,text_files_scanned:scanned,package_files:packed.size,ignore_probes:probes.length},findings,limits:['Finite filename and high-confidence content patterns; not a complete secret scanner.','Does not inspect Git history, remote repository, dependency vulnerabilities, or device business.']}
 console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1
}
main().catch(error=>{console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1})
