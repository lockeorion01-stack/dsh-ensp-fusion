/**
 * .topo reader/writer.
 *
 * An eNSP topology is XML, including legacy GB18030 and Unicode files.
 * Every device carries the facts the automation needs - name, model, console
 * ``com_port`` (the telnet port once started), canvas ``cx``/``cy`` and the
 * label anchor ``edit_left``/``edit_top``.  Edits are textual attribute
 * replacements so unknown elements survive untouched.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { spawnSync } from 'node:child_process'
import { discoverPythonCandidates } from './bridge-client.js'

const DEV_TAG = /<dev\b[^>]*>/gu

function attrsOf(tag) {
  const out = {}
  for (const match of tag.matchAll(/([A-Za-z_][\w-]*)="([^"]*)"/gu)) {
    out[match[1]] = match[2]
  }
  return out
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&')
}

function encodeEntities(text) {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')
}

function numeric(value, fallback = 0) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Parse the parts of a topology that automation cares about. */
export function parseTopo(text) {
  const devices = []
  for (const match of text.matchAll(DEV_TAG)) {
    const tag = match[0]
    const attrs = attrsOf(tag)
    if (!attrs.id) continue
    devices.push({
      id: attrs.id,
      name: decodeEntities(attrs.name ?? ''),
      model: attrs.model ?? '',
      comPort: Number.parseInt(attrs.com_port ?? '0', 10) || 0,
      cx: numeric(attrs.cx),
      cy: numeric(attrs.cy),
      editLeft: numeric(attrs.edit_left),
      editTop: numeric(attrs.edit_top),
      mac: attrs.system_mac ?? '',
      settings: decodeEntities(attrs.settings ?? ''),
    })
  }
  const tipMatches = [...text.matchAll(/<txttip\b[^>]*content="([^"]*)"/gu)]
  const versionMatch = /<topo[^>]*version="([^"]*)"/u.exec(text)
  return {
    version: versionMatch?.[1] ?? '',
    devices,
    annotationCount: tipMatches.length,
    annotations: tipMatches.map((m) => decodeEntities(m[1])),
  }
}

export async function readTopo(path) {
  const bytes = await readFile(path)
  let raw, encoding = 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le'
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be'
  try { raw = new TextDecoder(encoding, { fatal: true }).decode(bytes) }
  catch {
    encoding = 'gb18030'
    raw = new TextDecoder(encoding, { fatal: true }).decode(bytes)
  }
  return { text: raw, encoding, ...parseTopo(raw) }
}

/** eNSP 1.2.0.500 crashes opening five-digit console ports. TCP CLI ports
 * remain independent of this native topology compatibility constraint. */
export function validateTopoConsolePorts(text) {
  const used = new Set()
  for (const match of text.replace(/<!--[\s\S]*?-->/gu, '').matchAll(DEV_TAG)) {
    const attrs = attrsOf(match[0])
    const raw = attrs.com_port ?? '0'
    const port = Number(raw)
    if (port && (!attrs.id?.trim() || !attrs.name?.trim())) throw new Error('Console device has a missing id or name; refusing incomplete topology verification')
    if (!/^\d+$/u.test(raw) || !Number.isInteger(port) || port > 9999) {
      throw new Error(`invalid com_port for ${attrs.name ?? attrs.id}: ${raw}; eNSP topology requires 0..9999`)
    }
    if (port && used.has(port)) throw new Error(`duplicate com_port: ${port}`)
    if (port) used.add(port)
  }
}

/** Validate explicit native endpoint arguments before handing them to eNSP.
 * Empty settings use native defaults. Never infer repairs for legacy files. */
