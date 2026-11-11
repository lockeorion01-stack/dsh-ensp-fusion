// Offline MCP context tests: real topology reads plus stubbed tool failures.
// Run with: node --test test/mcp-context.test.mjs
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { INSTRUCTIONS } from '../mcp/instructions.js'
import { createMcpServer } from '../mcp/server.js'

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const TOPOLOGY_URI = 'ensp://topology/current'
const LIST_ARGS = { action: 'list', topology_path: 'minimal.topo' }
const createServer = (options = {}) => createMcpServer({ workspace: WORKSPACE, quiet: true, ...options })

async function call(server, method, params, id = 1) {
  const sent = []
  await server.handleMessage({ jsonrpc: '2.0', id, method, params }, (payload) => sent.push(payload))
  assert.equal(sent.length, 1, `${method} must produce exactly one response`)
  assert.equal(sent[0].jsonrpc, '2.0')
  assert.equal(sent[0].id, id)
  return sent[0]
}

async function readResource(server, uri) {
  const response = await call(server, 'resources/read', { uri })
  assert.equal(response.error, undefined)
  assert.equal(response.result.contents.length, 1)
  const content = response.result.contents[0]
  assert.equal(content.uri, uri)
  assert.equal(content.mimeType, 'application/json')
  return JSON.parse(content.text)
}

function callTopo(server, args = LIST_ARGS) {
  return call(server, 'tools/call', { name: 'ensp_topo', arguments: args })
}

test('advertises resources and prompts; workspace resource reports effective configuration', async () => {
  const server = createServer()
  const init = await call(server, 'initialize', { protocolVersion: '2025-06-18' }, 0)
  assert.deepEqual(init.result.capabilities, {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
    prompts: { listChanged: false },
  })
  const list = await call(server, 'resources/list')
  assert.deepEqual(list.result.resources.map(({ uri }) => uri), ['ensp://workspace', TOPOLOGY_URI])
  assert.ok(list.result.resources.every((resource) => resource.name && resource.mimeType === 'application/json'))
  assert.deepEqual((await call(server, 'resources/templates/list')).result, { resourceTemplates: [] })
  assert.deepEqual(await readResource(server, 'ensp://workspace'), {
    workspace: WORKSPACE,
    restrictToWorkspace: true,
    serverInfo: init.result.serverInfo,
  })
  const unrestricted = createServer({ overrides: { restrictToWorkspace: false } })
  assert.equal((await readResource(unrestricted, 'ensp://workspace')).restrictToWorkspace, false)
})

test('fresh topology explicitly reports no snapshot, even when a topology file exists', async () => {
  const topology = await readResource(createServer(), TOPOLOGY_URI)
  assert.equal(topology.topologyPath, null)
  assert.deepEqual(topology.devices, [])
  assert.match(topology.message, /No topology loaded.*ensp_topo.*list.*topology_path/u)
})

test('successful topology list populates the snapshot; failed and other actions preserve it', async () => {
  const server = createServer()
  const response = await callTopo(server)
  assert.equal(response.result.isError, false)
  const value = JSON.parse(response.result.content[0].text)
  assert.equal(value.topologyPath, resolve(WORKSPACE, 'minimal.topo'))
  assert.equal(value.devices.length, 3)
  assert.equal(value.devices.find(({ name }) => name === 'SW1').comPort, 2001)
  assert.equal(value.devices.find(({ name }) => name === 'PC1').comPort, 0)
  assert.deepEqual(await readResource(server, TOPOLOGY_URI), value)

  const suggested = await callTopo(server, { ...LIST_ARGS, action: 'suggest-names' })
  assert.equal(suggested.result.isError, false)
  assert.deepEqual(await readResource(server, TOPOLOGY_URI), value)
  for (const topology_path of ['missing.topo', '../mcp-smoke.mjs']) {
    const failure = await callTopo(server, { ...LIST_ARGS, topology_path })
    assert.equal(failure.result.isError, true)
    assert.deepEqual(await readResource(server, TOPOLOGY_URI), value)
  }
  assert.equal((await readResource(createServer(), TOPOLOGY_URI)).topologyPath, null)
})

test('snapshot refreshes on successful lists and is independent of subsequent result mutations', async () => {
  const server = createServer()
  await callTopo(server)
  const tool = server.registry.tools.find(({ name }) => name === 'ensp_topo')
  const next = { topologyPath: 'second.topo', devices: [{ name: 'AR2', comPort: 2010 }] }
  tool.handler = async () => next
  await callTopo(server)
  assert.deepEqual(await readResource(server, TOPOLOGY_URI), next)
  next.devices[0].name = 'mutated'
  tool.handler = () => { throw new Error('resource reads must not invoke the tool') }
  assert.equal((await readResource(server, TOPOLOGY_URI)).devices[0].name, 'AR2')
})

