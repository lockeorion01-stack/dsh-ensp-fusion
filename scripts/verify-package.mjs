import { mkdtemp, mkdir, rm, readFile, writeFile, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve, join, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
const root=fileURLToPath(new URL('../',import.meta.url))
const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
const npm=process.platform==='win32'?'npm.cmd':'npm'
function run(command,args,cwd){const r=spawnSync(command,args,{cwd,encoding:'utf8',shell:process.platform==='win32'&&command===npm,windowsHide:true});if(r.status!==0)throw Error(r.stdout+r.stderr);return r.stdout}
const temp=await mkdtemp(join(tmpdir(),'ensp-fusion-package-'))
try{
  const metadata=JSON.parse(run(npm,['pack','--ignore-scripts','--json','--pack-destination',temp],root))[0]
  for(const file of ['index.js','base.js','LICENSE','LICENSE-MIT','upstream/lizi600jin/LICENSE','test/fixtures/minimal.topo','lib/bridge.py','lib/usg-health.js','requirements-windows.lock.txt','bin/ensp-fusion-accept.mjs','bin/ensp-fusion-doctor.mjs','CHANGELOG.md','CONTRIBUTING.md',`docs/releases/${manifest.version}.zh-CN.md`,'docs/KNOWN-ISSUES.zh-CN.md','docs/GITHUB-RELEASE.zh-CN.md'])assert.ok(metadata.files.some(f=>f.path===file),file)
  run('tar',['-xf',join(temp,metadata.filename),'-C',temp],temp)
  const pkg=join(temp,'package')
  const packedPaths=new Set(metadata.files.map(file=>file.path))
  function packedPath(path){
    assert.equal(typeof path,'string','package target must be a string')
    assert.ok(path.length&&!/[\\\0]/u.test(path),'package target must be a relative forward-slash path')
    const target=resolve(pkg,path),rel=relative(pkg,target)
    assert.ok(rel&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel),`package target escapes root: ${path}`)
    return {target,rel:rel.split(sep).join('/')}
  }
  for(const file of metadata.files){
    const {target,rel}=packedPath(file.path)
    assert.ok((await lstat(target)).isFile(),`unpacked file missing or not a regular file: ${rel}`)
    const bytes=await readFile(target),source=await readFile(resolve(root,rel))
    assert.equal(bytes.length,file.size,`unpacked size differs: ${rel}`)
    const digest=data=>createHash('sha256').update(data).digest('hex')
    assert.equal(digest(bytes),digest(source),`unpacked content differs from source: ${rel}`)
  }
  function targets(value){return typeof value==='string'?[value]:value&&typeof value==='object'?Object.values(value).flatMap(targets):[]}
  const entrypoints=[...new Set([...targets(manifest.exports),...targets(manifest.bin),manifest.dsh.bundle.patch])]
  for(const path of entrypoints){
    const {target,rel}=packedPath(path)
    assert.ok(packedPaths.has(rel),`declared entrypoint is not packed: ${path}`)
    assert.ok((await lstat(target)).isFile()&&(await readFile(target)).length>0,`declared entrypoint is empty or missing: ${path}`)
  }
  await writeFile(join(pkg,'package-lock.json'),await readFile(resolve(root,'package-lock.json')))
  run(npm,['ci','--ignore-scripts','--offline','--no-audit'],pkg)
  const tools=JSON.parse(run(process.execPath,[join(pkg,'bin/ensp-fusion.mjs'),'tools'],temp));assert.equal(tools.length,19)
  await mkdir(join(temp,'lab'))
  const result=JSON.parse(run(process.execPath,[join(pkg,'bin/ensp-fusion.mjs'),'call','ensp_build',join(pkg,'examples/build-router-pair.json'),join(temp,'lab')],temp));assert.equal(result.ok,true)
  const xml=await readFile(join(temp,'lab/router-pair.topo'),'utf8');assert.ok(xml.includes('name="R1"'))
  assert.match(run(process.execPath,[join(pkg,'bin/ensp-fusion-doctor.mjs'),'--help'],temp),/Read-only/u)
  const acceptance=join(temp,'acceptance.json')
  await writeFile(acceptance,JSON.stringify({version:1,deadline_ms:10000,steps:[{name:'native-client',tool:'ensp_build',args:{output_path:'client.topo',devices:[{name:'Client',model:'Client',options:{pc:{ip:'10.77.0.10',dns:'10.77.0.100'}}}]}}]}))
  const accepted=JSON.parse(run(process.execPath,[join(pkg,'bin/ensp-fusion-accept.mjs'),'run',acceptance,join(temp,'lab'),'runs/nested'],temp))
  assert.equal(accepted.status,'PASS');assert.equal(JSON.parse(await readFile(join(accepted.run_dir,'summary.json'),'utf8')).ok,true)
  assert.match(await readFile(join(temp,'lab/client.topo'),'utf8'),/interfacename="Ethernet" count="1"/u)
  const evidenceFile=join(temp,'business-evidence.json')
  await writeFile(evidenceFile,JSON.stringify({version:1,kind:'stability',samples:[{completed:true,transmitted:5,received:5,loss_percent:0}]}))
  assert.equal(JSON.parse(run(process.execPath,[join(pkg,'bin/ensp-fusion-accept.mjs'),'assess',evidenceFile],temp)).status,'PASS')
  const packagedRecovery=JSON.parse(run(process.execPath,['--input-type=module','-e',`import {recoverAcceptance} from ${JSON.stringify(new URL('lib/acceptance-recovery.js',pathToFileURL(pkg+'/')).href)};console.log(JSON.stringify({available:typeof recoverAcceptance==='function'}))`],temp))
  assert.equal(packagedRecovery.available,true)
  const requests=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},{jsonrpc:'2.0',id:2,method:'tools/list'}]
  const wire=spawnSync(process.execPath,[join(pkg,'bin/dsh-ensp-mcp.mjs'),'--workspace',join(temp,'lab')],{encoding:'utf8',input:requests.map(r=>JSON.stringify(r)).join('\n')+'\n',timeout:10000,windowsHide:true})
  assert.equal(wire.status,0,wire.stderr)
  const replies=wire.stdout.trim().split('\n').map(line=>JSON.parse(line));assert.equal(replies.length,2);assert.equal(replies[0].result.serverInfo.name,'dsh-ensp-fusion');assert.equal(replies[1].result.tools.length,19)
  console.log(JSON.stringify({ok:true,files:metadata.files.length,hashVerifiedFiles:metadata.files.length,entrypoints:entrypoints.length,packedBytes:metadata.size,unpackedBytes:metadata.unpackedSize,toolCount:tools.length,checks:['licenses and release documentation','unpacked file sizes and source SHA256','all exports, CLI and bundle entrypoints present and nonempty','offline clean install','CLI external cwd','topology generation','packaged acceptance runner','packaged business evidence assessment','packaged interrupted recovery module','native Client Ethernet and DNS','doctor help','MCP stdio initialize/list']},null,2))
}finally{await rm(temp,{recursive:true,force:true})}
