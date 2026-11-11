import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createRegistry, createMcpServer } from '../mcp/server.js'
import { apply, Config } from '../index.js'
import { generateTopology, waitForConvergence } from '../lib/fusion-tools.js'
import { parseTopology, serialiseTopology } from '../upstream/lizi600jin/src/core/topology.mjs'
import { parseTopo } from '../lib/topo.js'

const args = () => ({ devices: [{ name: 'R1', model: 'AR2220' }, { name: 'R2', model: 'AR2220' }], links: [{ a: 'R1', a_port: 'GigabitEthernet0/0/0', b: 'R2', b_port: 'GigabitEthernet0/0/0' }] })
async function workspace(t) { const p = await mkdtemp(join(tmpdir(), 'ensp-fusion-')); t.after(() => rm(p, { recursive: true, force: true })); return p }
test('unified registry has twelve unique tools and closed schemas', () => {
  const r = createRegistry({ quiet: true })
  assert.equal(r.tools.length, 12); assert.equal(new Set(r.tools.map(t => t.name)).size, 12)
  const build = r.tools.find(t => t.name === 'ensp_build')
  assert.deepEqual(build.inputSchema.required, ['output_path','devices'])
  assert.deepEqual(build.inputSchema.properties.devices.items.required, ['name','model'])
})
test('DSH registers both workflow skills and the same twelve tools', () => {
  const skills=[],tools=[]
  apply({tools:{register:t=>tools.push(t)},skills:{register:s=>skills.push(s)},systemPrompt:{section:()=>{}}},Config({}))
  assert.equal(tools.length,12)
  assert.deepEqual(skills.map(s=>s.name),['ensp-automation','ensp-fusion'])
  assert.ok(skills[1].content.includes('ensp_wait'))
})
test('topology generation roundtrips through both upstream readers', () => {
  const xml = serialiseTopology(generateTopology(args()))
  assert.equal(parseTopology(xml).devices.length, 2)
  assert.equal(parseTopology(xml).links.length, 1)
  assert.equal(parseTopo(xml).devices.length, 2)
  assert.deepEqual(parseTopology(xml).devices.map(d => d.comPort), [2000,2001])
})
test('rejects bad models, ports, names, duplicate interfaces and PC XML injection', () => {
  const bad = args(); bad.devices[1].name = 'r1'; assert.throws(() => generateTopology(bad), /duplicate/)
  assert.throws(() => generateTopology({ devices: [{ name: 'X', model: '__proto__' }] }), /unknown model/)
  assert.throws(() => generateTopology({ ...args(), first_com_port: 9999 }), /comPort/)
  const dup = args(); dup.devices.forEach(d => d.options = { comPort: 2000 }); assert.throws(() => generateTopology(dup), /duplicate comPort/)
  const links = args(); links.links.push(links.links[0]); assert.throws(() => generateTopology(links), /already connected/)
  assert.throws(() => generateTopology({ devices: [{ name: 'PC1', model: 'PC', options: { pc: { ip: '"/><evil>' } } }] }), /IPv4/)
})
test('build is exclusive, workspace confined, and independent of cwd', async t => {
  const dir = await workspace(t), r = createRegistry({ workspace: dir })
  const run = a => r.tools.find(t => t.name === 'ensp_build').handler(a, r.exec)
  assert.equal((await run({ ...args(), output_path: 'new.topo' })).ok, true)
  const original = await readFile(join(dir,'new.topo'), 'utf8')
  assert.equal((await run({ ...args(), output_path: 'new.topo' })).ok, false)
  assert.equal(await readFile(join(dir,'new.topo'), 'utf8'), original)
  assert.equal((await run({ ...args(), output_path: '../escape.topo' })).ok, false)
  const outside = await workspace(t)
  await symlink(outside, join(dir,'external'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await run({ ...args(), output_path: 'external/out.topo' })).ok, false)
})
test('scenarios and generated topology integrate with MCP resources', async t => {
  const server = createMcpServer({ workspace: await workspace(t), quiet: true })
  async function call(method, params) { let response; await server.handleMessage({jsonrpc:'2.0', id:1, method, params}, r => response = r); return response }
  const scenarios = await call('tools/call', { name:'ensp_scenarios', arguments:{query:'ospf'} })
  const result = JSON.parse(scenarios.result.content[0].text)
  assert.equal(JSON.parse(result.data).total, 23)
  assert.ok(JSON.parse(result.data).scenarios.length)
  await call('tools/call', {name:'ensp_build', arguments:{...args(), output_path:'lab.topo'}})
  const topo = await call('tools/call', {name:'ensp_topo', arguments:{action:'list',topology_path:'lab.topo'}})
  assert.equal(topo.result.isError,false)
  const resource = await call('resources/read',{uri:'ensp://topology/current'})
  assert.match(resource.result.contents[0].text,/R1/)
})
test('convergence retries, enforces exact OSPF peer ID, and tracks timeout', async () => {
  let time = 0, n = 0
  const result = await waitForConvergence({port:2000,kind:'ospf_full',neighbour_id:'1.1.1.1',timeout_ms:30,interval_ms:10}, {
    now:()=>time, sleep:async ms=>{time+=ms}, query:async()=>({ok:true,output:++n===1?'11.1.1.1 Full':'1.1.1.1 Full'})
  })
  assert.equal(result.ok,true); assert.equal(result.attempts,2)
  time=0
  const failed = await waitForConvergence({port:2000,kind:'output',command:'display version',expect:'not present',timeout_ms:20,interval_ms:10}, {
    now:()=>time,sleep:async ms=>{time+=ms},query:async()=>({ok:false,error:'unavailable'})
  })
  assert.equal(failed.ok,false); assert.equal(failed.waitedMs,20); assert.equal(failed.lastError,'unavailable')
})
test('convergence rejects mutating and multiline commands before contacting transport', async () => {
  let contacted = false
  for (const command of ['reboot', 'display version\nreboot', 'display version;reboot',
    'display\nversion', 'display\tversion', 'display version\u001breboot',
    'display version\u0085reboot', 'display version\u2028reboot', 'display version\u200breboot',
    'display version | save output.txt', 'display version > output.txt',
    'display version && reboot', 'display $(reboot)', 'display `reboot`',
    'display diagnostic-information', 'DISPLAY  diagnostic-information output.txt']) {
    await assert.rejects(waitForConvergence({port:2000,kind:'output',command,expect:'VRP'}, {
      query: async () => { contacted = true; return {ok:true,output:'VRP'} },
    }), /display/)
  }
  assert.equal(contacted, false)
})