test('tool ok=false is an MCP error, retains details, and cannot replace the last good snapshot', async () => {
  const server = createServer()
  await callTopo(server)
  const before = await readResource(server, TOPOLOGY_URI)
  const tool = server.registry.tools.find(({ name }) => name === 'ensp_topo')
  const failure = { ok: false, reason: 'validation failed', devices: [] }
  tool.handler = async () => failure
  const response = await callTopo(server)
  assert.equal(response.result.isError, true)
  assert.deepEqual(JSON.parse(response.result.content[0].text), failure)
  assert.deepEqual(await readResource(server, TOPOLOGY_URI), before)

  for (const name of ['ensp_cli', 'ensp_labtest']) {
    const registered = server.registry.tools.find((entry) => entry.name === name)
    assert.ok(registered, `${name} must be registered`)
    registered.handler = async () => ({ ok: false, reason: 'offline simulated failure' })
    assert.equal((await call(server, 'tools/call', { name })).result.isError, true)
    for (const value of [{ ok: true }, { ok: 0 }, { ok: 'false' }, {}]) {
      registered.handler = async () => value
      assert.equal((await call(server, 'tools/call', { name })).result.isError, false)
    }
  }
})

test('resource URIs are exact allowlisted identifiers, never filesystem paths', async () => {
  const server = createServer()
  for (const uri of [
    'ensp://unknown', 'ensp://workspace/minimal.topo', 'ensp://topology/current/../minimal.topo',
    'ensp://topology/current?path=minimal.topo', 'file:///C:/Windows/win.ini',
    resolve(WORKSPACE, 'minimal.topo'), '',
  ]) {
    const response = await call(server, 'resources/read', { uri })
    assert.equal(response.error.code, -32002, uri)
    assert.deepEqual(response.error.data, { uri })
    assert.equal(response.result, undefined)
  }
  for (const params of [undefined, {}, { uri: null }, { uri: 42 }]) {
    assert.equal((await call(server, 'resources/read', params)).error.code, -32602)
  }
})

test('playbook reuses INSTRUCTIONS with an optional goal and rejects invalid prompts', async () => {
  const server = createServer()
  const prompts = (await call(server, 'prompts/list')).result.prompts
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].name, 'ensp_ops_playbook')
  assert.deepEqual(prompts[0].arguments.map(({ name, required }) => ({ name, required })), [
    { name: 'goal', required: false },
  ])
  const base = await call(server, 'prompts/get', { name: 'ensp_ops_playbook' })
  assert.deepEqual(base.result.messages, [{ role: 'user', content: { type: 'text', text: INSTRUCTIONS } }])
  const goal = '核对 SW1 的 VLAN 配置\nKeep evidence.'
  const tailored = await call(server, 'prompts/get', { name: 'ensp_ops_playbook', arguments: { goal } })
  assert.deepEqual(tailored.result.messages[0], base.result.messages[0])
  assert.deepEqual(tailored.result.messages[1], { role: 'user', content: { type: 'text', text: `Goal: ${goal}` } })
  for (const params of [undefined, {}, { name: 'unknown' }, { name: null }]) {
    assert.equal((await call(server, 'prompts/get', params)).error.code, -32602)
  }
  for (const args of [null, [], 'goal', { goal: 42 }, { goal: null }, { unexpected: 'value' }]) {
    assert.equal((await call(server, 'prompts/get', { name: 'ensp_ops_playbook', arguments: args })).error.code, -32602)
  }
})

test('notifications never respond on any known method, including success and error paths', async () => {
  const server = createServer()
  const messages = [
    ['initialize', { protocolVersion: '2025-06-18' }],
    ['notifications/initialized'], ['notifications/cancelled'], ['ping'], ['tools/list'],
    ['tools/call', { name: 'ensp_topo', arguments: LIST_ARGS }],
    ['tools/call', { name: 'ensp_topo', arguments: { ...LIST_ARGS, topology_path: 'missing.topo' } }],
    ['tools/call', { name: 'unknown' }],
    ['resources/list'], ['resources/templates/list'],
    ['resources/read', { uri: 'ensp://workspace' }], ['resources/read', { uri: TOPOLOGY_URI }],
    ['resources/read', { uri: 'ensp://unknown' }], ['resources/read'],
    ['prompts/list'], ['prompts/get', { name: 'ensp_ops_playbook', arguments: { goal: 'Inspect VLANs' } }],
    ['prompts/get', { name: 'unknown' }],
    ['prompts/get', { name: 'ensp_ops_playbook', arguments: { goal: 42 } }],
    ['unknown/method'],
  ]
  for (const idFields of [{}, { id: null }]) {
    for (const [method, params] of messages) {
      const sent = []
      await server.handleMessage({ jsonrpc: '2.0', ...idFields, method, params }, (payload) => sent.push(payload))
      assert.deepEqual(sent, [], `${method} notification must not respond`)
    }
  }
  assert.equal((await readResource(server, TOPOLOGY_URI)).devices.length, 3)
  const tool = server.registry.tools.find(({ name }) => name === 'ensp_topo')
  tool.handler = async () => ({ ok: false, reason: 'offline failure' })
  const sent = []
  await server.handleMessage({ method: 'tools/call', params: { name: tool.name, arguments: LIST_ARGS } }, (payload) => sent.push(payload))
  assert.deepEqual(sent, [])
  assert.equal((await call(server, 'ping', undefined, 0)).id, 0)
  assert.equal((await call(server, 'unknown/method')).error.code, -32601)
  assert.equal((await call(server, 'tools/call', { name: 'unknown' })).error.code, -32602)
})
