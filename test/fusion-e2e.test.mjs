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
async function harness(t, password = false, outputs = {}) {
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
        const output = outputs[cmd] ?? (cmd === 'display version' ? 'VRP (R) software, Version 5.110 (S5700 V200R001C00)'
          : cmd === 'display ospf peer brief' ? '1.1.1.1 Full'
          : 'Error: Unrecognized command found at position.')
        socket.write(`${cmd}\r\n${typeof output === 'function' ? output() : output}\r\n<R1>`)
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
    let value
    try { value = JSON.parse(response.result.content[0].text) } catch { value = response.result.content[0].text }
    return { wire: response.result, value }
  }
  return { dir, port: server.address().port, commands, call, rpc }
}

test('MCP inspection automatically supplements USG brief missing neighbor identity', async t => {
  const h=await harness(t,false,{
    'display current-configuration':'sysname R1\n local-user admin password cipher device-only-secret',
    'display ip interface brief':'GE1/0/1 up up',
    'display ip routing-table':'route',
    'display lldp neighbor brief':'Interface GigabitEthernet1/0/1 has 1 Neighbors:\nNeighbor 1:\nPortId: GE0/0/2',
    'display lldp neighbor':'Interface GigabitEthernet1/0/1 has 1 Neighbors:\nNeighbor 1:\nPortId: GE0/0/2\nSysName: SW',
  })
  const inspected=await h.call('ensp_inspect',{port:h.port,timeout_ms:2000})
  const evidence=JSON.parse(inspected.value.data)
  assert.equal(evidence.ok,true)
  assert.equal(evidence.results.length,6)
  assert.equal(evidence.results.at(-1).command,'display lldp neighbor')
  assert.ok(evidence.results.every(row => Number.isFinite(Date.parse(row.collected_at))))
  assert.doesNotMatch(inspected.value.data, /device-only-secret/)
  assert.ok(!h.commands.includes('lldp enable'))
})

test('MCP inspection retains partial evidence and stops at rejected command without saving', async t => {
  const h = await harness(t)
  const inspected = await h.call('ensp_inspect', { port: h.port, timeout_ms: 2000 })
  assert.equal(inspected.value.ok, false)
  assert.equal(inspected.wire.isError, true)
  const evidence = JSON.parse(inspected.value.data)
  assert.equal(evidence.ok, false)
  assert.equal(evidence.results.length, 2)
  assert.equal(evidence.results[0].ok, true)
  assert.equal(evidence.results[1].ok, false)
  assert.equal(evidence.skipped.length, 3)
  assert.ok(!h.commands.includes('save'))
  assert.ok(!h.commands.includes('lldp enable'))
})

