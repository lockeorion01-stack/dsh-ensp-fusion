/** Offline helpers only: no console, network, GUI, or synthesized topology XML. */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { dirname, extname, resolve, join } from 'node:path'
import { readTopo, parseTopo } from './topo.js'

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u
const CONTROLS = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/u
const own = (object, key) => Object.hasOwn(object, key)

function object(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  if (keys) for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${label}: unknown field ${key}`)
  }
}

function singleLine(value, label) {
  if (typeof value !== 'string' || !value.trim() || CONTROLS.test(value)) {
    throw new Error(`${label} must be a nonempty single-line string without control characters`)
  }
  return value
}

function placeholders(value, label) {
  singleLine(value, label)
  const rest = value.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/gu, '')
  if (rest.includes('{{') || rest.includes('}}')) throw new Error(`${label}: invalid placeholder; use {{identifier}}`)
}

function commandList(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a nonempty command array`)
  value.forEach((line, i) => placeholders(line, `${label}[${i}]`))
}

function substitute(value, vars, used, label) {
  placeholders(value, label)
  const result = value.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/gu, (_, key) => {
    if (!own(vars, key)) throw new Error(`${label}: missing variable ${key}`)
    used.add(key)
    return String(vars[key])
  })
  singleLine(result, label)
  if (result.includes('{{') || result.includes('}}')) throw new Error(`${label}: nested placeholders are not supported`)
  return result
}

