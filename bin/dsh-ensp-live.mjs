#!/usr/bin/env node
// Opt-in live verification. Never included in npm test. Uses an already-open,
// isolated topology; does not configure devices or accept unknown dialogs.
import { mkdir, writeFile, realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute, dirname } from 'node:path'
import { createRegistry } from '../mcp/server.js'
import { preflightFailure } from '../lib/live-preflight.js'

const args = process.argv.slice(2)
if (args.includes('--help') || args.length === 0) {
  console.log('Usage: node bin/dsh-ensp-live.mjs --workspace DIR --topology FILE --out FILE [--plan FILE]\nOpen the isolated topology first. This starts devices, verifies prompt/VRP, optionally runs a read-only acceptance plan, then stops devices. Windows must be unlocked. No configuration changes or automatic password changes.')
  process.exit(0)
}
const opts = {}
for (let i = 0; i < args.length; i += 2) {
  const key = args[i]
  if (!['--workspace', '--topology', '--out', '--plan'].includes(key) || !args[i+1] || opts[key]) throw new Error('Invalid/duplicate arguments; see --help')
  opts[key] = args[i+1]
}
if (!opts['--workspace'] || !opts['--topology'] || !opts['--out']) throw new Error('workspace, topology and out are required')
const workspace = await realpath(resolve(opts['--workspace']))
const output = resolve(workspace, opts['--out'])
const check = relative(workspace, output)
if (!check || check.startsWith('..') || isAbsolute(check)) throw new Error('out must be inside workspace')
await mkdir(dirname(output), { recursive: true })
const actualParent = await realpath(dirname(output))
const parentCheck = relative(workspace, actualParent)
if (parentCheck.startsWith('..') || isAbsolute(parentCheck)) throw new Error('output parent escapes workspace')
// Reserve evidence before doing any GUI action; never overwrite an old run.
await writeFile(output, '{}\n', { flag: 'wx' })
const registry = createRegistry({ workspace, overrides: { mode: 'job', timeoutMs: 180000 } })
const report = { timestamp: new Date().toISOString(), topology: opts['--topology'], stages: [], ok: false }
async function call(name, input) {
  try { return await registry.tools.find(tool => tool.name === name).handler(input, registry.exec) }
  catch (error) { return { ok: false, error: error.message } }
}
const gui = steps => call('ensp_gui', { topology_path: opts['--topology'], allow_cursor_takeover: true, steps })
let attempted = false
try {
  const preflight = await gui([{ op: 'ping' }, { op: 'ensp' }])
  report.stages.push({ name: 'preflight', result: preflight })
  const failure = preflightFailure(preflight)
  if (failure) { report.errorCode = failure.code; throw new Error(failure.message) }
  attempted = true
  const start = await gui([{ op: 'start_all' }])
  report.stages.push({ name: 'start_and_vrp_ready', result: start })
  if (!start.ok) throw new Error('Start/readiness failed; inspect stages')
  const topologyShot = `${opts['--out']}.topology.png`
  const capture = await gui([{ op: 'normalize_canvas' , ensp: true }, { op: 'shot', ensp: true, out: topologyShot }])
  report.stages.push({ name: 'canvas', result: capture })
  if (!capture.ok) throw new Error('Canvas verification failed')
  if (opts['--plan']) {
    const acceptance = await call('ensp_labtest', { plan_path: opts['--plan'], report_prefix: `${opts['--out']}.acceptance` })
    report.stages.push({ name: 'acceptance', result: acceptance })
    if (!acceptance.ok) throw new Error('Acceptance failed')
  }
  report.ok = true
} catch (error) { report.error = error.message }
finally {
  if (attempted) {
    const stop = await gui([{ op: 'stop_all' }])
    report.stages.push({ name: 'stop', result: stop })
    report.ok &&= stop.ok
  }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ ok: report.ok, output, error: report.error }))
process.exitCode = report.ok ? 0 : 1