test('journal snapshots surround commands and explicit recovery creates a linked journal', async t => {
  const h = await harness(t, false, { 'display current-configuration': 'sysname R1\n password cipher sensitive-value',
    'sysname R2': 'Done', 'sysname R1': 'Done' })
  const result = await h.call('ensp_cli', { port: h.port, commands: ['sysname R2'], save: false,
    change_dir: 'changes', recovery_commands: ['sysname R1'] })
  assert.equal(result.value.ok, true, JSON.stringify(result.value))
  const manifest = result.value.change_journal
  assert.ok(manifest)
  const folder = join(manifest, '..')
  assert.doesNotMatch(await readFile(join(folder, 'before.txt'), 'utf8'), /sensitive-value/)
  const events = (await readFile(join(folder, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(events.map(e => e.type), ['started', 'prepared', 'command-started', 'command-finished', 'configuration-diff', 'finished'])
  assert.deepEqual(h.commands, ['display current-configuration', 'display version', 'sysname R2', 'display current-configuration'])
  const recovered = await h.call('ensp_cli', { recover_from: manifest })
  assert.equal(recovered.value.ok, true, JSON.stringify(recovered.value))
  const recoveryManifest = JSON.parse(await readFile(recovered.value.change_journal, 'utf8'))
  assert.equal(recoveryManifest.recovery_of, manifest)
  const inventory = await h.call('ensp_cli', { list_changes: 'changes' })
  assert.equal(inventory.value.changes.length, 2)
  assert.ok(inventory.value.changes.every(item => item.status === 'completed'))
  assert.ok(!h.commands.includes('save'))
})

test('prechange snapshot rejection blocks configuration; dry run never contacts the console', async t => {
  const h = await harness(t)
  const preview = await h.call('ensp_cli', { port: h.port, commands: ['sysname R2'], dry_run: true })
  assert.equal(preview.value.ok, true)
  assert.equal(preview.value.preview[0].commands[0], 'sysname R2')
  assert.deepEqual(h.commands, [])
  const result = await h.call('ensp_cli', { port: h.port, commands: ['sysname R2'], change_dir: 'changes', save: false })
  assert.equal(result.value.ok, false)
  assert.deepEqual(h.commands, ['display current-configuration'])
  assert.deepEqual(result.value.skipped, ['sysname R2'])
})

test('postchange snapshot failure marks incomplete evidence and blocks unguarded recovery', async t => {
  let snapshots = 0
  const h = await harness(t, false, { 'display current-configuration': () => ++snapshots === 2 ? 'Error: Unrecognized command' : 'sysname R1',
    'sysname R2': 'Done', 'sysname R1': 'Done' })
  const changed = await h.call('ensp_cli', { port: h.port, commands: ['sysname R2'], save: false,
    change_dir: 'changes', recovery_commands: ['sysname R1'] })
  assert.equal(changed.value.ok, false)
  assert.equal(changed.value.results[0].ok, true)
  const events = (await readFile(join(changed.value.change_journal, '..', 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(events.at(-1).evidence_incomplete, true)
  const recovered = await h.call('ensp_cli', { recover_from: changed.value.change_journal })
  assert.equal(recovered.wire.isError, true)
  assert.match(JSON.stringify(recovered.value), /requires a valid post-change/u)
  assert.ok(!h.commands.includes('sysname R1'))
})

test('recovery refuses configuration drift before sending any recovery commands', async t => {
  let config = 'sysname R1\ninterface GE0/0/1\n description original'
  const h = await harness(t, false, { 'display current-configuration': () => config, 'sysname R2': 'Done', 'sysname R1': 'Done' })
  const changed = await h.call('ensp_cli', { port:h.port, commands:['sysname R2'], save:false, change_dir:'changes', recovery_commands:['sysname R1'] })
  assert.equal(changed.value.ok, true)
  config += '\n description later-human-edit'
  const recovered = await h.call('ensp_cli', {recover_from:changed.value.change_journal})
  assert.equal(recovered.value.ok, false)
  assert.match(JSON.stringify(recovered.value), /configuration drift/u)
  assert.ok(!h.commands.includes('sysname R1'))
})

test('partial rejected change retains journal progress and CLI inspection failure exits nonzero', async t => {
  const h = await harness(t, false, { 'display current-configuration': 'sysname R1', 'sysname R2': 'Done' })
  const result = await h.call('ensp_cli', { port: h.port, commands: ['sysname R2', 'invalid-command', 'sysname R3'], save: false, change_dir: 'changes' })
  assert.equal(result.value.ok, false)
  assert.equal(result.value.results.length, 2)
  assert.deepEqual(result.value.skipped, ['sysname R3'])
  const events = (await readFile(join(result.value.change_journal, '..', 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(events.filter(e => e.type === 'command-started').length, 2)
  assert.equal(events.at(-1).ok, false)
  assert.ok(!h.commands.includes('sysname R3'))
  const argsPath = join(h.dir, 'inspect.json')
  await writeFile(argsPath, JSON.stringify({ port: h.port, timeout_ms: 2000 }))
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/ensp-fusion.mjs', import.meta.url)), 'call', 'ensp_inspect', argsPath, h.dir], { windowsHide: true })
  let output = ''
  child.stdout.on('data', bytes => { output += bytes })
  const code = await new Promise(resolve => child.on('exit', resolve))
  assert.equal(code, 1)
  assert.equal(JSON.parse(output).ok, false)
})

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
  assert.equal(JSON.parse(wait.value.data).converged, false)
  assert.equal(JSON.parse(wait.value.data).attempts, 1)
  assert.ok(Date.now()-started < 2000)
  assert.deepEqual(h.commands, [])
})
