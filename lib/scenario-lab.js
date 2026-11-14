// Fusion adapter for lizi600jin/dsh-ensp scenario blueprints (GPL-3.0-or-later).
// Added 2026-11-14. Offline only: never opens eNSP or connects to a console.
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { isIP } from 'node:net'
import { LABS } from '../upstream/lizi600jin/src/core/labs.mjs'
import { SCENARIOS, renderScenario } from '../upstream/lizi600jin/src/core/presets.mjs'
import { MODEL_SPECS, vrpToFlatIndex } from '../upstream/lizi600jin/src/core/build.mjs'
import { serialiseTopology, summarise } from '../upstream/lizi600jin/src/core/topology.mjs'
import { generateTopology } from './topology-builder.js'

const NOTES = [
  'Offline topology and addressing scaffold only; no commands have been executed or saved.',
  'Routing protocols, VLAN membership/trunks, tunnel parameters and security policies must be completed for the chosen firmware.',
  'Generation support is a file/plan capability, not proof that device images boot or that network acceptance passes.',
]

// Keep the pinned upstream blueprint unchanged. EDGE1 connects directly to
// FW1's trust interface (10.1.249.1/24); .2 is unused in that scaffold subnet.
const ADDRESS_CORRECTIONS = {
  'campus-network': [{ device: 'EDGE1', port: 'GigabitEthernet0/0/1',
    from: '10.1.250.1/24', to: '10.1.249.2/24' }],
}

function corrections(id) {
  return (ADDRESS_CORRECTIONS[id] ?? []).filter(correction => LABS[id].addressing.some(row =>
    row.device === correction.device && row.port === correction.port && row.ip === correction.from))
}

function scenario(id) {
  if (typeof id !== 'string' || !Object.hasOwn(SCENARIOS, id) || !Object.hasOwn(LABS, id)) {
    throw new Error('unknown scenario ID; use ensp_scenarios to list supported IDs')
  }
  const spec = LABS[id], applied = corrections(id)
  return { ...spec, addressing: spec.addressing.map(row => {
    const correction = applied.find(item => item.device === row.device && item.port === row.port && item.from === row.ip)
    return { ...row, ...(correction ? { ip: correction.to } : {}) }
  }) }
}

function deviceEntries(spec) {
  return spec.devices.map(entry => Array.isArray(entry) ? { name: entry[0], model: entry[1] } : { ...entry })
}

/** Check the existing fusion model registry instead of silently upgrading it. */
export function scenarioSupport(id) {
  const spec = scenario(id), devices = deviceEntries(spec), reasons = []
  for (const device of devices) {
    if (!Object.hasOwn(MODEL_SPECS, device.model)) reasons.push(`unsupported model: ${device.model}`)
  }
  for (const [a, ap, b, bp] of spec.links) {
    for (const [name, port] of [[a, ap], [b, bp]]) {
      const device = devices.find(item => item.name === name)
      if (!device) reasons.push(`unknown endpoint: ${name}`)
      else if (Object.hasOwn(MODEL_SPECS, device.model) && vrpToFlatIndex(device.model, port) === null) {
        reasons.push(`unsupported interface: ${name} (${device.model}) ${port}`)
      }
    }
  }
  return { supported: reasons.length === 0, reasons: [...new Set(reasons)] }
}

/** Validate address families independently; IPv4 /33 must never become /1. */
export function addressCommand(cidr) {
  if (typeof cidr !== 'string') throw new Error('address must be a CIDR string')
  const parts = cidr.split('/')
  const family = isIP(parts[0]), bits = Number(parts[1])
  if (parts.length !== 2 || !family || !/^\d+$/u.test(parts[1])
      || !Number.isInteger(bits) || bits > (family === 4 ? 32 : 128)) {
    throw new Error('invalid IPv4/IPv6 CIDR address')
  }
  if (family === 6) return `ipv6 address ${parts[0]}/${bits}`
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return `ip address ${parts[0]} ${[24, 16, 8, 0].map(shift => (mask >>> shift) & 255).join('.')}`
}

/** Addressing is a scaffold, never an inferred complete protocol answer. */
function configurations(spec) {
  const devices = deviceEntries(spec), grouped = new Map()
  for (const row of spec.addressing) {
    const device = devices.find(item => item.name === row.device)
    if (!device) throw new Error('addressing requires a known device')
    if (!MODEL_SPECS[device.model]?.console) {
      if (!['PC', 'Client', 'Server'].includes(device.model) || isIP(row.ip.split('/')[0]) !== 4
          || vrpToFlatIndex(device.model, row.port) === null) throw new Error('unsupported endpoint addressing')
      addressCommand(row.ip)
      continue // Native endpoint IPv4 belongs in .topo settings, never in a VRP plan.
    }
    if (typeof row.port !== 'string' || !/^(?:(?:GigabitEthernet|Ethernet|Serial|Tunnel)\d+\/\d+\/\d+|LoopBack\d+|Vlanif\d+)$/iu.test(row.port)) {
      throw new Error('invalid addressing interface')
    }
    const command = addressCommand(row.ip)
    if (!grouped.has(row.device)) grouped.set(row.device, [])
    grouped.get(row.device).push({ port: row.port, command })
  }
  return [...grouped].map(([device, rows]) => {
    const vlans = [...new Set(rows.map(row => /^Vlanif(\d+)$/iu.exec(row.port)?.[1]).filter(Boolean))]
    if (vlans.some(vlan => Number(vlan) < 1 || Number(vlan) > 4094)) throw new Error('invalid Vlanif VLAN')
    const commands = vlans.flatMap(vlan => [`vlan ${vlan}`, 'quit'])
    if (rows.some(row => row.command.startsWith('ipv6 '))) commands.push('ipv6')
    for (const row of rows) {
      commands.push(`interface ${row.port}`)
      if (row.command.startsWith('ipv6 ')) commands.push('ipv6 enable')
      commands.push(row.command, 'quit')
    }
    commands.push('return')
    return { device, commands, system_view: true, save: false }
  })
}

