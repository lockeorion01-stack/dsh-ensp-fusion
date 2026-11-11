import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
const root=fileURLToPath(new URL('../',import.meta.url))
const npm=process.platform==='win32'?'npm.cmd':'npm'
function run(command,args,cwd){const r=spawnSync(command,args,{cwd,encoding:'utf8',shell:process.platform==='win32'&&command===npm,windowsHide:true});if(r.status!==0)throw Error(r.stdout+r.stderr);return r.stdout}
const temp=await mkdtemp(join(tmpdir(),'ensp-fusion-package-'))
try{
  const metadata=JSON.parse(run(npm,['pack','--ignore-scripts','--json','--pack-destination',temp],root))[0]
  for(const file of ['index.js','base.js','LICENSE','LICENSE-MIT','upstream/lizi600jin/LICENSE','test/fixtures/minimal.topo','lib/bridge.py'])assert.ok(metadata.files.some(f=>f.path===file),file)
  run('tar',['-xf',join(temp,metadata.filename),'-C',temp],temp)
  const pkg=join(temp,'package')
  await writeFile(join(pkg,'package-lock.json'),await readFile(resolve(root,'package-lock.json')))
  run(npm,['ci','--ignore-scripts','--offline','--no-audit'],pkg)
  const tools=JSON.parse(run(process.execPath,[join(pkg,'bin/ensp-fusion.mjs'),'tools'],temp));assert.equal(tools.length,12)
  await mkdir(join(temp,'lab'))
  const result=JSON.parse(run(process.execPath,[join(pkg,'bin/ensp-fusion.mjs'),'call','ensp_build',join(pkg,'examples/build-router-pair.json'),join(temp,'lab')],temp));assert.equal(result.ok,true)
  const xml=await readFile(join(temp,'lab/router-pair.topo'),'utf8');assert.ok(xml.includes('name="R1"'))
  const requests=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},{jsonrpc:'2.0',id:2,method:'tools/list'}]
  const wire=spawnSync(process.execPath,[join(pkg,'bin/dsh-ensp-mcp.mjs'),'--workspace',join(temp,'lab')],{encoding:'utf8',input:requests.map(r=>JSON.stringify(r)).join('\n')+'\n',timeout:10000,windowsHide:true})
  assert.equal(wire.status,0,wire.stderr)
  const replies=wire.stdout.trim().split('\n').map(line=>JSON.parse(line));assert.equal(replies.length,2);assert.equal(replies[0].result.serverInfo.name,'dsh-ensp-fusion');assert.equal(replies[1].result.tools.length,12)
  console.log(JSON.stringify({ok:true,files:metadata.files.length,packedBytes:metadata.size,unpackedBytes:metadata.unpackedSize,toolCount:tools.length,checks:['licenses','offline clean install','CLI external cwd','topology generation','MCP stdio initialize/list']},null,2))
}finally{await rm(temp,{recursive:true,force:true})}
