import { generateTopology } from './topology-builder.js'
export { generateTopology } from './topology-builder.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { realpath, writeFile, readFile, open, unlink } from 'node:fs/promises'
import { resolve, relative, isAbsolute, dirname, extname } from 'node:path'
import { MODEL_SPECS } from '../upstream/lizi600jin/src/core/build.mjs'
import { serialiseTopology, summarise } from '../upstream/lizi600jin/src/core/topology.mjs'
import { SCENARIOS, searchScenarios } from '../upstream/lizi600jin/src/core/presets.mjs'
import { VrpSession } from './cli.js'
import { compareLldp, diagnoseOutput, parseLldp } from './network-analysis.js'
import { createRedactor, credentialValues, redactValue } from './redaction.js'
import { readTopo, writeTopo } from './topo.js'
import { topologyLldpLinks } from './topology-links.js'
import { runServiceTest, validateServicePlan, renderServiceReports } from './service-test.js'
import { identifyCompatibility } from './compatibility.js'
import { hydrateInputs } from './credential-input.js'
import { describeScenario, prepareScenario, scenarioSupport } from './scenario-lab.js'

const string = (description = '') => ({ type: 'string', description })
const output = {
  schema: { type: 'object', properties: { ok: { type: 'boolean' }, data: { type: 'string' }, error: { type: 'string' } }, required: ['ok', 'data', 'error'], additionalProperties: false },
  render: (_, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}
function fusionTool(name, description, parameters, handler, config) {
  if (parameters.password) {
    parameters.credential_file = string('Workspace-local JSON keyed by credential_ref; avoids inline passwords in host call logs.')
    parameters.credential_ref = string('Entry name in credential_file; cannot combine with inline credentials.')
  }
  // DSH's authoring DSL uses required:true on properties, then compiles to JSON Schema.
  function authorSchema(node) {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(authorSchema)
    const result = Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'required' || !Array.isArray(node.required)).map(([key, value]) => [key, authorSchema(value)]))
    for (const key of Array.isArray(node.required) ? node.required : []) result.properties[key].required = true
    return result
  }
  return defineTool({ name, description, parameters: authorSchema(parameters), output: { ...output, schema: authorSchema(output.schema) }, async execute(args, exec) {
    try {
      args = await hydrateInputs(args, (path) => inputPath(path, exec, config?.restrictToWorkspace !== false))
      const value = redactValue(await handler(args, exec), createRedactor(credentialValues(args)))
      const ok = value?.ok !== false
      return { ok, data: JSON.stringify(value), error: ok ? '' : (value.error ?? value.lastError ?? 'Operation incomplete; inspect data for partial results') || 'Operation incomplete; inspect data for partial results' }
    }
    catch (error) { return { ok: false, data: '', error: createRedactor(credentialValues(args))(error.message) } }
  } })
}
function integer(value, low, high, label) {
  if (!Number.isInteger(value) || value < low || value > high) throw new Error(`${label} must be ${low}..${high}`)
  return value
}
const inside = (root, path) => { const r = relative(root, path); return !isAbsolute(r) && r !== '..' && !r.startsWith('..\\') && !r.startsWith('../') }

export async function inputPath(file, exec, restrict = true) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('input path must be a nonempty string')
  const root = await realpath(resolve(exec?.agent?.session?.header?.cwd ?? process.cwd()))
  const path = await realpath(resolve(root, file))
  if (restrict && !inside(root, path)) throw new Error('input path escapes workspace')
  return path
}

export async function outputPath(file, exec, restrict = true) {
  if (typeof file !== 'string' || extname(file).toLowerCase() !== '.topo') throw new Error('output_path must end in .topo')
  const root = await realpath(resolve(exec?.agent?.session?.header?.cwd ?? process.cwd()))
  const path = resolve(root, file)
  if (restrict && !inside(root, path)) throw new Error('output_path escapes workspace')
  const parent = await realpath(dirname(path))
  if (restrict && !inside(root, parent)) throw new Error('output_path parent escapes workspace through symlink')
  return resolve(parent, path.slice(dirname(path).length + 1))
}

