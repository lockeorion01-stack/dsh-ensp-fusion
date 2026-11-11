import test from 'node:test'
import assert from 'node:assert/strict'
import { validateTopoConsolePorts, renumberComPorts, setComPort, parseTopo } from '../lib/topo.js'
const topo = (ports) => `<topo><devices>${ports.map((p, i) => `<dev id="${i}" name="R${i}" model="AR2220" com_port="${p}"/>`).join('')}</devices></topo>`
test('native topology rejects crash-inducing ports and duplicates but permits unassigned devices', () => {
  for (const p of ['10000', '22010', '65535', '-1', '2x', '1.5']) {
    assert.throws(() => validateTopoConsolePorts(topo([p])), /invalid com_port/)
  }
  assert.throws(() => validateTopoConsolePorts(topo([8000, 8000])), /duplicate/)
  validateTopoConsolePorts(topo([0, 0, 8000, 9999]))
  assert.throws(() => setComPort(topo([8000, 8001]), 'R0', 8001), /duplicate/)
})
test('port allocation reserves later devices and detects exhaustion', () => {
  const out = renumberComPorts(topo([0, 2000, 0, 2002]))
  assert.deepEqual(parseTopo(out.text).devices.map(d => d.comPort), [2001, 2000, 2003, 2002])
  assert.throws(() => renumberComPorts(topo([9999, 0]), { start: 9999 }), /no available/)
})
