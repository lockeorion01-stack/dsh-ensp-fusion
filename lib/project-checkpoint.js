import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { cp, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { readTopo, validateTopoConsolePorts } from './topo.js'
import { createRedactor } from './redaction.js'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// Some flash.efz files wrap append-only ZIP payloads in an eNSP container.
// Inspect its latest bounded configuration payload as disk evidence. Later ZIP
// records may contain sysinfo logs rather than configuration. This never proves
// a mounted filesystem pointer or a cold-loaded running configuration.
export function flashConfiguration(bytes) {
  if (bytes.length > 64 * 1024 * 1024) throw Error('flash archive exceeds 64 MiB limit')
  let expandedBytes = 0
  if (bytes.subarray(0, 4).toString('ascii') === 'eNSP') {
    const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06])
    const localSignature = Buffer.from([0x50, 0x4b, 0x03, 0x04])
    let before = bytes.length, payloads = 0
    while (before > 12) {
      const end = bytes.lastIndexOf(endSignature, before - 1)
      if (end < 12 || end + 22 > before) throw Error('eNSP flash has no bounded embedded configuration ZIP payload')
      const finish = end + 22 + bytes.readUInt16LE(end + 20)
      const start = end - bytes.readUInt32LE(end + 12) - bytes.readUInt32LE(end + 16)
      // Check the newest record before searching history. An incomplete newer
      // ZIP or corrupt configuration must not turn into a successful fallback.
      if (start < 12 || start >= end || finish > before || bytes.readUInt32LE(start) !== 0x04034b50
        || bytes.readUInt32LE(start - 4) !== Math.ceil((finish - start) / 16) * 16
        || start + bytes.readUInt32LE(start - 4) > before
        || bytes.lastIndexOf(localSignature, before - 1) > end) throw Error('invalid or truncated eNSP embedded ZIP payload')
      if (++payloads > 4096) throw Error('eNSP flash has too many embedded ZIP payloads')
      const config = zipConfiguration(bytes.subarray(start, finish), true)
      if (config) return config
      before = start - 12
    }
    throw Error('eNSP flash has no bounded embedded configuration ZIP payload')
  }
  return zipConfiguration(bytes, false)

  function zipConfiguration(bytes, allowMissing) {
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break }
  }
  if (end < 0) throw Error('flash archive has no valid ZIP directory')
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw Error('multi-disk flash archive unsupported')
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12)
  let cursor = bytes.readUInt32LE(end + 16)
  if (cursor + directorySize !== end || count > 4096) throw Error('invalid flash directory bounds')
  const configs = []
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw Error('invalid flash directory entry')
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16)
    const size = bytes.readUInt32LE(cursor + 20), expanded = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32)
    const local = bytes.readUInt32LE(cursor + 42)
    if (cursor + 46 + nameLength + extra + comment > end) throw Error('flash entry outside directory')
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8').replace(/\\/gu, '/')
    const configuration = /(?:^|\/)vrpcfg\.cfg$/iu.test(name)
    if (configuration || allowMissing) {
      if (flags & 1 || ![0, 8].includes(method) || (configuration && !expanded) || expanded > 4 * 1024 * 1024) throw Error('unsupported or empty flash configuration')
      expandedBytes += expanded
      if (expandedBytes > 64 * 1024 * 1024) throw Error('flash payload expansion exceeds 64 MiB limit')
      if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw Error('invalid flash local entry')
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
      if (start + size > bytes.readUInt32LE(end + 16)) throw Error('flash data overlaps directory')
      const payload = bytes.subarray(start, start + size)
      const data = method === 0 ? payload : inflateRawSync(payload, { maxOutputLength: 4 * 1024 * 1024 })
      if (data.length !== expanded || crc32(data) !== crc) throw Error('flash configuration CRC or length mismatch')
      if (configuration) configs.push(data)
    }
    cursor += 46 + nameLength + extra + comment
  }
  if (cursor !== end) throw Error('invalid flash directory bounds')
  if (configs.length > 1 || (!allowMissing && configs.length !== 1)) throw Error('flash archive must contain exactly one vrpcfg.cfg')
  return configs[0] ?? null
  }
}

