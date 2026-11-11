// Development-time source inventory; never needed at plugin runtime.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const ignored = new Set(['.git','node_modules','work','deliverables','assets'])
async function scan(path) {
  let result=[]
  for (const entry of await readdir(path,{withFileTypes:true})) {
    if(ignored.has(entry.name))continue
    const target=resolve(path,entry.name)
    if(entry.isDirectory())result.push(...await scan(target))
    else if(entry.isFile()) {
      const data=await readFile(target)
      result.push({path:target,bytes:data.length,lines:data.toString('utf8').split('\n').length,sha256:createHash('sha256').update(data).digest('hex')})
    }
  }
  return result
}
const paths=process.argv.slice(2)
if(paths.length!==3) throw new Error('Usage: npm run audit:sources -- <ENSPLB-source> <YunoSeng-source> <lizi600jin-source>')
const projects=[]
for(const project of paths){
  const path=resolve(root,project), files=await scan(path)
  projects.push({path:['ENSPLB','YunoSeng','lizi600jin'][projects.length],package:JSON.parse(await readFile(resolve(path,'package.json'),'utf8')),head:execFileSync('git',['-C',path,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),status:execFileSync('git',['-C',path,'status','--short'],{encoding:'utf8'}),fileCount:files.length,totalBytes:files.reduce((s,f)=>s+f.bytes,0),files:files.map(f=>({...f,path:relative(path,f.path).replaceAll('\\','/')}))})
}
const a=new Map(projects[1].files.map(f=>[f.path,f.sha256]))
const ensplbDifferences=projects[0].files.filter(f=>a.get(f.path)!==f.sha256).map(f=>({path:f.path,change:a.has(f.path)?'modified':'added'}))
await writeFile(resolve(process.env.ENSP_AUDIT_OUTPUT ?? 'source-audit.json'),JSON.stringify({reviewDate:new Date().toISOString().slice(0,10),excludedDirectories:[...ignored],projects,ensplbDifferences},null,2)+'\n')
console.log(JSON.stringify(projects.map(p=>({project:p.path,fileCount:p.fileCount,totalBytes:p.totalBytes})),null,2))
