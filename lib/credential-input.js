import { readFile } from 'node:fs/promises'

const KEYS = ['username', 'password', 'passwords', 'new_password']
// Resolve secrets only inside the body, after the host has recorded references.
// Never write the hydrated arguments back into exec.arguments or a tool result.
export async function hydrateInputs(args, resolvePath) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object')
  let store
  if (args.credential_file !== undefined) {
    if (typeof args.credential_file !== 'string' || !args.credential_file.trim()) throw new Error('credential_file must be a nonempty path')
    const path = await resolvePath(args.credential_file, 'credential_file')
    try { store = JSON.parse(await readFile(path, 'utf8')) }
    catch { throw new Error('credential_file must contain valid JSON; contents omitted') }
    if (!store || typeof store !== 'object' || Array.isArray(store)) throw new Error('credential_file must be an object keyed by credential_ref')
  }
  async function hydrate(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('credential target must be an object')
    if (entry !== args && entry.credential_file !== undefined) throw new Error('credential_file must be supplied at batch root')
    const out = { ...entry }
    if (entry.credential_ref !== undefined) {
      if (typeof entry.credential_ref !== 'string' || !entry.credential_ref.trim() || !Object.hasOwn(store ?? {}, entry.credential_ref)) throw new Error('credential_ref was not found in credential_file')
      const source = store[entry.credential_ref]
      if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(key => !KEYS.includes(key))) throw new Error('credential entry contains unsupported fields')
      for (const key of KEYS) {
        if (entry[key] !== undefined) throw new Error('credential_ref cannot be combined with inline credentials')
        if (source[key] !== undefined) {
          if (key === 'passwords' ? !Array.isArray(source[key]) || source[key].some(v => typeof v !== 'string') : typeof source[key] !== 'string') throw new Error('credential entry has invalid field types')
          out[key] = source[key]
        }
      }
      delete out.credential_ref
    }
    if (entry.commands_file !== undefined) {
      if (entry.commands !== undefined) throw new Error('commands_file and commands are mutually exclusive')
      const path = await resolvePath(entry.commands_file, 'commands_file')
      try { out.commands = JSON.parse(await readFile(path, 'utf8')) }
      catch { throw new Error('commands_file must contain a JSON command array; contents omitted') }
      if (!Array.isArray(out.commands) || !out.commands.length) throw new Error('commands_file must contain a nonempty command array')
      delete out.commands_file
    }
    return out
  }
  const out = await hydrate(args)
  delete out.credential_file
  for (const key of ['devices', 'ready_devices']) {
    if (args[key] !== undefined) {
      if (!Array.isArray(args[key])) throw new Error(`${key} must be an array`)
      out[key] = await Promise.all(args[key].map(hydrate))
    }
  }
  return out
}
