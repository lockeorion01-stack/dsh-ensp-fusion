// MCP server for dsh-ensp.
//
// The six tools are not re-implemented here: `apply()` from ../index.js is called
// with a stand-in context, which registers exactly the same tool objects the DSH
// plugin uses (same names, same schemas, same handlers). This file only translates
// between MCP's JSON-RPC surface and those tools, so behaviour cannot drift between
// the two front ends.
//
// Start it with:  node bin/dsh-ensp-mcp.mjs --workspace E:/labs

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Config, apply } from '../index.js'
import { INSTRUCTIONS } from './instructions.js'
import { DEFAULT_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, errorMessage, result, startStdio } from './protocol.js'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PACKAGE_JSON = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8'))

const SERVER_NAME = 'dsh-ensp-fusion'
const SERVER_VERSION = PACKAGE_JSON.version

const RESOURCES = [
  {
    uri: 'ensp://workspace',
    name: 'workspace',
    description: 'MCP workspace metadata and the configured workspace boundary.',
    mimeType: 'application/json',
  },
  {
    uri: 'ensp://topology/current',
    name: 'current_topology',
    description: 'Latest successful ensp_topo action=list snapshot in this server session. Call ensp_topo again to refresh it.',
    mimeType: 'application/json',
  },
]

const OPS_PLAYBOOK = {
  name: 'ensp_ops_playbook',
  title: 'ENSP Operations Playbook',
  description: 'Operating guidance for eNSP, with an optional task goal.',
  arguments: [{ name: 'goal', description: 'The eNSP task to accomplish.', required: false }],
}

/**
 * DSH's `defineTool` already normalizes a parameter record into a JSON Schema
 * object (`{type:'object', properties, required}`) and lifts the `required: true`
 * property flags into that array, so the normalized form is passed straight
 * through. The property-record form is still handled in case a future tool is
 * registered without going through defineTool.
 */
function toInputSchema(parameters = {}) {
  if (parameters && parameters.type === 'object' && parameters.properties) {
    return { ...parameters, additionalProperties: parameters.additionalProperties ?? false }
  }
  const properties = {}
  const required = []
  for (const [key, schema] of Object.entries(parameters)) {
    const { required: isRequired, ...rest } = schema ?? {}
    properties[key] = rest
    if (isRequired === true) required.push(key)
  }
  const inputSchema = { type: 'object', properties, additionalProperties: false }
  if (required.length > 0) inputSchema.required = required
  return inputSchema
}

/**
 * Build the tool registry through the same code path the DSH plugin uses.
 * `cwd` is the only piece of the DSH exec context the tools read.
 */
export function createRegistry({ workspace, restrictToWorkspace = true, overrides = {} } = {}) {
  const config = Config({
    registerSkill: false,
    injectPrompt: false,
    restrictToWorkspace,
    ...overrides,
  })

  const registered = []
  const ctx = {
    tools: { register: (tool) => registered.push(tool) },
    skills: { register: () => {} },
    systemPrompt: { section: () => {} },
  }
  apply(ctx, config)

  const cwd = resolve(workspace ?? process.env.ENSP_MCP_WORKSPACE ?? process.cwd())
  const exec = { agent: { session: { header: { cwd } } } }

  const tools = registered.map((tool) => ({
    name: tool.name,
    // defineTool keeps only name/description/parameters/output/execute, so the
    // renderer lives under output and there is no separate title.
    title: tool.title ?? tool.name,
    description: tool.description ?? '',
    inputSchema: toInputSchema(tool.parameters),
    handler: tool.execute,
    render: typeof tool.output?.render === 'function' ? tool.output.render : null,
    isConcurrencySafe: false,
  }))

  return { config, cwd, exec, tools }
}