function inside(root, path) { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') }
async function boundedFile(root, path) {
  if (!inside(await realpath(root), await realpath(path))) throw Error('project asset escapes project directory')
  const info = await stat(path)
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw Error('project asset must be a file <=64 MiB')
  return { bytes: await readFile(path), mtimeMs: info.mtimeMs }
}

async function firewallConfigurationAssets(root, directory) {
  if (!inside(await realpath(root), await realpath(directory)) || (await lstat(directory)).isSymbolicLink()) throw Error('project device path escapes root')
  const names = (await readdir(directory)).filter(name => /\.cfg$/iu.test(name)).sort()
  if (names.length > 4096) throw Error('too many firewall configuration assets')
  const assets = []
  let totalBytes = 0
  for (const name of names) {
    const path = join(directory, name)
    if ((await lstat(path)).isSymbolicLink()) throw Error('symlink configuration asset unsupported')
    const data = await boundedFile(root, path)
    totalBytes += data.bytes.length
    if (totalBytes > 64 * 1024 * 1024) throw Error('firewall configuration assets exceed 64 MiB limit')
    assets.push({ name, path, ...data, sha256: sha(data.bytes) })
  }
  return assets
}

export async function inspectProject(topologyPath, { expected = {} } = {}) {
  const topology = await readTopo(topologyPath), root = dirname(topologyPath)
  validateTopoConsolePorts(topology.text)
  const devices = []
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.values(expected).some(v => !Array.isArray(v) || v.some(s => typeof s !== 'string' || !s.trim()))) throw Error('expected must map device names to nonempty configuration substrings')
  if (Object.keys(expected).some(name => !topology.devices.some(d => d.name === name))) throw Error('expected contains an unknown topology device')
  for (const device of topology.devices.filter(d => d.comPort > 0)) {
    if (!/^[a-z\d_-]{1,80}$/iu.test(device.id)) throw Error('unsafe project device id')
    const firewall = /^USG/iu.test(device.model)
    let file = join(root, device.id, firewall ? 'vrpcfg.cfg' : 'flash.efz')
    const row = { device: device.name, id: device.id, model: device.model, path: file, ok: false, state: 'missing', bytes: 0 }
    try {
      let data
      if (firewall) {
        const assets = await firewallConfigurationAssets(root, join(root, device.id))
        row.configurationAssets = assets.map(({ name, bytes, sha256 }) => ({ name, bytes: bytes.length, sha256 }))
        row.configurationSelection = assets.length === 1 ? 'sole .cfg asset; active startup pointer is not verified' : 'no unique .cfg asset; active startup pointer is not verified'
        if (assets.length > 1) {
          row.state = 'ambiguous'
          row.path = join(root, device.id)
          devices.push(row)
          continue
        }
        if (!assets.length) { devices.push(row); continue }
        data = assets[0]
        file = data.path
        row.path = file
      } else data = await boundedFile(root, file)
      row.bytes = data.bytes.length; row.sha256 = sha(data.bytes); row.mtimeMs = data.mtimeMs
      if (!data.bytes.length) row.state = 'empty'
      else {
        const config = firewall ? data.bytes : flashConfiguration(data.bytes)
        const text = config.toString('utf8')
        row.configurationSha256 = sha(config)
        row.configurationBytes = config.length
        // Never return configuration text or actual missing secret substrings.
        row.expectedChecks = (expected[device.name] ?? []).map((value, index) => ({ index, pass: text.includes(value) }))
        const recognizable = /(?:^|\n)\s*(?:sysname\s+\S+|!Software Version|#.*(?:VRP|Version))/imu.test(text)
        row.ok = recognizable && row.expectedChecks.every(check => check.pass)
        row.state = row.ok ? 'content_verified' : recognizable ? 'expected_content_missing' : 'unrecognized_configuration'
      }
    } catch (error) { row.state = error.code === 'ENOENT' ? 'missing' : 'invalid'; row.error = createRedactor()(error.message) }
    devices.push(row)
  }
  return { ok: devices.length > 0 && devices.every(d => d.ok), topology: topologyPath,
    topologySha256: sha(await readFile(topologyPath)), devices,
    persistence: 'content inspection only', reloadVerified: false,
    limits: ['Nonempty files and content hashes do not prove cold load or active project identity.', 'USG: inspect the sole .cfg asset; multiple .cfg files remain ambiguous. Filenames do not prove the active startup pointer.', 'eNSP containers: latest complete bounded configuration ZIP payload; later non-configuration ZIP records are skipped and historical payloads may remain. This does not resolve the mounted filesystem pointer.', 'Expected substrings should cover the intended current baseline; old nonempty backups may be incomplete.'] }
}

export async function checkpointProject(topologyPath, backupDirectory, options) {
  const root = await realpath(dirname(topologyPath))
  const destination = join(await realpath(dirname(resolve(backupDirectory))), basename(backupDirectory))
  if (inside(root, destination) || inside(root, resolve(backupDirectory))) throw Error('backup directory must be outside the project directory to avoid recursive or mutable checkpoints')
  const before = await inspectProject(topologyPath, options)
  await mkdir(destination, { recursive: false }) // no overwrite
  try {
  await cp(topologyPath, join(destination, basename(topologyPath)), { errorOnExist: true, force: false })
  for (const device of (await readTopo(topologyPath)).devices) {
    if (!/^[a-z\d_-]{1,80}$/iu.test(device.id)) throw Error('unsafe project device id')
    const directory = join(root, device.id)
    try {
      const canonical = await realpath(directory)
      if (!inside(root, canonical) || (await lstat(directory)).isSymbolicLink()) throw Error('project device path escapes root')
      // Do not copy disk images or unrelated project folders. These configuration
      // assets are the bounded recovery evidence used by this workflow.
      await mkdir(join(destination, device.id))
      const names = /^USG/iu.test(device.model)
        ? [...(await firewallConfigurationAssets(root, directory)).map(asset => asset.name), 'flash.efz', 'PC.xml']
        : ['vrpcfg.cfg', 'flash.efz', 'PC.xml']
      for (const name of names) {
        const path = join(directory, name)
        try { await boundedFile(root, path); if ((await lstat(path)).isSymbolicLink()) throw Error('symlink configuration asset unsupported'); await cp(path, join(destination, device.id, name), { errorOnExist: true, force: false }) }
        catch (error) { if (error.code !== 'ENOENT') throw error }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const copied = await inspectProject(join(destination, basename(topologyPath)), options)
  const after = await inspectProject(topologyPath, options)
  const digest = report => JSON.stringify([report.topologySha256, report.devices.map(d => [d.id, d.sha256 ?? null, d.configurationAssets ?? null])])
  const stable = digest(before) === digest(after) && digest(before) === digest(copied)
  const manifest = { ...before, checkpoint: destination, stable, ok: before.ok && stable,
    scope: 'topology and device configuration assets; not VM disks or a complete running-state backup', timestamp: new Date().toISOString() }
  await writeFile(join(destination, 'checkpoint.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
  } catch (error) {
    await writeFile(join(destination, 'checkpoint.incomplete.json'), JSON.stringify({ ok: false, stable: false,
      error: createRedactor()(error.message), scope: 'incomplete checkpoint; do not restore', timestamp: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' }).catch(() => {})
    throw error
  }
}

export function compareProject(before, after) {
  const mismatches = []
  if (before.topologySha256 !== after.topologySha256) mismatches.push('topology_hash_changed')
  for (const device of before.devices) {
    const current = after.devices.find(row => row.id === device.id)
    if (!device.ok || !current?.ok || !device.configurationSha256 || current.configurationSha256 !== device.configurationSha256) mismatches.push(`configuration_changed_or_unverified:${device.device}`)
  }
  if (after.devices.length !== before.devices.length) mismatches.push('device_count_changed')
  return { ok: !mismatches.length, mismatches, reloadVerified: false, scope: 'disk configuration comparison only' }
}
