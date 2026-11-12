import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { identifyCompatibility } from '../lib/compatibility.js'
import { parseLldp } from '../lib/network-analysis.js'

test('historical real device version fixtures identify only accepted model/version pairs', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/compatibility/versions.json', import.meta.url), 'utf8'))
  for (const fixture of fixtures) {
    assert.equal(identifyCompatibility(fixture.output).model, fixture.expected_model)
    const limitations=identifyCompatibility(fixture.output).observed_failures
    assert.equal(limitations.length,fixture.expected_model==='S5700'?1:0)
    if(limitations.length)assert.equal(limitations[0].status,'OBSERVED_FAIL')
    assert.equal(identifyCompatibility(fixture.output.replace(/V\d{3}R\d{3}C\d{2}/u, 'V999R999C99')).status, 'UNVERIFIED')
  }
  assert.equal(identifyCompatibility('VRP router').status, 'UNVERIFIED')
})

test('sanitized historical USG LLDP fixture distinguishes brief identity gaps from detail evidence', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/compatibility/usg-lldp.json', import.meta.url), 'utf8'))
  assert.equal(fixture.results.length, 2)
  assert.equal(parseLldp('FW', fixture.results[0].output).status, 'UNKNOWN')
  const detail = parseLldp('FW', fixture.results[1].output)
  assert.equal(detail.status, 'OK')
  assert.equal(detail.neighbors.length, 2)
})
