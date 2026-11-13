import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { inputPath } from './fusion-tools.js'
import { inspectProject, checkpointProject, compareProject } from './project-checkpoint.js'
import { readTopo } from './topo.js'
import { VrpSession } from './cli.js'
import { hydrateInputs } from './credential-input.js'
import { diagnoseNativeLogs, nativeLogSources } from './console-diagnostics.js'
import { exportSanitizedLog } from './log-export.js'
import { createRedactor, credentialValues, redactValue } from './redaction.js'

const string = description => ({ type: 'string', description })
const inside = (root, path) => { const r = relative(root, path); return !isAbsolute(r) && r !== '..' && !r.startsWith('..\\') && !r.startsWith('../') }
async function destinationPath(file, exec, restrict) {
  if (typeof file !== 'string' || !file.trim()) throw Error('destination must be a nonempty path')
  const root = await realpath(resolve(exec?.agent?.session?.header?.cwd ?? process.cwd()))
  const path = resolve(root, file), parent = await realpath(dirname(path))
  if (restrict && (!inside(root, path) || !inside(root, parent))) throw Error('destination escapes workspace')
  return join(parent, basename(path))
}
function tool(name, description, parameters, handler) {
  return defineTool({ name, description, parameters,
    output: { schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
      render: (_, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      try { return redactValue(await handler(args, exec), createRedactor(credentialValues(args))) }
      catch (error) { return { ok: false, error: createRedactor(credentialValues(args))(error.message) } }
    },
  })
}

export function createReliabilityTools(config) {
  const restrict = config.restrictToWorkspace !== false
  const input = (path, exec) => inputPath(path, exec, restrict)
  return [
    tool('ensp_project', 'Inspect actual persisted VRP configuration content, create a new bounded checkpoint, or compare disk evidence. Never equates disk hashes with successful GUI load or cold boot. No GUI or device mutations.', {
      action: { type: 'string', enum: ['inspect', 'checkpoint', 'compare'], required: true },
      topology_path: { ...string('Existing .topo in workspace; does not identify the currently open GUI project.'), required: true },
      expected: { type: 'object', additionalProperties: true, description: 'Device name -> nonempty string array of required current configuration substrings. Keep secrets in a local file instead of inline arguments.' },
      expected_file: string('JSON map of expected substrings; mutually exclusive with expected.'),
      backup_dir: string('checkpoint: new directory outside the source project, within workspace; existing parent required. Copies topology/configuration assets, not VM disks.'),
      manifest_path: string('compare: prior checkpoint.json; compares disk content only; reloadVerified remains false.'),
    }, async (args, exec) => {
      if (!['inspect', 'checkpoint', 'compare'].includes(args.action)) throw Error('invalid project action')
      const path = await input(args.topology_path, exec)
      if (!/\.topo$/iu.test(path)) throw Error('topology_path must end in .topo')
      if (args.expected !== undefined && args.expected_file !== undefined) throw Error('expected and expected_file are mutually exclusive')
      const expected = args.expected_file ? JSON.parse(await readFile(await input(args.expected_file, exec), 'utf8')) : args.expected ?? {}
      if (args.action === 'checkpoint') return checkpointProject(path, await destinationPath(args.backup_dir, exec, restrict), { expected })
      const current = await inspectProject(path, { expected })
      if (args.action !== 'compare') return current
      const before = JSON.parse(await readFile(await input(args.manifest_path, exec), 'utf8'))
      if (!Array.isArray(before.devices) || typeof before.topologySha256 !== 'string' || before.stable !== true) throw Error('manifest must be a stable project checkpoint')
      return { ...compareProject(before, current), current }
    }),
    tool('ensp_console_diagnose', 'Read-only single-attempt console readiness and correlated native eNSP/USG serial/sync log diagnosis. # is not VRP; never restarts, guesses credentials, or changes a VM. Historical log findings are not a current root-cause verdict.', {
      topology_path: { ...string('Existing topology used only to map names, ports and UUIDs.'), required: true },
      device: { ...string('Exact device name to probe once with display version.'), required: true },
      native_log_root: string('eNSP native log root (contains Log and VBoxServer); defaults to LOCALAPPDATA/eNSP. Read-only diagnostic access; may be outside workspace.'),
      probe: { type: 'boolean', description: 'Default false: logs only. true contacts this one topology console port once.' },
      timeout_ms: { type: 'integer', description: 'Probe budget 100..15000 milliseconds; default 3000.' },
      credential_file: string('Workspace-local JSON keyed by credential_ref.'), credential_ref: string('Known credential reference; never inline passwords.'),
    }, async (original, exec) => {
      const args = await hydrateInputs(original, path => input(path, exec))
      const redact = createRedactor(credentialValues(args))
      const topology = await readTopo(await input(args.topology_path, exec))
      const matches = topology.devices.filter(d => d.name === args.device && d.comPort > 0)
      if (matches.length !== 1 || topology.devices.filter(d => d.comPort === matches[0]?.comPort).length !== 1) throw Error('device must resolve to one unique CLI port')
      const device = matches[0], timeout = args.timeout_ms ?? 3000
      if (!Number.isInteger(timeout) || timeout < 100 || timeout > 15000) throw Error('timeout_ms must be 100..15000')
      if (args.probe !== undefined && typeof args.probe !== 'boolean') throw Error('probe must be boolean')
      const root = args.native_log_root ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'eNSP') : undefined)
      if (!root) throw Error('provide native_log_root')
      const sources = await nativeLogSources(await realpath(root), [device])
      let consoleError, readiness = { state: 'not_probed' }
      if (args.probe === true) {
        const session = new VrpSession({ port: device.comPort, username: args.username, password: args.password, connectTimeoutMs: timeout, commandTimeoutMs: timeout })
        const timer = setTimeout(() => session.close(), timeout)
        try {
          await session.open()
          const r = await session.command('display version', { timeoutMs: timeout })
          if (!r.ok || !/Versatile Routing Platform|\bVRP\b/iu.test(r.output)) throw Object.assign(Error('display version did not confirm VRP'), { kind: 'not_vrp', output: r.output })
          readiness = { state: 'ready', prompt: r.prompt, evidence: 'prompt and display version confirmed VRP' }
        } catch (error) { consoleError = error; readiness = { state: 'failed', kind: error.kind ?? 'transport' } }
        finally { clearTimeout(timer); session.close() }
      }
      const diagnosis = diagnoseNativeLogs({ consoleError, sources })
      return redactValue({ ...diagnosis, ...(sources.length ? {} : { ok: false, status: 'INSUFFICIENT_LOG_EVIDENCE' }), device: device.name, port: device.comPort, readiness,
        sources: sources.map(({ path, device, bytes, truncated, mtime }) => ({ path, device, bytes, truncated, mtime })),
        coverage: sources.length ? 'sampled logs; timestamps may be historical' : 'no readable log sources; health unknown' }, redact)
    }),
    tool('ensp_logexport', 'Export a new sanitized JSONL copy of a host session (plain or concatenated Zstandard frames). Scrubs nested JSON arguments, credential keys, explicit replies and echoes; leaves original logs unchanged. Never copies malformed raw input.', {
      source: { ...string('Local JSONL or .zst session. Read-only source access outside workspace is allowed.'), required: true },
      destination: { ...string('New sanitized file within workspace; existing parent required; never overwrite.'), required: true },
    }, async (args, exec) => exportSanitizedLog(await inputPath(args.source, exec, false), await destinationPath(args.destination, exec, restrict))),
  ]
}
