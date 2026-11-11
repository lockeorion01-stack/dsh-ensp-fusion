import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Real MCP subprocess and real loopback sockets; devices remain simulated.
async function harness(t, password = false) {
  const dir = await mkdtemp(join(tmpdir(), 'ensp-fusion-e2e-'))
  const sockets = new Set(), commands = []
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.write(password ? '\r\nPassword:' : '\r\n<R1>')
    let buffer = ''
    socket.on('data', bytes => {
      buffer += bytes.toString()
      let index
      while ((index = buffer.search(/[\r\n]/)) >= 0) {
        const cmd = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!cmd) continue
        commands.push(cmd)
        if (password) continue
        const output = cmd === 'display version' ? 'Huawei Versatile Routing Platform (VRP)'
          : cmd === 'display ospf peer brief' ? '1.1.1.1 Full'
          : 'Error: Unrecognized command found at position.'
        socket.write(`${cmd}\r\n${output}\r\n<R1>`)
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/dsh-ensp-mcp.mjs', import.meta.url)), '--workspace', dir], { windowsHide: true })
  const pending = new Map()
  let id = 0, stderr = ''
  child.stderr.on('data', data => { stderr += data })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    try {
      const response = JSON.parse(line), waiter = pending.get(response.id)
      if (waiter) { pending.delete(response.id); clearTimeout(waiter.timer); waiter.resolve(response) }
    } catch (error) {
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error) }
      pending.clear()
    }
  })
  function failed(error) {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error) }
    pending.clear()
  }
  child.on('error', failed)
  child.on('exit', code => failed(new Error(`MCP exited ${code}: ${stderr}`)))
  t.after(async () => {
    child.kill()
    lines.close()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  })
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`MCP timeout: ${method}: ${stderr}`)) }, 10000)
    pending.set(requestId, { resolve, reject, timer })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n')
  })
  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fusion-e2e', version: '1' } })
  assert.equal(initialized.result.serverInfo.name, 'dsh-ensp-fusion')
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const call = async (name, args) => {
    const response = await rpc('tools/call', { name, arguments: args })
    assert.equal(response.error, undefined, JSON.stringify(response))
    return { wire: response.result, value: JSON.parse(response.result.content[0].text) }
  }
  return { dir, port: server.address().port, commands, call, rpc }
}

test('MCP stdio completes build, topology read, resource refresh and overwrite rejection', async t => {
  const h = await harness(t)
  const args = { output_path: 'pair.topo', devices: [{name:'R1',model:'AR2220'}, {name:'R2',model:'AR2220'}], links: [{a:'R1',a_port:'GigabitEthernet0/0/0',b:'R2',b_port:'GigabitEthernet0/0/0'}] }
  const built = await h.call('ensp_build', args)
  assert.equal(built.wire.isError, false)
  const original = await readFile(join(h.dir, 'pair.topo'), 'utf8')
  const listed = await h.call('ensp_topo', { topology_path: 'pair.topo', action: 'list' })
  assert.equal(listed.value.devices.length, 2)
  const resource = await h.rpc('resources/read', { uri: 'ensp://topology/current' })
  assert.match(resource.result.contents[0].text, /R1/)
  const duplicate = await h.call('ensp_build', args)
  assert.equal(duplicate.wire.isError, true)
  assert.equal(await readFile(join(h.dir, 'pair.topo'), 'utf8'), original)
})

test('MCP stdio runs CLI, convergence and acceptance against TCP console with report assertions', async t => {
  const h = await harness(t)
  const h2 = await harness(t), h3 = await harness(t)
  const cli = await h.call('ensp_cli', {port:h.port,commands:['display version'],expect:['VRP'],save:false})
  assert.equal(cli.wire.isError, false)
  assert.equal(cli.value.ok, true)
  const wait = await h.call('ensp_wait', {port:h.port,kind:'ospf_full',neighbour_id:'1.1.1.1',timeout_ms:2000})
  assert.equal(wait.wire.isError, false)
  assert.equal(JSON.parse(wait.value.data).converged, true)
  await writeFile(join(h.dir, 'plan.json'), JSON.stringify({title:'TCP acceptance',devices:[
    {device:'R1',port:h.port,commands:[{cmd:'display version',expect:'VRP'}]},
    {device:'R2',port:h2.port,commands:[{cmd:'display version',expect:'NOT_PRESENT'}]},
    {device:'R3',port:h3.port,commands:[{cmd:'display version',expect:'VRP'}]},
  ]}))
  const report = await h.call('ensp_labtest', {plan_path:'plan.json',report_prefix:'report'})
  assert.equal(report.wire.isError, true)
  assert.deepEqual(report.value.counts, {total:3,pass:2,fail:1,error:0,skipped:0})
  assert.deepEqual(report.value.rows.map(row=>row.status), ['PASS','FAIL','PASS'])
  const saved = JSON.parse(await readFile(join(h.dir, 'report.json'), 'utf8'))
  assert.deepEqual(saved.counts, report.value.counts)
  assert.match(await readFile(join(h.dir, 'report.md'), 'utf8'), /PASS: 2; FAIL: 1/)
  assert.match(await readFile(join(h.dir, 'report.csv'), 'utf8'), /NOT_PRESENT/)
  const before = h.commands.length
  const denied = await h.call('ensp_wait', {port:h.port,kind:'output',command:'display\nversion',expect:'VRP'})
  assert.equal(denied.wire.isError, true)
  assert.equal(h.commands.length, before)
  assert.ok([...h.commands,...h2.commands,...h3.commands].every(cmd=>cmd.startsWith('display ')))
})

test('MCP stdio exposes missing authentication as failure and bounds wait', async t => {
  const h = await harness(t, true)
  const cli = await h.call('ensp_cli', {port:h.port,commands:['display version'],save:false})
  assert.equal(cli.wire.isError, true)
  assert.equal(cli.value.failure.phase, 'connect')
  const started = Date.now()
  const wait = await h.call('ensp_wait', {port:h.port,kind:'output',command:'display version',expect:'VRP',timeout_ms:200,interval_ms:50})
  assert.equal(wait.wire.isError, true)
  assert.match(wait.value.error, /no credentials/)
  assert.ok(Date.now()-started < 2000)
  assert.deepEqual(h.commands, [])
})