// Deliberately limited to the existing reader's UTF-8, double-quoted dev schema.
// This is not a general XML parser; DTDs, CDATA, and alternate encodings are refused.
function attributes(tag) {
  const result = Object.create(null)
  for (const match of tag.matchAll(/\s([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"/gu)) {
    if (own(result, match[1])) throw new Error(`duplicate XML attribute ${match[1]}`)
    result[match[1]] = match[2]
  }
  return result
}

async function loadTopology(path, validatePorts = false) {
  if (extname(path).toLowerCase() !== '.topo') throw new Error('topology must be an existing .topo file')
  const loaded = await readTopo(path)
  const text = loaded.text.replace(/<!--[\s\S]*?-->/gu, '')
  if (text.includes('\0') || text.includes('\ufffd') || /<!DOCTYPE|<!\[CDATA\[/u.test(text)
      || !/^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<topo\b[^>]*>[\s\S]*<\/topo>\s*$/u.test(text)) {
    throw new Error('unsupported topology: expected UTF-8 <topo> XML without DTD or CDATA')
  }
  const parsed = text === loaded.text ? loaded : { text, ...parseTopo(text) }
  const tags = [...text.matchAll(/<dev\b[^>]*>/gu)]
  if (!parsed.devices.length || tags.length !== parsed.devices.length) throw new Error('topology has missing device IDs/names or unsupported device tags')
  const names = new Set()
  const ids = new Set()
  const ports = new Set()
  parsed.devices.forEach((device, i) => {
    singleLine(device.name, 'topology device name')
    const name = device.name.toLowerCase()
    if (names.has(name)) throw new Error(`duplicate topology device name: ${device.name}`)
    if (ids.has(device.id)) throw new Error(`duplicate topology device ID: ${device.id}`)
    names.add(name)
    ids.add(device.id)
    if (!validatePorts) return
    // readTopo intentionally coerces ports; check the source to reject 2001junk etc.
    const raw = attributes(tags[i][0]).com_port
    if (!/^\d+$/u.test(raw ?? '') || !Number.isInteger(Number(raw)) || Number(raw) > 9999
        || (Number(raw) === 0 && !/^(PC|Server|Client|MCS|STA)$/iu.test(device.model))) {
      throw new Error(`invalid com_port for ${device.name}: ${raw ?? '(missing)'}; require 1..9999 (terminal models may use 0)`)
    }
    if (Number(raw) > 0 && ports.has(Number(raw))) throw new Error(`duplicate com_port: ${raw}`)
    if (Number(raw) > 0) ports.add(Number(raw))
  })
  return { ...parsed, text }
}

/** Validate and fully resolve a JSON plan without creating output. */
export async function resolveLabPlan(planPath) {
  const input = resolve(planPath)
  const plan = JSON.parse((await readFile(input, 'utf8')).replace(/^\uFEFF/u, ''))
  object(plan, 'plan', ['topology', 'templates', 'devices'])
  singleLine(plan.topology, 'plan.topology')
  const topologyPath = resolve(dirname(input), plan.topology)
  const topology = await loadTopology(topologyPath, true)
  const templates = plan.templates ?? {}
  object(templates, 'templates')
  for (const [key, commands] of Object.entries(templates)) {
    if (!IDENTIFIER.test(key)) throw new Error(`invalid template name: ${key}`)
    commandList(commands, `template ${key}`)
  }
  if (!Array.isArray(plan.devices) || !plan.devices.length) throw new Error('devices must be a nonempty array')
  const selected = new Set()
  const devices = plan.devices.map((entry, index) => {
    const label = `devices[${index}]`
    object(entry, label, ['device', 'commands', 'template', 'vars', 'expect', 'system_view', 'save'])
    singleLine(entry.device, `${label}.device`)
    if (selected.has(entry.device)) throw new Error(`duplicate plan device: ${entry.device}`)
    selected.add(entry.device)
    const device = topology.devices.find((item) => item.name === entry.device)
    if (!device) throw new Error(`device not found in topology: ${entry.device}`)
    if (own(entry, 'template') === own(entry, 'commands')) throw new Error(`${label}: specify exactly one of template or commands`)
    if (own(entry, 'template') && (typeof entry.template !== 'string' || !own(templates, entry.template))) {
      throw new Error(`${label}: unknown template ${entry.template}`)
    }
    const commands = own(entry, 'template') ? templates[entry.template] : entry.commands
    commandList(commands, `${label}.commands`)
    const vars = entry.vars ?? {}
    object(vars, `${label}.vars`)
    for (const [key, value] of Object.entries(vars)) {
      if (!IDENTIFIER.test(key)) throw new Error(`${label}: invalid variable name ${key}`)
      if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new Error(`${label}: variable ${key} must be a string, finite number, or boolean`)
      }
      singleLine(String(value), `${label}.vars.${key}`)
      if (String(value).includes('{{') || String(value).includes('}}')) throw new Error(`${label}: variable ${key} contains nested placeholders`)
    }
    const used = new Set()
    const render = (value) => substitute(value, vars, used, label)
    const result = { device: device.name, port: device.comPort, commands: commands.map(render) }
    if (own(entry, 'expect')) {
      if (!Array.isArray(entry.expect) || entry.expect.length > commands.length) throw new Error(`${label}.expect must be an array no longer than commands`)
      result.expect = entry.expect.map((value) => {
        if (value === null) return null
        if (!Array.isArray(value)) return render(value)
        if (!value.length) throw new Error(`${label}.expect pattern arrays must not be empty`)
        return value.map(render)
      })
    }
    for (const key of ['system_view', 'save']) {
      if (!own(entry, key)) continue
      if (typeof entry[key] !== 'boolean') throw new Error(`${label}.${key} must be boolean`)
      result[key] = entry[key]
    }
    for (const key of Object.keys(vars)) if (!used.has(key)) throw new Error(`${label}: unknown/unused variable ${key}`)
    return result
  })
  return { topologyPath, plan: { topology: 'topology.topo', devices } }
}

/** A new directory is required, even if an existing directory is empty. */
export async function generateLab({ plan: planPath, out }) {
  const resolved = await resolveLabPlan(planPath)
  const bytes = await readFile(resolved.topologyPath)
  const directory = resolve(out)
  // Build everything before creating the output directory; names never enter paths.
  const files = [
    ['topology.topo', bytes],
    ['plan.json', `${JSON.stringify(resolved.plan, null, 2)}\n`],
    ...resolved.plan.devices.map((device, i) => [
      `${String(i + 1).padStart(3, '0')}-device.txt`, `${device.commands.join('\n')}\n`,
    ]),
  ]
  await mkdir(dirname(directory), { recursive: true })
  try { await mkdir(directory) } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`refusing to overwrite existing output directory: ${directory}`)
    throw error
  }
  try {
    for (const [name, content] of files) await writeFile(join(directory, name), content, { flag: 'wx' })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return { out: directory, files: files.map(([name]) => name), plan: resolved.plan }
}

function decodeXml(value) {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/giu, (entity, code) => {
    const known = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (own(known, code)) return known[code]
    const number = code.startsWith('#x') ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1))
    return Number.isInteger(number) && number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity
  })
}