export function describeScenario(id) {
  const spec = scenario(id)
  return {
    id, brief: renderScenario(id), generation: scenarioSupport(id),
    devices: deviceEntries(spec),
    links: spec.links.map(([a, a_port, b, b_port]) => ({ a, a_port, b, b_port })),
    addressing: spec.addressing.map(row => ({ ...row })),
    notes: [...NOTES, ...corrections(id).map(item =>
      'Fusion addressing correction: ' + item.device + ' ' + item.port + ' changed from ' + item.from + ' to ' + item.to
      + ' to share the directly connected FW1 trust subnet. The pinned upstream file is unchanged.')],
  }
}

/** Reuse fusion validation and preserve blueprint coordinates after auto-layout. */
export function prepareScenario(id, { first_com_port = 2000, auto_layout = true } = {}) {
  const details = describeScenario(id), spec = scenario(id)
  if (!details.generation.supported) throw new Error(`scenario cannot be generated: ${details.generation.reasons.join('; ')}`)
  if (typeof auto_layout !== 'boolean') throw new Error('auto_layout must be boolean')
  const devices = details.devices.map(device => ({
    name: device.name, model: device.model,
    options: device.ip === 'dhcp' ? { pc: { dhcp: true } } : device.ip ? {
      pc: { ip: device.ip, ...(device.mask ? { mask: device.mask } : {}), ...(device.gateway ? { gateway: device.gateway } : {}) },
    } : {},
  }))
  const notes = [...details.notes]
  for (const device of devices.filter(item => ['PC', 'Client', 'Server'].includes(item.model))) {
    const rows = details.addressing.filter(row => row.device === device.name)
    if (!rows.length) continue
    if (rows.length !== 1) throw new Error('native endpoints require exactly one IPv4 address')
    const row = rows[0], command = addressCommand(row.ip)
    if (!command.startsWith('ip address ') || vrpToFlatIndex(device.model, row.port) === null) throw new Error('unsupported endpoint addressing')
    device.options.pc = { ip: row.ip.split('/')[0], mask: command.split(' ').at(-1), gateway: device.options.pc?.gateway ?? '0.0.0.0' }
    if (device.options.pc.gateway === '0.0.0.0') notes.push(`${device.name}: blueprint provides no default gateway; set to 0.0.0.0 (unset), complete it before routed service tests.`)
  }
  const topology = generateTopology({ devices, links: details.links, first_com_port, auto_layout })
  if (auto_layout && spec.positions) {
    for (const device of topology.devices) {
      const position = spec.positions[device.name]
      if (position) [device.x, device.y] = position
    }
  }
  topology.meta = { scenario: id }
  return { topology, ...details, notes, configuration: { scope: 'addressing-only', devices: configurations(spec) } }
}

/** New directory only; validate and render everything before claiming it. */
export async function generateScenarioLab({ id, out, first_com_port = 2000 }) {
  if (typeof out !== 'string' || !out.trim()) throw new Error('out must be a new directory path')
  const { topology, configuration, ...details } = prepareScenario(id, { first_com_port })
  const summary = summarise(topology), files = [
    ['topology.topo', serialiseTopology(topology)],
    ['addressing.json', JSON.stringify(details.addressing, null, 2) + '\n'],
    ['scenario.md', details.brief + '\n\n## 生成范围\n\n' + details.notes.map(note => `- ${note}`).join('\n') + '\n'],
  ]
  if (configuration.devices.length) {
    files.push(['cli-plan.json', JSON.stringify({
      topology_path: 'topology.topo', dry_run: true, devices: configuration.devices,
    }, null, 2) + '\n'])
    for (const [index, device] of configuration.devices.entries()) {
      files.push([`${String(index + 1).padStart(3, '0')}-device.cfg`, ['system-view', ...device.commands].join('\n') + '\n'])
    }
  }
  files.push(['manifest.json', JSON.stringify({ id, summary, configuration_scope: configuration.scope,
    configuration_available: configuration.devices.length > 0, files: [...files.map(([name]) => name), 'manifest.json'], notes: details.notes }, null, 2) + '\n'])
  const directory = resolve(out)
  try { await mkdir(directory) } catch (error) {
    if (error.code === 'EEXIST') throw new Error('refusing to overwrite existing output directory')
    throw error
  }
  try {
    for (const [name, content] of files) await writeFile(join(directory, name), content, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return { out: directory, id, summary, files: files.map(([name]) => name), configuration_available: configuration.devices.length > 0, notes: details.notes }
}