/** Turn a tool return value into MCP content blocks. */
function toContent(tool, args, value) {
  if (tool.render) {
    const blocks = tool.render(args, value)
    if (Array.isArray(blocks) && blocks.length > 0) return blocks
  }
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

export function createMcpServer(options = {}) {
  const registry = createRegistry(options)
  const byName = new Map(registry.tools.map((tool) => [tool.name, tool]))
  const log = options.quiet ? () => {} : (message) => process.stderr.write(`[dsh-ensp] ${message}\n`)

  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION }
  const capabilities = {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
    prompts: { listChanged: false },
  }
  // Store serialized data, not a file handle or a live tool result. Resource
  // reads never resolve paths or re-read the filesystem.
  let topologySnapshot = JSON.stringify({
    topologyPath: null,
    devices: [],
    message: 'No topology loaded yet. Call ensp_topo with action="list" and topology_path to load a snapshot.',
  }, null, 2)
  let initialized = false

  async function handleMessage(message, send) {
    const { id, method, params } = message ?? {}
    // Notifications (no id) never get a response.
    const isNotification = id === undefined || id === null
    const reply = (payload) => {
      if (!isNotification) send(payload)
    }

    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION
        initialized = true
        log(`initialize from ${params?.clientInfo?.name ?? 'unknown'} (${protocolVersion}), workspace ${registry.cwd}`)
        reply(result(id, {
          protocolVersion,
          capabilities,
          serverInfo,
          instructions: INSTRUCTIONS,
        }))
        return
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return
      case 'ping':
        reply(result(id, {}))
        return
      case 'tools/list': {
        const tools = registry.tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }))
        reply(result(id, { tools }))
        return
      }
      case 'tools/call': {
        const name = params?.name
        const args = params?.arguments ?? {}
        const tool = byName.get(name)
        if (!tool) {
          reply(errorMessage(id, -32602, `unknown tool: ${name}`, { available: [...byName.keys()] }))
          return
        }
        const started = Date.now()
        try {
          const value = await tool.handler(args, registry.exec)
          const isError = value?.ok === false
          const content = toContent(tool, args, value)
          if (name === 'ensp_topo' && args.action === 'list' && !isError) {
            topologySnapshot = JSON.stringify(value, null, 2)
          }
          log(`${name} ${isError ? 'failed' : 'ok'} in ${Date.now() - started} ms`)
          reply(result(id, { content, isError }))
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error)
          log(`${name} failed in ${Date.now() - started} ms: ${text}`)
          reply(result(id, { content: [{ type: 'text', text }], isError: true }))
        }
        return
      }
      case 'resources/list':
        reply(result(id, { resources: RESOURCES }))
        return
      case 'resources/read': {
        const uri = params?.uri
        if (typeof uri !== 'string') {
          reply(errorMessage(id, -32602, 'uri must be a string'))
          return
        }
        let text
        if (uri === 'ensp://workspace') {
          text = JSON.stringify({
            workspace: registry.cwd,
            restrictToWorkspace: registry.config.restrictToWorkspace,
            serverInfo,
          }, null, 2)
        } else if (uri === 'ensp://topology/current') {
          text = topologySnapshot
        } else {
          reply(errorMessage(id, -32002, `resource not found: ${uri}`, { uri }))
          return
        }
        reply(result(id, { contents: [{ uri, mimeType: 'application/json', text }] }))
        return
      }
      case 'resources/templates/list':
        reply(result(id, { resourceTemplates: [] }))
        return
      case 'prompts/list':
        reply(result(id, { prompts: [OPS_PLAYBOOK] }))
        return
      case 'prompts/get': {
        if (params?.name !== OPS_PLAYBOOK.name) {
          reply(errorMessage(id, -32602, `unknown prompt: ${params?.name}`))
          return
        }
        const args = params.arguments === undefined ? {} : params.arguments
        if (!args || typeof args !== 'object' || Array.isArray(args)
          || Object.keys(args).some((key) => key !== 'goal')
          || (args.goal !== undefined && typeof args.goal !== 'string')) {
          reply(errorMessage(id, -32602, 'prompt arguments must be an object with an optional string goal'))
          return
        }
        const messages = [{ role: 'user', content: { type: 'text', text: INSTRUCTIONS } }]
        if (args.goal) messages.push({ role: 'user', content: { type: 'text', text: `Goal: ${args.goal}` } })
        reply(result(id, { description: OPS_PLAYBOOK.description, messages }))
        return
      }
      default:
        reply(errorMessage(id, -32601, `method not found: ${method}`))
    }
  }

  function start() {
    if (!initialized) log(`serving on stdio, workspace ${registry.cwd}, ${registry.tools.length} tools`)
    startStdio({
      onMessage: handleMessage,
      onClose: () => {
        log('stdin closed, exiting')
        process.exit(0)
      },
      onError: (error) => log(`unhandled: ${error?.stack ?? error}`),
    })
  }

  return { registry, start, handleMessage }
}

export { SERVER_NAME, SERVER_VERSION }
