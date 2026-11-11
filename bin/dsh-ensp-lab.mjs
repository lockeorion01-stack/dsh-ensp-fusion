#!/usr/bin/env node
import { generateLab, writeTopologyDiagram } from '../lib/lab-plan.js'
import { resolve } from 'node:path'

const HELP = `eNSP lab helpers (generate/diagram: offline, no extra runtime dependencies)

Usage:
  node bin/dsh-ensp-lab.mjs generate --plan <json> --out <new-directory>
  node bin/dsh-ensp-lab.mjs diagram --topology <existing.topo> --out <new.mmd>
  node bin/dsh-ensp-lab.mjs test --plan <acceptance.json> --out <report-prefix> [--workspace <dir>]
  node bin/dsh-ensp-lab.mjs --help

Generate JSON contract:
  { "topology": "../test/fixtures/minimal.topo",
    "templates": { "hostname": ["sysname {{name}}"] },
    "devices": [{ "device": "SW1", "template": "hostname",
                  "vars": { "name": "SW1" }, "system_view": true, "save": true }] }
  topology is resolved relative to the plan file. Device names match exactly.
  Each device requires either commands: ["..."] or template: "name".
  Templates are named command arrays. vars are per device; values must be
  strings, finite numbers, or booleans. Only {{identifier}} is supported.
  Missing, unused, malformed, and nested variables are errors. No YAML/Jinja.
  Commands and variable values must be nonempty single lines, without controls.
  Optional expect is command-aligned: string, array of strings, or null per
  command; it also supports variables. system_view and save are booleans.
  Unknown fields are errors. Ports come exclusively from the base topology:
  unique integers 1..65535, with 0 allowed for PCs (multiple PC zeros allowed).

Outputs and limits:
  generate validates before writing; refuses any existing output directory.
  It copies topology bytes unchanged to topology.topo, writes plan.json with
  devices {device,port,commands,expect?,system_view?,save?}, and command-only
  001-device.txt, 002-device.txt, ... in plan order (safe numeric filenames).
  system_view/save/expect are metadata; no commands are inserted or executed.
  PC port 0 is offline metadata, not a usable console endpoint.
  The resolved plan is for downstream consumption, not a generator input.
  Only the .topo file is copied; external VM disks/config assets are not bundled.
  The existing reader supports UTF-8 XML with double-quoted <dev> attributes;
  this helper rejects DTDs/CDATA/alternate encodings, not a full XML validator.
  diagram recognizes lines/line with srcDeviceID/destDeviceID and child
  interfacePair with srcIndex and tarIndex (or destIndex). Labels use source
  port indices, not guessed CLI names. Unknown links warn on stderr and are
  omitted; a topology without links yields devices only. Existing files refuse
  overwrite. Mermaid source only; no renderer, device, network, or GUI access.

Explicit test invocation (online, separate acceptance plan):
  test dynamically loads the MCP registry and calls ensp_labtest. This is the
  only subcommand that may connect to devices and execute read-only checks.
  It requires the registry's runtime dependencies and an available lab.
  Acceptance plans use optional topology_path (relative to the plan file) and
  devices with commands objects {cmd,expect,layer}; see ensp_labtest's schema.
  Generated configuration plans are NOT acceptance plans and must not be used
  as test input. No acceptance plan is inferred from configuration commands.
  --plan and --out are resolved from cwd; --workspace defaults to cwd and is
  the registry's workspace boundary. Reports use the requested prefix for
  JSON, Markdown, and CSV. allow_overwrite is false; choose a fresh prefix.
  Exit codes: 0 = success, 1 = report ok:false, 2 = validation/runtime exception.
  generate/diagram also use exit 2 for validation or filesystem exceptions.

Example (from repository root):
  node bin/dsh-ensp-lab.mjs generate --plan examples/lab-plan.json --out ./lab-output
  node bin/dsh-ensp-lab.mjs diagram --topology test/fixtures/minimal.topo --out ./lab.mmd
`

function argumentsOf(args) {
  const [command, ...rest] = args
  if (!['generate', 'diagram', 'test'].includes(command)) throw new Error(`unknown subcommand: ${command ?? '(missing)'}`)
  const input = command === 'diagram' ? 'topology' : 'plan'
  const allowed = command === 'test' ? [input, 'out', 'workspace'] : [input, 'out']
  const options = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].slice(2)
    if (!rest[i].startsWith('--') || !allowed.includes(key)) throw new Error(`unknown option: ${rest[i]}`)
    if (Object.hasOwn(options, key)) throw new Error(`duplicate option: --${key}`)
    if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`missing value for --${key}`)
    options[key] = rest[i + 1]
  }
  if (!options[input] || !options.out) throw new Error(`${command} requires --${input} and --out`)
  return { command, options }
}

const args = process.argv.slice(2)
if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))
    || (args.length === 2 && ['generate', 'diagram', 'test'].includes(args[0]) && ['--help', '-h'].includes(args[1]))) {
  console.log(HELP)
} else {
  try {
    const { command, options } = argumentsOf(args)
    if (command === 'test') {
      // Keep the registry (and any online capabilities) out of offline execution.
      const { createRegistry } = await import('../mcp/server.js')
      const registry = createRegistry({ workspace: resolve(options.workspace ?? process.cwd()) })
      const tool = registry.tools.find((item) => item.name === 'ensp_labtest')
      if (!tool) throw new Error('ensp_labtest is not registered in this installation')
      const report = await tool.handler({
        plan_path: resolve(options.plan),
        report_prefix: resolve(options.out),
        allow_overwrite: false,
      }, registry.exec)
      if (typeof report?.ok !== 'boolean') throw new Error('ensp_labtest returned a report without a boolean ok')
      console.log(JSON.stringify(report, null, 2))
      process.exitCode = report.ok ? 0 : 1
    } else {
      const result = await (command === 'generate' ? generateLab(options) : writeTopologyDiagram(options))
      for (const warning of result.warnings ?? []) console.error(`Warning: ${warning}`)
      console.log(`${command === 'generate' ? 'Generated lab' : 'Wrote diagram'}: ${result.out}`)
    }
  } catch (error) {
    console.error(`Error: ${error.message}\nRun node bin/dsh-ensp-lab.mjs --help for usage.`)
    process.exitCode = 2
  }
}