test('convergence preserves ordinary display command variants', async () => {
  for (const command of ['display version', 'DISPLAY  version', 'display ip routing-table protocol ospf']) {
    let received
    const result = await waitForConvergence({port:2000,kind:'output',command,expect:'VRP'}, {
      query: async (_, value) => { received = value; return {ok:true,output:'VRP'} },
    })
    assert.equal(result.ok, true)
    assert.equal(received, command)
  }
})
test('convergence preserves terminal authentication failure without retrying', async () => {
  let attempts = 0
  const result = await waitForConvergence({port:2000,kind:'ospf_full',timeout_ms:200}, {
    query: async () => { attempts++; throw Object.assign(new Error('no credentials'), {kind:'authentication'}) },
    sleep: async () => { throw new Error('must not retry authentication') },
  })
  assert.equal(result.ok, false)
  assert.equal(result.lastError, 'no credentials')
  assert.equal(attempts, 1)
})

test('real TCP convergence uses hardened transport and closes socket', async t => {
  const sockets = new Set(), commands = []
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close',()=>sockets.delete(socket)); socket.on('error',()=>{})
    socket.write('\r\n<R1>'); let buffer=''
    socket.on('data',data=>{
      buffer+=data.toString(); let index
      while((index=buffer.search(/[\r\n]/))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1)
        if(line){commands.push(line);socket.write(`${line}\r\n1.1.1.1 Full\r\n<R1>`)}
      }
    })
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r))})
  const result = await waitForConvergence({port:server.address().port,kind:'ospf_full',neighbour_id:'1.1.1.1',timeout_ms:3000})
  assert.equal(result.ok,true,JSON.stringify({result,commands}));assert.deepEqual(commands,['display ospf peer brief'])
})
test('real TCP silent console is bounded by the overall deadline', async t => {
  const sockets=new Set()
  const server=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{})})
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r))})
  const started=Date.now()
  const result=await waitForConvergence({port:server.address().port,kind:'ospf_full',timeout_ms:100})
  assert.equal(result.ok,false);assert.ok(Date.now()-started<1500)
})

