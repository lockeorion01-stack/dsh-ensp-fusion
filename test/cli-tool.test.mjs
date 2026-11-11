import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdirSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpServer } from '../mcp/server.js'
import { prepareCliEntries } from '../lib/cli-plan.js'

async function fixture(t, respond = () => 'done') {
  const commands = [], sockets = new Set()
  let connections = 0
  const server = createServer((socket) => {
    connections++
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.write('\r\n<R1>')
    let pending = '', prompt = '<R1>'
    socket.on('data', (chunk) => {
      pending += chunk.toString()
      let match
      while ((match = /\r\n|\r|\n/u.exec(pending))) {
        const line = pending.slice(0, match.index).trim()
        pending = pending.slice(match.index + match[0].length)
        if (!line) continue
        commands.push(line)
        if (line === 'system-view') prompt = '[R1]'
        if (line === 'return') prompt = '<R1>'
        const output = respond(line, socket)
        if (output === null) continue
        socket.write(`${line}\r\n${output}\r\n${prompt}`)
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  return { port: server.address().port, commands, get connections() { return connections } }
}

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ensplb-tool-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function invoke(server, name, args) {
  let response
  await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, (value) => { response = value })
  let value
  try { value = JSON.parse(response.result.content[0].text) } catch { value = response.result.content[0].text }
  return { response, value }
}

test('reject invalid batch before connecting any device', async (t) => {
  const device = await fixture(t)
  const server = createMcpServer({ workspace: await workspace(t), quiet: true })
  const { response } = await invoke(server, 'ensp_cli', { devices: [
    { port: device.port, commands: ['display version'] },
    { port: 2002, commands: ['sysname R2\nreboot'] },
  ] })
  assert.equal(response.result.isError, true)
  assert.equal(device.connections, 0)
})

test('assertions align with user commands when system-view is inserted', async (t) => {
  const device = await fixture(t, (line) => line === 'display version' ? 'VRP version 5.170' : 'Enter system view')
  const server = createMcpServer({ workspace: await workspace(t), quiet: true })
  const { response, value } = await invoke(server, 'ensp_cli', { port: device.port, commands: ['display version'], expect: ['5.170'], system_view: true, save: false })
  assert.equal(response.result.isError, false)
  assert.equal(value.ok, true)
  assert.equal(value.results[0].command, 'display version')
  assert.equal(value.checks[0].pass, true)
  assert.equal(value.setupResults[0].command, 'system-view')
})

test('CLI rejection stops commands, saving, and subsequent devices', async (t) => {
  const a = await fixture(t, () => 'Error: Unrecognized command found at ^ position.')
  const b = await fixture(t)
  const server = createMcpServer({ workspace: await workspace(t), quiet: true })
  const { response, value } = await invoke(server, 'ensp_cli', { devices: [
    { port: a.port, commands: ['bad-config', 'sysname SHOULD_NOT_RUN'] },
    { port: b.port, commands: ['sysname SHOULD_NOT_RUN'] },
  ] })
  assert.equal(response.result.isError, true)
  assert.equal(value.ok, false)
  assert.deepEqual(a.commands, ['bad-config'])
  assert.equal(b.connections, 0)
  assert.equal(value.devices[1].saved.reason, 'previous-device-failed')
  assert.ok(value.devices[0].results[0].output.includes('Error:'))
})

test('explicit continue_on_error checks remaining devices and keeps overall failure', async (t) => {
  const a = await fixture(t, () => 'Error: Wrong parameter found at ^ position.')
  const b = await fixture(t, () => 'VRP')
  const server = createMcpServer({ workspace: await workspace(t), quiet: true })
  const { value } = await invoke(server, 'ensp_cli', { continue_on_error: true, devices: [
    { port: a.port, commands: ['display invalid'] }, { port: b.port, commands: ['display version'] },
  ] })
  assert.equal(value.ok, false)
  assert.equal(value.devices[1].ok, true)
  assert.equal(b.connections, 1)
})

test('save rejection makes the tool fail while retaining configuration evidence', async (t) => {
  const device = await fixture(t, (line) => line === 'save' ? 'Error: Failed to save configuration.' : 'Command accepted')
  const server = createMcpServer({ workspace: await workspace(t), quiet: true })
  const { value, response } = await invoke(server, 'ensp_cli', { port: device.port, commands: ['sysname R1'] })
  assert.equal(response.result.isError, true)
  assert.equal(value.ok, false)
  assert.equal(value.saved.ok, false)
  assert.equal(value.results[0].command, 'sysname R1')
  assert.ok(!device.commands.includes('y'))
})

test('reject replaying configuration into GUI before device connection', async (t) => {
  const device = await fixture(t)
  const server = createMcpServer({ workspace: await workspace(t), quiet: true })
  const { response } = await invoke(server, 'ensp_cli', { port: device.port, device: 'R1', commands: ['sysname R1'], echo_to_window: true })
  assert.equal(response.result.isError, true)
  assert.equal(device.connections, 0)
})

test('output junction cannot escape workspace', async (t) => {
  const dir = await workspace(t)
  const outside = await workspace(t)
  await mkdir(join(dir, 'inner'))
  await symlink(outside, join(dir, 'inner', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  const device = await fixture(t)
  const server = createMcpServer({ workspace: dir, quiet: true })
  const { response } = await invoke(server, 'ensp_cli', { port: device.port, commands: ['display version'], output_file: 'inner/escape/leak.txt' })
  assert.equal(response.result.isError, true)
  assert.equal(device.connections, 0)
})

test('acceptance tool writes evidence reports using loopback console', async (t) => {
  const dir = await workspace(t)
  const device = await fixture(t, () => 'GigabitEthernet0/0/0 10.0.0.1 up up')
  await writeFile(join(dir, 'plan.json'), JSON.stringify({ title: 'Loopback fixture only', devices: [
    { device: 'R1', port: device.port, commands: [{ cmd: 'display ip interface brief', expect: '10.0.0.1 up up', layer: 'interface' }] },
  ] }))
  const server = createMcpServer({ workspace: dir, quiet: true })
  const { response, value } = await invoke(server, 'ensp_labtest', { plan_path: 'plan.json', report_prefix: 'reports/acceptance' })
  assert.equal(response.result.isError, false)
  assert.equal(value.ok, true)
  for (const path of Object.values(value.files)) assert.ok((await readFile(path, 'utf8')).includes('PASS'))
  assert.deepEqual(device.commands, ['display ip interface brief'])
})

test('planner rejects duplicate targets, invalid port, regex and empty commands', () => {
  for (const args of [
    { port: 65536, commands: ['display version'] },
    { port: 2001, commands: [] },
    { port: 2001, commands: ['display version\u2028reboot'] },
    { port: 2001, commands: ['display version'], expect: ['/[invalid/'] },
    { devices: [{ port: 2001, commands: ['display version'] }, { port: 2001, commands: ['display version'] }] },
  ]) assert.throws(() => prepareCliEntries(args))
})

test('transcript write failure preserves already-executed configuration evidence', async (t) => {
  const dir = await workspace(t)
  const device = await fixture(t, () => {
    mkdirSync(join(dir, 'transcript.txt'))
    return 'Configuration applied'
  })
  const server = createMcpServer({ workspace: dir, quiet: true })
  const { value, response } = await invoke(server, 'ensp_cli', { port: device.port, commands: ['sysname CHANGED'], save: false, output_file: 'transcript.txt' })
  assert.equal(response.result.isError, true)
  assert.equal(value.ok, false)
  assert.equal(value.artifactError.phase, 'transcript')
  assert.equal(value.results[0].command, 'sysname CHANGED')
  assert.equal(value.results[0].ok, true)
  assert.deepEqual(value.skipped, [])
  assert.equal(value.saved.reason, 'disabled-by-args')
})

test('refused connection is reported as an error in acceptance, not just skipped', async (t) => {
  const reservation = createServer()
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const dir = await workspace(t)
  await writeFile(join(dir, 'plan.json'), JSON.stringify({ devices: [
    { port, commands: [{ cmd: 'display version', expect: 'VRP' }] },
  ] }))
  const server = createMcpServer({ workspace: dir, quiet: true })
  const { value, response } = await invoke(server, 'ensp_labtest', { plan_path: 'plan.json', report_prefix: 'report' })
  assert.equal(response.result.isError, true)
  assert.equal(value.ok, false)
  assert.equal(value.devices[0].status, 'ERROR')
  assert.equal(value.counts.error, 1)
})
