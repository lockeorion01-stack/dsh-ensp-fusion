// Validate the entire batch before opening any device connection.
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
export function singleLine(value, label) {
  if (typeof value !== 'string' || !value.trim() || CONTROL.test(value)) {
    throw new Error(`${label} must be a non-empty single-line string without control characters`)
  }
  return value.trim()
}

function patterns(value, label) {
  if (value === undefined || value === null) return null
  const items = Array.isArray(value) ? value : [value]
  if (!items.length) throw new Error(`${label} cannot be empty`)
  for (const item of items) {
    if (typeof item !== 'string' || !item.trim()) throw new Error(`${label} must contain non-empty strings`)
    const regex = /^\/(.*)\/([a-z]*)$/u.exec(item)
    if (regex) new RegExp(regex[1], regex[2] || 'i')
  }
  return value
}

export function prepareCliEntries(args, topologyDevices = null) {
  if (args.devices !== undefined && (!Array.isArray(args.devices) || !args.devices.length)) {
    throw new Error('devices must be a non-empty array')
  }
  if (args.continue_on_error !== undefined && typeof args.continue_on_error !== 'boolean') {
    throw new Error('continue_on_error must be boolean')
  }
  const entries = args.devices ?? [args]
  const usedPorts = new Set()
  return entries.map((entry, index) => {
    const label = `devices[${index}]`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${label} must be an object`)
    const device = entry.device === undefined ? undefined : singleLine(entry.device, `${label}.device`)
    let port = entry.port
    if (port === undefined || port === null || port === '') {
      if (!device || !topologyDevices) throw new Error('provide port, or device + topology_path')
      const matches = topologyDevices.filter((item) => item.name.toLowerCase() === device.toLowerCase())
      if (matches.length !== 1) throw new Error(`device "${device}" must resolve to exactly one topology device`)
      port = matches[0].comPort
      if (topologyDevices.some((item) => item !== matches[0] && item.comPort === port)) {
        throw new Error(`topology console port ${port} is shared by multiple devices`)
      }
    }
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`${label}.port must be an integer from 1 to 65535 (PC/Server port 0 has no CLI)`)
    }
    if (usedPorts.has(port)) throw new Error(`duplicate console port ${port} in this batch`)
    usedPorts.add(port)
    if (!Array.isArray(entry.commands) || !entry.commands.length) throw new Error(`${label}.commands must be a non-empty array`)
    if (entry.expect !== undefined && (!Array.isArray(entry.expect) || entry.expect.length > entry.commands.length)) {
      throw new Error(`${label}.expect must be an array aligned with commands`)
    }
    const commands = [], expect = []
    if (entry.recovery_commands !== undefined && (!Array.isArray(entry.recovery_commands) || !entry.recovery_commands.length)) {
      throw new Error(`${label}.recovery_commands must be a non-empty array`)
    }
    const recovery_commands = entry.recovery_commands?.map((line, i) => singleLine(line, `${label}.recovery_commands[${i}]`))
    entry.commands.forEach((item, i) => {
      if (typeof item !== 'string' && (!item || typeof item !== 'object' || Array.isArray(item))) {
        throw new Error(`${label}.commands[${i}] must be a string or {cmd, expect}`)
      }
      commands.push(singleLine(typeof item === 'string' ? item : item.cmd, `${label}.commands[${i}]`))
      expect.push(patterns(typeof item === 'string' ? entry.expect?.[i] : (item.expect ?? entry.expect?.[i]), `${label}.expect[${i}]`))
    })
    for (const key of ['save', 'system_view', 'confirm_lldp_disable']) {
      if (entry[key] !== undefined && typeof entry[key] !== 'boolean') throw new Error(`${label}.${key} must be boolean`)
    }
    if (entry.command_timeout_ms !== undefined && (!Number.isInteger(entry.command_timeout_ms) || entry.command_timeout_ms <= 0)) {
      throw new Error(`${label}.command_timeout_ms must be a positive integer`)
    }
    for (const key of ['username', 'password', 'new_password']) {
      if (entry[key] !== undefined && (typeof entry[key] !== 'string' || CONTROL.test(entry[key]))) {
        throw new Error(`${label}.${key} must be a string without control characters`)
      }
    }
    if (entry.passwords !== undefined && (!Array.isArray(entry.passwords) || entry.passwords.some((s) => typeof s !== 'string' || !s || CONTROL.test(s)))) {
      throw new Error(`${label}.passwords must be an array of non-empty single-line strings`)
    }
    return { ...entry, device, port, commands, expect, recovery_commands }
  })
}