// Mermaid uses #NN; entities, not XML's &#NN;. Encode punctuation before rendering.
function mermaidLabel(value) {
  return value.replace(/[^\p{L}\p{N} _./]/gu, (char) => `#${char.codePointAt(0)};`)
}

/**
 * Known link schema verified against ENSP-MCP tools/topology.py _extract_link_infos:
 * lines/line@srcDeviceID,destDeviceID and interfacePair@srcIndex,tarIndex|destIndex.
 * Numeric endpoint ports are topology indices, never inferred CLI interface names.
 * Alternate link schemas are deliberately omitted with warnings.
 */
export async function topologyDiagram(topologyPath) {
  const topology = await loadTopology(resolve(topologyPath))
  const warnings = []
  const ids = new Map(topology.devices.map((device, index) => [device.id, `d${index + 1}`]))
  const lines = ['flowchart LR', ...topology.devices.map((device) => `  ${ids.get(device.id)}["${mermaidLabel(device.name)}"]`)]
  const total = [...topology.text.matchAll(/<line\b/gu)].length
  let seen = 0
  for (const container of topology.text.matchAll(/<lines\b[^>]*>([\s\S]*?)<\/lines\s*>/gu)) {
    for (const match of container[1].matchAll(/<line\b([^>]*?)(?:\/>|>([\s\S]*?)<\/line\s*>)/gu)) {
      seen += 1
      const attrs = attributes(` ${match[1]}`)
      const source = ids.get(attrs.srcDeviceID)
      const target = ids.get(attrs.destDeviceID)
      const pairs = [...(match[2] ?? '').matchAll(/<interfacePair\b[^>]*>/gu)]
      if (!source || !target || !pairs.length) {
        warnings.push(`line ${seen}: unrecognized link schema or unknown device ID; omitted`)
        continue
      }
      for (const pair of pairs) {
        const ports = attributes(pair[0])
        const src = ports.srcIndex
        const dst = ports.tarIndex ?? ports.destIndex
        if (!src?.trim() || !dst?.trim() || CONTROLS.test(decodeXml(src) + decodeXml(dst))) {
          warnings.push(`line ${seen}: unrecognized endpoint ports; link omitted`)
          continue
        }
        lines.push(`  ${source} ---|"${mermaidLabel(decodeXml(src))} ↔ ${mermaidLabel(decodeXml(dst))}"| ${target}`)
      }
    }
  }
  if (total !== seen || /<(?:link|connection)\b/u.test(topology.text)) warnings.push('unrecognized links outside the supported lines/line schema; omitted')
  return { mermaid: `${lines.join('\n')}\n`, warnings }
}

export async function writeTopologyDiagram({ topology, out }) {
  const result = await topologyDiagram(topology)
  const path = resolve(out)
  await mkdir(dirname(path), { recursive: true })
  try { await writeFile(path, result.mermaid, { flag: 'wx' }) } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`refusing to overwrite existing output file: ${path}`)
    throw error
  }
  return { out: path, ...result }
}
