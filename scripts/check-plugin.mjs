import { readFile, access, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { apply, Config, inject } from '../index.js'
import { createRegistry } from '../mcp/server.js'
import { resolveRuntime, runProcess } from '../lib/bridge-client.js'

const root = fileURLToPath(new URL('../',import.meta.url))
const checks = []
async function check(name, action) {
  try { checks.push({name,status:'PASS',details:await action()}) }
  catch(error) { checks.push({name,status:'FAIL',details:error.message}) }
}
const pkg = JSON.parse(await readFile(join(root,'package.json'),'utf8'))
await check('package entrypoints and lockfile', async () => {
  const lock = JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'))
  assert.equal(lock.name,pkg.name); assert.equal(lock.version,pkg.version)
  assert.deepEqual(lock.packages[''].peerDependencies,pkg.peerDependencies)
  for (const path of [...Object.values(pkg.exports),...Object.values(pkg.bin),pkg.dsh.bundle.patch]) await access(join(root,path))
  for (const key of Object.keys(pkg.exports)) await import(key==='.'?pkg.name:`${pkg.name}/${key.slice(2)}`)
  return {name:pkg.name,version:pkg.version,exports:Object.keys(pkg.exports),bins:Object.keys(pkg.bin)}
})
await check('DSH registration contract', async () => {
  const tools=[],skills=[],sections=[]
  apply({tools:{register:t=>tools.push(t)},skills:{register:s=>skills.push(s)},systemPrompt:{section:(...s)=>sections.push(s)}},Config({}))
  assert.equal(tools.length,16);assert.equal(new Set(tools.map(t=>t.name)).size,16)
  assert.equal(skills.length,2);assert.ok(sections.length)
  for(const skill of skills){assert.ok(skill.content);await access(skill.resourceBase.path)}
  const patch = await readFile(join(root,pkg.dsh.bundle.patch),'utf8')
  assert.match(patch,/name: dsh-ensp-fusion/)
  return {tools:tools.map(t=>t.name),skills:skills.map(s=>s.name),injectedServices:inject,host:'registration stub; full DSH host not launched'}
})
await check('MCP tool schemas and local scenario call', async () => {
  const r=createRegistry({workspace:root})
  for(const tool of r.tools){assert.equal(tool.inputSchema.type,'object');assert.equal(typeof tool.handler,'function')}
  const result=await r.tools.find(t=>t.name==='ensp_scenarios').handler({query:'ospf'},r.exec)
  assert.equal(result.ok,true);assert.equal(JSON.parse(result.data).total,23)
  return {tools:r.tools.length,scenarios:23}
})
await check('installed Node dependencies', async () => {
  const npm=process.platform==='win32'?'npm.cmd':'npm'
  const r=spawnSync(npm,['ls','--depth=0','--json'],{cwd:root,encoding:'utf8',shell:process.platform==='win32',windowsHide:true,timeout:15000})
  assert.equal(r.status,0,r.stderr||r.stdout)
  const data=JSON.parse(r.stdout)
  return Object.fromEntries(Object.entries(data.dependencies).map(([name,value])=>[name,value.version]))
})
await check('package contents and syntax', async () => {
  const npm=process.platform==='win32'?'npm.cmd':'npm'
  const r=spawnSync(npm,['pack','--dry-run','--ignore-scripts','--json'],{cwd:root,encoding:'utf8',shell:process.platform==='win32',windowsHide:true,timeout:15000})
  assert.equal(r.status,0,r.stderr)
  const files=JSON.parse(r.stdout)[0].files.map(f=>f.path)
  for(const required of ['LICENSE','LICENSE-MIT','upstream/lizi600jin/LICENSE','lib/bridge.py','lib/launch.py','skills/ensp-fusion/SKILL.md'])assert.ok(files.includes(required),required)
  assert.ok(!files.some(f=>/^(node_modules|test-results)\//.test(f)))
  const scripts=files.filter(f=>/\.(mjs|js)$/.test(f))
  for(const file of scripts){const s=spawnSync(process.execPath,['--check',join(root,file)],{encoding:'utf8',windowsHide:true,timeout:5000});assert.equal(s.status,0,`${file}: ${s.stderr}`)}
  return {files:files.length,syntaxChecked:scripts.length,privatePackage:pkg.private,publication:pkg.private?'local package only':'public npm package (publish pending)'}
})
if(process.platform==='win32') {
  try {
    const runtime=await resolveRuntime(Config({}),{})
    checks.push({name:'GUI Python dependencies',status:'PASS',details:runtime})
    const doc=await runProcess(runtime.python,['-c','import docx; print(docx.__version__)'],{timeoutMs:10000})
    checks.push({name:'document Python dependencies',status:doc.code===0?'PASS':'WARN',details:doc.code===0?{python:runtime.python,pythonDocx:doc.stdout.trim(),mcpOption:'--docs-python'}:'python-docx unavailable in GUI Python; configure a separate document Python'})
  } catch(error){checks.push({name:'GUI Python dependencies',status:'WARN',details:error.message})}
} else checks.push({name:'GUI Python dependencies',status:'WARN',details:'GUI requires Windows; offline/MCP tools may still work'})
const report={timestamp:new Date().toISOString(),node:process.version,platform:process.platform,ok:!checks.some(c=>c.status==='FAIL'),checks,limits:['Does not launch the full DSH host or change any profile.','Does not start eNSP, configure devices, or test real network convergence.','Does not query a dependency vulnerability database.']}
const output=process.env.ENSP_CHECK_OUTPUT ? resolve(process.env.ENSP_CHECK_OUTPUT) : join(tmpdir(),'dsh-ensp-fusion','plugin-check.json')
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report,null,2))
process.exitCode=report.ok?0:1