export function validateNativeEndpointSettings(text) {
  const known=new Set(['-domain','-eth','-ipaddr','-ipmask','-gateway','-ipv6addr','-ipv6gateway','-prefixlen','-ipv4dns','-ipv6dns','-dnslist'])
  for(const device of parseTopo(text.replace(/<!--[\s\S]*?-->/gu,'')).devices){
    if(!/^(Server|Client)$/iu.test(device.model)||!device.settings.trim())continue
    const parts=device.settings.trim().split(/\s+/u),seen=new Set()
    for(let i=0;i<parts.length;i++){
      const key=parts[i]
      if(!known.has(key))continue
      if(seen.has(key))throw Error(`Native endpoint ${device.name}: duplicate ${key}`)
      seen.add(key)
      const value=parts[i+1]
      if(!value||value.startsWith('-'))throw Error(`Native endpoint ${device.name}: missing value for ${key}`)
      if(['-ipaddr','-ipmask','-gateway','-ipv4dns'].includes(key)&&isIP(value)!==4)throw Error(`Native endpoint ${device.name}: invalid IPv4 for ${key}`)
      if(['-ipv6addr','-ipv6gateway','-ipv6dns'].includes(key)&&isIP(value)!==6)throw Error(`Native endpoint ${device.name}: invalid IPv6 for ${key}`)
      if(key==='-eth'&&!/^(?:[a-f\d]{2}[:-]){5}[a-f\d]{2}$/iu.test(value))throw Error(`Native endpoint ${device.name}: invalid MAC for ${key}`)
      if(key==='-prefixlen'&&(!/^\d+$/u.test(value)||Number(value)>128))throw Error(`Native endpoint ${device.name}: invalid IPv6 prefix`)
      i++
    }
  }
}

/** Replace one attribute on the ``<dev>`` tag whose ``name`` matches. */
function patchDevTag(text, name, patcher) {
  let hit = false
  const next = text.replace(DEV_TAG, (tag) => {
    const attrs = attrsOf(tag)
    if (decodeEntities(attrs.name ?? '') !== name) return tag
    hit = true
    return patcher(tag, attrs)
  })
  return { text: next, hit }
}

function setAttribute(tag, attr, value) {
  const encoded = encodeEntities(String(value))
  const pattern = new RegExp(`(\\b${attr}=")[^"]*(")`, 'u')
  if (pattern.test(tag)) return tag.replace(pattern, `$1${encoded}$2`)
  return tag.replace(/\s*\/?>$/u, (tail) => ` ${attr}="${encoded}"${tail}`)
}

/** Rename a device (the topology-side name shown on the canvas). */
export function renameDevice(text, from, to) {
  const { text: next, hit } = patchDevTag(text, from, (tag) => setAttribute(tag, 'name', to))
  if (!hit) throw new Error(`device "${from}" not found in topology`)
  return next
}

/** Assign a console/telnet port to a device. */
export function setComPort(text, name, port) {
  const { text: next, hit } = patchDevTag(text, name, (tag) => setAttribute(tag, 'com_port', port))
  if (!hit) throw new Error(`device "${name}" not found in topology`)
  validateTopoConsolePorts(next)
  return next
}

/** Give every startable device a stable, unique console port. */
export function renumberComPorts(text, { start = 2000 } = {}) {
  validateTopoConsolePorts(text)
  if (!Number.isInteger(start) || start < 1 || start > 9999) throw new Error('start must be 1..9999')
  const used = new Set(parseTopo(text).devices.map((device) => device.comPort).filter(Boolean))
  let port = start
  const assigned = []
  const next = text.replace(DEV_TAG, (tag, offset) => {
    void offset
    const attrs = attrsOf(tag)
    const model = attrs.model ?? ''
    if (!/^(AR|S\d|USG|NE|Router|WLAN)/iu.test(model)) return tag
    const current = Number.parseInt(attrs.com_port ?? '0', 10) || 0
    if (current > 0) {
      assigned.push({ name: decodeEntities(attrs.name ?? ''), comPort: current })
      return tag
    }
    while (used.has(port)) port++
    if (port > 9999) throw new Error('no available topology console ports at or above start')
    const chosen = port++
    used.add(chosen)
    assigned.push({ name: decodeEntities(attrs.name ?? ''), comPort: chosen })
    return setAttribute(tag, 'com_port', chosen)
  })
  return { text: next, assigned }
}

function setSetting(settings, key, value) {
  const pattern = new RegExp(`(^|\\s)${key}\\s+[^\\s]+`, 'u')
  if (pattern.test(settings)) return settings.replace(pattern, `$1${key} ${value}`)
  return `${settings}${settings.endsWith(' ') || settings === '' ? '' : ' '} ${key} ${value}`.trimStart()
}

