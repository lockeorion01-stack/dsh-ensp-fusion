#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { createRegistry } from '../mcp/server.js'

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || ['--help', '-h'].includes(command)) {
    process.stdout.write('ensp-fusion tools\nensp-fusion call <tool> <args.json> [workspace]\nensp-fusion scenarios [keyword]\nMCP: ensp-fusion-mcp --workspace <dir>\nOffline lab plans: ensp-fusion-lab --help\nUnified acceptance: ensp-fusion-accept --help\nEnvironment: ensp-fusion-doctor --help\n')
    return
  }
  const registry = createRegistry({ workspace: command === 'call' ? rest[2] : process.cwd() })
  if (command === 'tools') {
    process.stdout.write(JSON.stringify(registry.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), null, 2) + '\n')
    return
  }
  const name = command === 'scenarios' ? 'ensp_scenarios' : rest[0]
  if (!['scenarios','call'].includes(command)) throw new Error(`unknown command: ${command}`)
  const tool = registry.tools.find(t => t.name === name)
  if (!tool) throw new Error(`unknown tool: ${name}`)
  const args = command === 'scenarios' ? { query: rest.join(' ') } : JSON.parse((await readFile(rest[1], 'utf8')).replace(/^\uFEFF/, ''))
  const result = await tool.handler(args, registry.exec)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (result.ok === false) process.exitCode = 1
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