// Poll through ENSPLB's hardened transport instead of importing a second Telnet stack.
export async function waitForConvergence(args, { query, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  integer(args.port, 1, 65535, 'port')
  const timeout = integer(args.timeout_ms ?? 120000, 1, 600000, 'timeout_ms')
  const interval = integer(args.interval_ms ?? 1000, 1, 30000, 'interval_ms')
  if (!['output', 'ospf_full', 'ospf_route'].includes(args.kind)) throw new Error('kind must be output, ospf_full or ospf_route')
  const command = args.kind === 'ospf_full' ? 'display ospf peer brief' : args.kind === 'ospf_route' ? 'display ip routing-table protocol ospf' : args.command
  if (typeof command !== 'string' || !/^display +\S/iu.test(command)
      || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(command)
      || /[;|&<>`]/u.test(command) || /\$\(/u.test(command)
      || /^display +diagnostic-information(?: +|$)/iu.test(command)) {
    throw new Error('only single-line read-only display commands are accepted')
  }
  const needle = args.kind === 'ospf_full' ? (args.neighbour_id ?? '') : args.expect
  if (typeof needle !== 'string' || (args.kind !== 'ospf_full' && !needle.trim())) throw new Error('expect is required')
  const started = now(); let attempts = 0, output = '', lastError = ''
  const probe = query ?? (async (remaining) => {
    const session = new VrpSession({ port: args.port, username: args.username, password: args.password,
      connectTimeoutMs: remaining, commandTimeoutMs: remaining })
    const timer = setTimeout(() => session.close(), remaining)
    try { await session.open(); return await session.command(command, { timeoutMs: Math.max(1, remaining - (now() - probeStart)) }) }
    finally { clearTimeout(timer); session.close() }
  })
  let probeStart
  while (now() - started < timeout) {
    attempts++; probeStart = now()
    let r
    try { r = await probe(Math.max(1, timeout - (now() - started)), command) }
    catch (error) { r = { ok: false, error: error.message, kind: error.kind } }
    if (!r.ok && r.kind === 'authentication') {
      return { ok: false, converged: false, attempts, output, waitedMs: now() - started, lastError: r.error }
    }
    if (r.ok) { output = r.output ?? ''; lastError = '' } else lastError = r.error ?? 'query failed'
    const matched = args.kind === 'ospf_full'
      ? output.split('\n').some(line => /\bFull\b/i.test(line) && (!needle || line.split(/\s+/).includes(needle)))
      : output.includes(needle)
    if (r.ok && matched && now() - started <= timeout) return { ok: true, converged: true, attempts, output, waitedMs: now() - started, lastError }
    const remaining = timeout - (now() - started)
    if (remaining > 0) await sleep(Math.min(interval, remaining))
  }
  return { ok: false, converged: false, attempts, output, waitedMs: now() - started, lastError }
}

export function createFusionTools(config) {
  const tool = (...args) => fusionTool(...args, config)
  return [
    tool('ensp_services', 'Read-only host-origin HTTP/DNS/anonymous FTP/TCP acceptance with repeated stability samples and recovery evidence. Never configures devices or claims probes originate in an eNSP PC.', {
      plan_path: { ...string('Workspace JSON service plan, with explicit vantage:host'), required: true },
      report_prefix: { ...string('New report prefix within workspace; existing parent required; never overwrite JSON/Markdown/CSV'), required: true },
    }, async (args, exec) => {
      const path = await inputPath(args.plan_path, exec, config.restrictToWorkspace !== false)
      const plan = validateServicePlan(JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, '')))
      const root = await realpath(resolve(exec?.agent?.session?.header?.cwd ?? process.cwd()))
      if (typeof args.report_prefix !== 'string' || !args.report_prefix.trim()) throw new Error('report_prefix must be nonempty')
      const prefix = resolve(root, args.report_prefix)
      const parent = await realpath(dirname(prefix))
      if (config.restrictToWorkspace !== false && (!inside(root, prefix) || !inside(root, parent))) throw new Error('report_prefix escapes workspace')
      const files = []
      try {
        for (const format of ['json', 'md', 'csv']) {
          const file = `${prefix}.${format}`, handle = await open(file, 'wx', 0o600)
          files.push({ file, format, handle })
        }
      } catch (error) {
        for (const item of files) { await item.handle.close(); await unlink(item.file) }
        throw error
      }
      try {
        await files[0].handle.writeFile(JSON.stringify({ status: 'running', vantage: 'host', started_at: new Date().toISOString() }))
        await files[0].handle.sync()
        const result = await runServiceTest(plan)
        const reports = renderServiceReports(result)
        for (const item of files) {
          await item.handle.truncate(0)
          await item.handle.write(reports[item.format], 0, 'utf8')
          await item.handle.sync()
        }
        return { ...result, reports: Object.fromEntries(files.map(item => [item.format, item.file])) }
      } finally { for (const item of files) await item.handle.close() }
    }),
    tool('ensp_lldp', 'Offline comparison of expected links with raw LLDP brief/detail observations. Does not enable LLDP or contact devices; missing evidence is inconclusive.', {
      links: { type: 'array', items: { type: 'object', properties: { a: string(), a_port: string(), b: string(), b_port: string() }, required: ['a','a_port','b','b_port'], additionalProperties: false } },
      topo_path: string('Read expected LLDP links from a workspace .topo instead of links; excludes PC/Server/Cloud links'),
      observations: { type: 'array', required: true, items: { type: 'object', properties: { device: string(), output: string(), collected_at: string('ISO timestamp with timezone; required for freshness verification') }, required: ['device','output'], additionalProperties: false } },
      max_age_ms: { type: 'integer', description: 'Maximum observation age, default 300000; missing/expired/future timestamps are inconclusive' },
      require_bidirectional: { type: 'boolean', description: 'Require both endpoints to report each link; default true' },
      name_map: { type: 'array', items: { type: 'object', properties: { topology_name: string(), sysname: string() }, required: ['topology_name','sysname'], additionalProperties: false } },
    }, async (args, exec) => {
      if ((args.links !== undefined) === (args.topo_path !== undefined)) throw new Error('provide exactly one of links or topo_path')
      let topology = { links: args.links, excluded: [], unresolved: [] }
      if (args.topo_path !== undefined) {
        const file = await inputPath(args.topo_path, exec, config.restrictToWorkspace !== false)
        if (extname(file).toLowerCase() !== '.topo') throw new Error('topo_path must end in .topo')
        topology = topologyLldpLinks((await readTopo(file)).text)
      }
      const mapping = new Map(), targets = new Set()
      for (const item of args.name_map ?? []) {
        if (!item.topology_name?.trim() || !item.sysname?.trim() || mapping.has(item.topology_name) || targets.has(item.sysname)) throw new Error('name_map must contain unique nonempty topology names and sysnames')
        mapping.set(item.topology_name, item.sysname); targets.add(item.sysname)
      }
      const links = topology.links.map(link => ({ ...link, a: mapping.get(link.a) ?? link.a, b: mapping.get(link.b) ?? link.b }))
      const result = compareLldp(links, args.observations, { maxAgeMs: args.max_age_ms ?? 300000, requireBidirectional: args.require_bidirectional ?? true })
      if (topology.unresolved.length && result.status === 'MATCH') result.status = 'INCONCLUSIVE'
      return { ...result, excluded: topology.excluded, unresolved: topology.unresolved }
    }),
    tool('ensp_diagnose', 'Offline VRP error and ping-loss diagnosis with read-only probe suggestions. Unknown output never means healthy; no automatic fixes.', {
      output: { ...string('Raw command error/output; omit credentials'), required: true },
    }, async ({ output }) => diagnoseOutput(output)),
    tool('ensp_inspect', 'Read-only preconfiguration inventory: version, running configuration, interfaces, routes and LLDP. Returns per-command evidence, not a business health assertion. Running configuration may contain sensitive data.', {
      port: { type: 'integer', required: true }, username: string(), password: string(), timeout_ms: { type: 'integer' },
    }, async (args) => {
      integer(args.port, 1, 65535, 'port')
      const timeout = integer(args.timeout_ms ?? 30000, 1, 120000, 'timeout_ms')
      const session = new VrpSession({ port: args.port, username: args.username, password: args.password, connectTimeoutMs: timeout, commandTimeoutMs: timeout })
      const commands = ['display version', 'display current-configuration', 'display ip interface brief', 'display ip routing-table', 'display lldp neighbor brief']
      const results = []
      const started = Date.now()
      const timer = setTimeout(() => session.close(), timeout)
      try {
        await session.open()
        for (const command of commands) {
          const remaining = timeout - (Date.now() - started)
          if (remaining <= 0) break
          const result = await session.command(command, { timeoutMs: remaining })
          results.push({ command, ...result, collected_at: new Date().toISOString() })
          if (result.ok === false) break
          if (command === 'display lldp neighbor brief' && parseLldp('device', result.output ?? '').status === 'UNKNOWN'
            && /Interface\s+\S+\s+has\s+\d+\s+Neighbors:/iu.test(result.output ?? '')) {
            commands.push('display lldp neighbor')
          }
        }
        return { ok: results.length === commands.length && results.every(r => r.ok), results, skipped: commands.slice(results.length), compatibility: identifyCompatibility(results.find(row => row.command === 'display version' && row.ok)?.output ?? ''), notes: ['Read-only evidence collection; no save, LLDP enablement or automatic repair.'] }
      } catch (error) {
        return { ok: false, results, skipped: commands.slice(results.length), error: error.message }
      } finally { clearTimeout(timer); session.close() }
    }),
    tool('ensp_scenarios', 'Search 50 scenario briefs, or get an exact ID with topology blueprint, addressing and generation support. Guidance is not a complete deployable configuration.', {
      query: string('Search keyword'), id: string('Exact scenario ID for full brief'),
    }, async ({ query = '', id }) => {
      if (id !== undefined) return describeScenario(id)
      if (typeof query !== 'string') throw new Error('query must be a string')
      return { scenarios: searchScenarios(query).map(item => ({ ...item, generation: scenarioSupport(item.id) })), total: Object.keys(SCENARIOS).length }
    }),
    tool('ensp_build', 'Generate a new eNSP .topo from devices/links OR scenario_id. Scenario mode also returns an addressing-only dry-run CLI plan. No device operations; never overwrites.', {
      output_path: { ...string('New .topo path; parent must exist within workspace'), required: true },
      scenario_id: string('Exact ID from ensp_scenarios; mutually exclusive with devices and links; unsupported models are refused'),
      devices: { type: 'array', items: { type: 'object', properties: { name: string('Device name'), model: { type: 'string', enum: Object.keys(MODEL_SPECS) }, options: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, comPort: { type: 'integer' }, pc: { type: 'object', properties: { ip: string(), mask: string(), gateway: string(), dns: string(), dhcp: { type: 'boolean', description: 'PC only; cannot combine true with static IPv4 settings' } }, additionalProperties: false } }, additionalProperties: false } }, required: ['name','model'], additionalProperties: false } },
      links: { type: 'array', items: { type: 'object', properties: { a: string(), a_port: string(), b: string(), b_port: string() }, required: ['a','a_port','b','b_port'], additionalProperties: false } },
      first_com_port: { type: 'integer' }, auto_layout: { type: 'boolean' },
    }, async (args, exec) => {
      if (args.scenario_id !== undefined && (args.devices !== undefined || args.links !== undefined)) throw new Error('scenario_id cannot be combined with devices or links')
      const prepared = args.scenario_id === undefined ? null : prepareScenario(args.scenario_id, args)
      const topology = prepared?.topology ?? generateTopology(args)
      const file = await outputPath(args.output_path, exec, config.restrictToWorkspace !== false)
      const text = serialiseTopology(topology)
      await writeTopo(file, text, { encoding: /[^\x00-\x7f]/u.test(text) ? 'gb18030' : 'utf-8', flag: 'wx' })
      const result = { path: file, summary: summarise(topology) }
      if (prepared) {
        result.scenario = { id: prepared.id, scope: prepared.configuration.scope, addressing: prepared.addressing, notes: prepared.notes }
        result.cli_plan = prepared.configuration.devices.length ? { topology_path: file, dry_run: true, devices: prepared.configuration.devices } : null
      }
      return result
    }),
    tool('ensp_wait', 'Poll read-only display output or OSPF Full/route convergence using ENSPLB transport; returns timeout as a failed tool result.', {
      port: { type: 'integer', required: true }, kind: { type: 'string', enum: ['output','ospf_full','ospf_route'], required: true },
      command: string('display command for output mode'), expect: string('Literal substring for output or route mode'), neighbour_id: string('Optional exact OSPF peer ID'),
      username: string('Optional console username'), password: string('Optional console password, redacted by transport'),
      timeout_ms: { type: 'integer' }, interval_ms: { type: 'integer' },
    }, async (args) => {
      const result = await waitForConvergence(args)
      if (!result.ok) result.error = result.lastError || 'convergence timeout'
      return result
    }),
  ]
}