/** Set IPv4 of a PC (``-simpc_*``) or a Server/Client (``-ipaddr``...) device. */
export function setDeviceIpv4(text, name, { ip, mask, gateway }) {
  validateNativeEndpointSettings(text)
  const { text: next, hit } = patchDevTag(text, name, (tag, attrs) => {
    let settings = decodeEntities(attrs.settings ?? '')
    const isPc = /-simpc_/iu.test(settings) || (attrs.model ?? '').toUpperCase() === 'PC'
    if (ip !== undefined) settings = setSetting(settings, isPc ? '-simpc_ip' : '-ipaddr', ip)
    if (mask !== undefined) settings = setSetting(settings, isPc ? '-simpc_mask' : '-ipmask', mask)
    if (gateway !== undefined) settings = setSetting(settings, isPc ? '-simpc_gateway' : '-gateway', gateway)
    return setAttribute(tag, 'settings', settings)
  })
  if (!hit) throw new Error(`device "${name}" not found in topology`)
  return next
}

export async function writeTopo(path, text, { encoding = 'utf-8', flag = 'w' } = {}) {
  validateTopoConsolePorts(text)
  validateNativeEndpointSettings(text)
  let bytes
  if (encoding === 'utf-8') bytes = Buffer.from(text, 'utf8')
  else if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    if (encoding === 'utf-16be') bytes.swap16()
  } else if (encoding === 'gb18030') {
    // Use the bridge's existing Python runtime for strict legacy encoding.
    // Convert fully before touching the destination, and verify no character
    // was replaced or changed by a codec mapping.
    for (const python of [...discoverPythonCandidates(), 'python3', 'python']) {
      const result = spawnSync(python, ['-c', 'import sys; sys.stdout.buffer.write(sys.stdin.buffer.read().decode("utf-8").encode("gb18030", errors="strict"))'], {
        input: Buffer.from(text, 'utf8'), windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 * 1024,
      })
      if (result.error?.code === 'ENOENT') continue
      if (result.error || result.status !== 0) throw new Error('Unable to encode topology as GB18030 with the Python runtime')
      bytes = result.stdout
      break
    }
    if (!bytes) throw new Error('Preserving GB18030 topology requires the configured bridge Python runtime')
  } else throw new Error(`Unsupported topology encoding: ${encoding}`)
  if (new TextDecoder(encoding, { fatal: true }).decode(bytes) !== text.replace(/^\uFEFF/u, '')) {
    throw new Error(`Topology cannot be represented losslessly as ${encoding}`)
  }
  await writeFile(path, bytes, { flag })
}

/** Devices worth showing a human: name, model, telnet port. */
export function describeDevices(parsed) {
  return parsed.devices.map((device) => ({
    name: device.name,
    model: device.model,
    comPort: device.comPort,
    telnet: device.comPort > 0 ? `127.0.0.1:${device.comPort}` : null,
  }))
}

const CLIENT_MODELS = /^(PC|Client|Server|MCS|STA)/iu
const SWITCH_MODELS = /^(S\d|LSW)/iu
const ROUTER_MODELS = /^(AR|Router|NE)/iu
const FIREWALL_MODELS = /^(USG|FW|Eudemon)/iu

/**
 * Suggest SW1/SW2..., AR1/AR2..., FW1... names by role.
 *
 * Devices that already follow the convention keep their name, so renumbering
 * never swaps two existing devices. Numbering follows the topology's device
 * order, which is the order the devices were placed.
 */
export function suggestNames(devices) {
  const roleOf = (model) => {
    if (CLIENT_MODELS.test(model)) return null
    if (FIREWALL_MODELS.test(model)) return 'FW'
    if (SWITCH_MODELS.test(model)) return 'SW'
    if (ROUTER_MODELS.test(model)) return 'AR'
    return null
  }
  const taken = new Set()
  for (const device of devices) {
    const role = roleOf(device.model ?? '')
    if (role && new RegExp(`^${role}\\d+$`, 'u').test(device.name)) taken.add(device.name.toUpperCase())
  }
  const counters = { SW: 0, AR: 0, FW: 0 }
  const nextFree = (role) => {
    let number = 1
    for (;;) {
      const candidate = `${role}${number}`
      if (!taken.has(candidate)) {
        taken.add(candidate)
        return candidate
      }
      number += 1
    }
  }
  return devices.map((device) => {
    const model = device.model ?? ''
    const role = roleOf(model)
    if (!role) return { name: device.name, keep: true, reason: '终端设备保持原名' }
    if (new RegExp(`^${role}\\d+$`, 'u').test(device.name)) {
      counters[role] += 1
      return { name: device.name, keep: true, reason: '已符合命名规则' }
    }
    return { name: nextFree(role), from: device.name, keep: false }
  })
}
