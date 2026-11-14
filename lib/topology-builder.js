import { isIP } from 'node:net'
import { buildTopology, autoLayout, MODEL_SPECS } from '../upstream/lizi600jin/src/core/build.mjs'
function integer(value, low, high, label) {
  if (!Number.isInteger(value) || value < low || value > high) throw new Error(`${label} must be ${low}..${high}`)
  return value
}
export function generateTopology({ devices, links = [], first_com_port = 2000, auto_layout = true }) {
  if (!Array.isArray(devices) || !devices.length || devices.length > 256) throw new Error('devices must contain 1..256 devices')
  if (!Array.isArray(links) || links.length > 2048) throw new Error('links must be an array of at most 2048 links')
  integer(first_com_port, 1, 9999, 'first_com_port')
  const builder = buildTopology({ firstComPort: first_com_port })
  const ports = new Set(), names = new Set()
  for (const d of devices) {
    if (!d || typeof d.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(d.name)) throw new Error('device name must be a simple ASCII identifier')
    if (names.has(d.name.toLowerCase())) throw new Error(`duplicate device name: ${d.name}`)
    names.add(d.name.toLowerCase())
    if (!Object.hasOwn(MODEL_SPECS, d.model)) throw new Error(`unknown model: ${d.model}`)
    if (d.options && (typeof d.options !== 'object' || Array.isArray(d.options))) throw new Error('options must be an object')
    const opts = d.options ?? {}
    for (const k of Object.keys(opts)) if (!['x','y','comPort','bootmode','pc'].includes(k)) throw new Error(`unknown device option: ${k}`)
    for (const k of ['x','y']) if (opts[k] !== undefined && !Number.isFinite(opts[k])) throw new Error(`${k} must be finite`)
    if (opts.bootmode !== undefined) integer(opts.bootmode, 0, 1, 'bootmode')
    if (opts.pc !== undefined) {
      if (!opts.pc || typeof opts.pc !== 'object' || Array.isArray(opts.pc)) throw new Error('pc must be an object')
      for (const [key, value] of Object.entries(opts.pc)) {
        if (key === 'dhcp') {
          if (d.model !== 'PC' || typeof value !== 'boolean') throw new Error('pc.dhcp must be a boolean for a PC device')
          continue
        }
        if (!['ip','mask','gateway','dns'].includes(key) || typeof value !== 'string' || isIP(value) !== 4) throw new Error(`invalid PC IPv4 setting: ${key}`)
      }
      if (opts.pc.dhcp && ['ip','mask','gateway','dns'].some(key => opts.pc[key] !== undefined)) throw new Error('pc.dhcp cannot be combined with static IPv4 settings')
    }
    builder.add(d.name, d.model, opts)
  }
  const used = new Set()
  for (const l of links) {
    if (!l || l.a === l.b) throw new Error('self links are not supported')
    builder.link(l.a, l.a_port, l.b, l.b_port)
    const link = builder.finish().links.at(-1)
    for (const key of [`${link.srcId}:${link.srcIndex}`, `${link.dstId}:${link.dstIndex}`]) {
      if (used.has(key)) throw new Error('interface is already connected')
      used.add(key)
    }
  }
  let topology = builder.finish()
  for (const d of topology.devices) {
    integer(d.comPort, MODEL_SPECS[d.model].console ? 1 : 0, 9999, 'comPort')
    if (d.comPort && ports.has(d.comPort)) throw new Error(`duplicate comPort: ${d.comPort}`)
    if (d.comPort) ports.add(d.comPort)
  }
  if (auto_layout) topology = autoLayout(topology)
  return topology
}
