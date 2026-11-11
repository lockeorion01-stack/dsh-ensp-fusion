import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const entry = fileURLToPath(new URL('../bin/dsh-ensp-mcp.mjs', import.meta.url))
const run = args => spawnSync(process.execPath, [entry, ...args], {encoding:'utf8',timeout:5000,windowsHide:true})

test('MCP entry accepts separate GUI and document Python paths', () => {
  for (const args of [
    ['--python','C:/GUI Python/python.exe','--docs-python','C:/Docs Python/python.exe'],
    ['--python=C:/GUI Python/python.exe','--docs-python=C:/Docs Python/python.exe'],
  ]) {
    const r = run([...args,'--version'])
    assert.equal(r.status,0,r.stderr)
    assert.equal(r.stdout.trim(),'1.0.0')
  }
  const help = run(['--help'])
  assert.match(help.stdout,/--docs-python/)
  assert.doesNotMatch(help.stdout,/"command": "npx"/)
})

test('MCP entry rejects missing values and invalid bridge modes before starting', () => {
  for (const args of [
    ['--docs-python'],['--docs-python','--version'],['--docs-python='],
    ['--python='],['--workspace='],['--mode','invalid'],['--mode='],
  ]) {
    const r = run(args)
    assert.equal(r.status,2,JSON.stringify({args,...r}))
    assert.equal(r.stdout,'')
    assert.match(r.stderr,/needs a value|must not be empty|must be job or serve/)
  }
})
