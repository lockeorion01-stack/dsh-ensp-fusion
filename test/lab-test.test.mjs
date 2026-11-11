import test from 'node:test'
import assert from 'node:assert/strict'
import { validateLabPlan, runLabTest, renderLabReports } from '../lib/lab-test.js'

// Unit tests only: these injected executors do not contact eNSP or runOnDevice.
const command = (cmd = 'display version', expect = 'VRP', layer) => ({
  cmd, expect, ...(layer === undefined ? {} : { layer }),
})
const plan = (commands = [command()], extra = {}) => ({
  title: 'Acceptance', devices: [{ device: 'AR1', port: 2000, commands, ...extra }],
})
const success = (entry, outputs = entry.commands.map(() => 'VRP')) => ({
  ok: true,
  results: entry.commands.map((cmd, index) => ({ command: cmd, output: outputs[index], ok: true })),
  checks: entry.commands.map((cmd) => ({ command: cmd, pass: true, missing: [] })),
  notes: [],
})

test('validation retains topology_path and returns an independent normalized plan', () => {
  const input = { ...plan([command(' display version ', ['VRP'])], { passwords: ['one'] }),
    topology_path: '../topologies/lab.topo' }
  const before = structuredClone(input)
  const normalized = validateLabPlan(input)
  assert.equal(normalized.topology_path, input.topology_path)
  assert.equal(normalized.devices[0].commands[0].cmd, 'display version')
  assert.deepEqual(validateLabPlan(normalized), normalized)
  normalized.devices[0].commands[0].expect.push('extra')
  normalized.devices[0].passwords.push('two')
  assert.deepEqual(input, before)
})

test('valid full command words, layers, ports and explicit assertions', () => {
  for (const cmd of ['display current-configuration', 'DISPLAY version', 'ping -c 3 10.0.0.1', 'tracert 10.0.0.1']) {
    for (const layer of ['configuration', 'interface', 'routing', 'connectivity']) {
      const result = validateLabPlan(plan([command(cmd, ['UP', '/up/i', '/10\\.0\\.0\\.1/'], layer)]))
      assert.equal(result.devices[0].commands[0].layer, layer)
    }
  }
  assert.equal(validateLabPlan({ devices: [{ port: 1, commands: [command()] }] }).devices[0].port, 1)
  assert.equal(validateLabPlan({ devices: [{ device: 'AR1', commands: [command()] }] }).devices[0].device, 'AR1')
})

test('rejects invalid plans and unsafe options before execution', async (t) => {
  const invalid = [
    null, [], {}, { devices: [] }, { devices: new Array(1) },
    { devices: [{ commands: [command()] }] },
    { ...plan(), topology_path: 12 }, { ...plan(), title: ' ' },
    plan([], {}), plan(new Array(1)), plan(['display version']),
    plan([command()], { port: 0 }), plan([command()], { port: 65536 }),
    plan([command()], { port: '2000' }), plan([command()], { port: 1.5 }),
    plan([command()], { device: '' }), plan([command()], { username: 1 }),
    plan([command()], { password: [] }), plan([command()], { passwords: [''] }),
    plan([command()], { passwords: new Array(1) }), plan([command()], { new_password: true }),
    plan([command()], { command_timeout_ms: -1 }), plan([command()], { command_timeout_ms: 1.5 }),
    plan([command('display version', 'VRP', 'other')]),
  ]
  for (const flag of ['save', 'system_view', 'echo', 'echo_to_window', 'allow_cursor_takeover',
    'output_file', 'screenshot_out', 'systemView', 'mutating']) {
    invalid.push(plan([command()], { [flag]: true }))
    invalid.push({ ...plan(), [flag]: true })
    invalid.push(plan([{ ...command(), [flag]: true }]))
  }
  for (const [index, input] of invalid.entries()) {
    await t.test(`invalid shape ${index}`, async () => {
      let called = false
      assert.throws(() => validateLabPlan(input), TypeError)
      await assert.rejects(runLabTest(input, { runDevice: async () => { called = true } }), TypeError)
      assert.equal(called, false)
    })
  }
})

test('rejects abbreviations, command chaining, controls and file-writing pipes', () => {
  for (const cmd of ['dis version', 'displaying version', 'display-version', 'ping6 ::1', 'tracert6 ::1',
    'save', 'system-view', 'echo hello', 'quit', 'display;save', 'display version; save',
    'display version | save flash:/out', 'display version > flash:/out',
    'display diagnostic-information', 'display diagnostic-information flash:/out',
    'display version && save', 'display version `save`', 'display $(save)',
    'display\nversion', 'display version\r\nsave', 'display\tversion', 'display\0version',
    'display version\x1b', 'display version\x7f', 'display version\x85',
    'display\u2028version', 'display version\u2029save', 'display\u200b version']) {
    assert.throws(() => validateLabPlan(plan([command(cmd)])), TypeError, cmd)
  }
})

test('requires meaningful expectations and validates regex syntax and flags', () => {
  for (const expect of [undefined, null, '', '   ', [], [''], ['ok', ' '], [null], [[]],
    12, true, new Array(1), '//', '/[/', '/unclosed', '/ok/z', '/ok/ii', '/.*/', '/^$/', '/(?:)/']) {
    assert.throws(() => validateLabPlan(plan([{ ...command(), expect }])), TypeError)
  }
  const input = plan()
  delete input.devices[0].commands[0].expect
  assert.throws(() => validateLabPlan(input), TypeError)
})

test('validates later devices before calling any executor and requires injection', async () => {
  const input = plan()
  input.devices.push({ device: 'AR2', commands: [command('save')] })
  let calls = 0
  await assert.rejects(runLabTest(input, { runDevice: async () => { calls += 1 } }), TypeError)
  assert.equal(calls, 0)
  await assert.rejects(runLabTest(plan()), /runDevice/)
})

test('executor receives strings and aligned expectation arrays with mutation disabled', async () => {
  const input = { ...plan([
    command('display version', 'VRP', 'configuration'),
    command('ping 10.0.0.1', ['reply', '/ttl=64/i'], 'connectivity'),
  ], { username: 'operator', password: 'secret', passwords: ['secret2'], new_password: 'secret3',
    command_timeout_ms: 9000 }), topology_path: './lab.topo' }
  const original = structuredClone(input)
  const result = await runLabTest(input, { runDevice: async (entry) => {
    assert.deepEqual(entry, { device: 'AR1', port: 2000, username: 'operator', password: 'secret',
      passwords: ['secret2'], command_timeout_ms: 9000, commands: ['display version', 'ping 10.0.0.1'],
      expect: [['VRP'], ['reply', '/ttl=64/i']], save: false, system_view: false })
    const response = success(entry, ['Huawei VRP', 'REPLY ttl=64'])
    // A callback must not be able to mutate the original plan or its assertions.
    entry.expect[0][0] = 'changed'
    entry.passwords.push('changed')
    return response
  } })
  assert.deepEqual(input, original)
  assert.equal(result.ok, true)
  assert.deepEqual(result.counts, { total: 2, pass: 2, fail: 0, error: 0, skipped: 0 })
  assert.deepEqual(result.rows.map((row) => row.layer), ['configuration', 'connectivity'])
  assert.equal(new Date(result.timestamp).toISOString(), result.timestamp)
})

test('all devices run after mismatch, thrown error and skip', async () => {
  const input = { devices: ['good', 'mismatch', 'throws', 'skips', 'last'].map((device) => ({
    device, commands: [command()],
  })) }
  const called = []
  const result = await runLabTest(input, { runDevice: async (entry) => {
    called.push(entry.device)
    if (entry.device === 'throws') throw new Error('connection refused')
    if (entry.device === 'skips') return { ok: false, skipped: true, notes: ['not started'] }
    const response = success(entry)
    if (entry.device === 'mismatch') {
      response.ok = false
      response.results[0].output = 'not found'
      response.checks[0] = { command: entry.commands[0], pass: false, missing: ['VRP'] }
    }
    return response
  } })
  assert.deepEqual(called, input.devices.map((entry) => entry.device))
  assert.deepEqual(result.rows.map((row) => row.status), ['PASS', 'FAIL', 'ERROR', 'SKIPPED', 'PASS'])
  assert.deepEqual(result.counts, { total: 5, pass: 2, fail: 1, error: 1, skipped: 1 })
  assert.equal(result.ok, false)
  assert.match(result.rows[2].error, /connection refused/)
})

test('partial success or mismatch survives later rejection followed by SKIP checks', async () => {
  for (const earlierPass of [true, false]) {
    const input = plan([command('display version'), command('display interface'), command('display ip routing-table')])
    const result = await runLabTest(input, { runDevice: async (entry) => ({
      ok: false, failure: { command: entry.commands[1], message: 'command rejected' },
      results: [
        { command: entry.commands[0], output: earlierPass ? 'VRP' : 'other', ok: true },
        { command: entry.commands[1], output: 'Error: rejected', ok: false },
      ],
      checks: [
        { command: entry.commands[0], pass: earlierPass, missing: earlierPass ? [] : ['VRP'] },
        { command: entry.commands[1], pass: false, missing: [], status: 'ERROR' },
        { command: entry.commands[2], pass: false, missing: [], status: 'SKIP' },
      ],
    }) })
    assert.deepEqual(result.rows.map((row) => row.status), [earlierPass ? 'PASS' : 'FAIL', 'ERROR', 'SKIPPED'])
    assert.equal(result.devices[0].status, 'ERROR')
    assert.equal(result.counts.error, 1)
    assert.equal(result.counts.skipped, 1)
    const reports = renderLabReports(result)
    assert.deepEqual(JSON.parse(reports.json), result)
    assert.match(reports.markdown, /SKIPPED/)
  }
})

test('partial failure supports skipped-command lists and string diagnostics', async () => {
  for (const objectSkip of [false, true]) {
    const result = await runLabTest(plan([
      command('display version'), command('display interface'), command('ping 10.0.0.1'),
    ]), { runDevice: async (entry) => ({
      ok: false, failure: 'later command timed out',
      results: [{ command: entry.commands[0], output: 'VRP' }],
      checks: [{ command: entry.commands[0], pass: true, missing: [] }],
      skipped: [objectSkip ? { command: entry.commands[2] } : entry.commands[2]],
    }) })
    assert.deepEqual(result.rows.map((row) => row.status), ['PASS', 'ERROR', 'SKIPPED'])
    assert.match(result.rows[1].error, /timed out/)
  }
})

test('a named failing command stays ERROR even with an erroneous passing check', async () => {
  const result = await runLabTest(plan(), { runDevice: async (entry) => ({
    ...success(entry), ok: false, failure: { command: entry.commands[0], message: 'rejected' },
  }) })
  assert.equal(result.rows[0].status, 'ERROR')
})

test('command success alone, invalid checks, mismatched commands and aggregate failure cannot pass', async () => {
  for (const mutate of [
    (response) => { response.checks = [] },
    (response) => { delete response.checks[0].missing },
    (response) => { response.checks[0].pass = 'true' },
    (response) => { response.checks[0].command = 'display other' },
    (response) => { response.checks[0].status = 'unknown' },
    (response) => { response.results[0].command = 'display other' },
    (response) => { response.results[0].ok = false },
    (response) => { delete response.results[0].output },
    (response) => { response.ok = false },
    (response) => { response.failure = 'unexplained failure' },
  ]) {
    const result = await runLabTest(plan(), { runDevice: async (entry) => {
      const response = success(entry)
      mutate(response)
      return response
    } })
    assert.equal(result.ok, false)
    assert.equal(result.rows[0].status, 'ERROR')
  }
  for (const response of [null, undefined, [], 'unexpected']) {
    const result = await runLabTest(plan(), { runDevice: async () => response })
    assert.equal(result.rows[0].status, 'ERROR')
  }
})

test('assertion failures and contradictory pass checks remain FAIL', async () => {
  for (const mutate of [
    (response) => { response.checks[0].pass = false },
    (response) => { response.checks[0].status = 'FAIL' },
    (response) => { response.checks[0].missing = ['expected evidence'] },
    (response) => { response.results[0].output = 'does not match' },
  ]) {
    const result = await runLabTest(plan(), { runDevice: async (entry) => {
      const response = success(entry)
      mutate(response)
      return response
    } })
    assert.equal(result.rows[0].status, 'FAIL')
    assert.equal(result.ok, false)
  }
})

test('regex matching follows executor flags, resets global patterns, and requires every expectation', async () => {
  const result = await runLabTest(plan([
    command('display version', ['vrp', '/VRP/g']),
    command('display interface', ['/VRP/g']),
    command('display ip routing-table', ['VRP', '/up/']),
    command('ping 10.0.0.1', '/vrp/m'),
  ]), { runDevice: async (entry) => success(entry, ['VRP', 'VRP', 'VRP DOWN', 'VRP']) })
  assert.deepEqual(result.rows.map((row) => row.status), ['PASS', 'PASS', 'FAIL', 'FAIL'])
  assert.deepEqual(result.rows[2].missing, ['/up/'])
})

test('duplicate commands keep their index-aligned evidence', async () => {
  const result = await runLabTest(plan([command(), command()]), {
    runDevice: async (entry) => success(entry, ['VRP', 'DOWN']),
  })
  assert.deepEqual(result.rows.map((row) => row.status), ['PASS', 'FAIL'])
})

test('a trailing duplicate skip never overrides an earlier completed PASS or FAIL', async () => {
  for (const earlierPass of [true, false]) {
    for (const fullChecks of [true, false]) {
      for (const objectSkip of [true, false]) {
        const result = await runLabTest(plan([
          command('display version'), command('display invalid'), command('display version'),
        ]), { runDevice: async (entry) => ({
          ok: false,
          failure: { index: 1, command: entry.commands[1], message: 'rejected' },
          results: [
            { command: entry.commands[0], output: earlierPass ? 'VRP' : 'DOWN', ok: true },
            { command: entry.commands[1], output: 'rejected', ok: false },
          ],
          checks: [
            { command: entry.commands[0], pass: earlierPass, missing: earlierPass ? [] : ['VRP'] },
            ...(fullChecks ? [
              { command: entry.commands[1], pass: false, missing: [], status: 'ERROR' },
              { command: entry.commands[2], pass: false, missing: [], status: 'SKIP' },
            ] : []),
          ],
          skipped: [objectSkip ? { command: entry.commands[2] } : entry.commands[2]],
        }) })
        assert.deepEqual(result.rows.map((row) => row.status), [earlierPass ? 'PASS' : 'FAIL', 'ERROR', 'SKIPPED'])
        assert.deepEqual(result.counts, { total: 3, pass: earlierPass ? 1 : 0,
          fail: earlierPass ? 0 : 1, error: 1, skipped: 1 })
      }
    }
  }
})

test('a later failure of the same command is attributed by index or execution position', async () => {
  for (const indexed of [true, false]) {
    for (const failedOutput of [true, false]) {
      const result = await runLabTest(plan([command(), command(), command()]), {
        runDevice: async (entry) => ({
          ok: false,
          failure: { ...(indexed ? { index: 1 } : {}), command: entry.commands[1], message: 'timeout' },
          results: [
            { command: entry.commands[0], output: 'VRP', ok: true },
            ...(failedOutput ? [{ command: entry.commands[1], output: 'partial', ok: false }] : []),
          ],
          checks: [{ command: entry.commands[0], pass: true, missing: [] }],
          // No check or skipped list for the final command: it is after the
          // failed position and outside the executed prefix.
        }),
      })
      assert.deepEqual(result.rows.map((row) => row.status), ['PASS', 'ERROR', 'SKIPPED'])
      assert.equal(result.rows[0].actual, 'VRP')
      assert.match(result.rows[1].error, /timeout/)
      assert.equal(result.devices[0].status, 'ERROR')
    }
  }
})

test('zero-based failure and skip indexes distinguish repeated command occurrences', async () => {
  const result = await runLabTest(plan([command(), command(), command()]), {
    runDevice: async (entry) => ({
      ok: false, failure: { index: 0, command: entry.commands[0], message: 'rejected' },
      results: [{ command: entry.commands[0], output: 'VRP', ok: true }],
      checks: [{ command: entry.commands[0], pass: true, missing: [] }],
      skipped: [{ index: 1, command: entry.commands[1] }, 2],
    }),
  })
  assert.deepEqual(result.rows.map((row) => row.status), ['ERROR', 'SKIPPED', 'SKIPPED'])
  assert.deepEqual(result.counts, { total: 3, pass: 0, fail: 0, error: 1, skipped: 2 })
})

test('skipped metadata cannot replace output that lacks the required assertion check', async () => {
  const result = await runLabTest(plan([command(), command()]), {
    runDevice: async (entry) => ({
      ok: false,
      results: [{ command: entry.commands[0], output: 'VRP', ok: true }],
      checks: [], skipped: [entry.commands[1]],
    }),
  })
  assert.deepEqual(result.rows.map((row) => row.status), ['ERROR', 'SKIPPED'])
  assert.match(result.rows[0].error, /assertion check/)
})

test('connection failure has an ERROR row even when every command is marked skipped', async () => {
  for (const commandCount of [1, 3]) {
    for (const fullChecks of [true, false]) {
      const input = plan(Array.from({ length: commandCount }, () => command()))
      input.devices.push({ device: 'AR2', commands: [command()] })
      const called = []
      const result = await runLabTest(input, { runDevice: async (entry) => {
        called.push(entry.device)
        if (entry.device === 'AR2') return success(entry)
        return {
          ok: false, failure: { phase: 'connect', command: null, message: 'connection refused' },
          results: [],
          checks: fullChecks ? entry.commands.map((cmd) => ({
            command: cmd, pass: false, missing: [], status: 'SKIP',
          })) : [],
          skipped: [...entry.commands],
        }
      } })
      assert.deepEqual(called, ['AR1', 'AR2'])
      assert.equal(result.ok, false)
      assert.equal(result.devices[0].status, 'ERROR')
      assert.equal(result.devices[0].counts.error, 1)
      assert.equal(result.devices[1].status, 'PASS')
      assert.deepEqual(result.rows.map((row) => row.status), [
        'ERROR', ...Array(commandCount - 1).fill('SKIPPED'), 'PASS',
      ])
      assert.deepEqual(result.counts, { total: commandCount + 1, pass: 1, fail: 0,
        error: 1, skipped: commandCount - 1 })
      assert.match(result.rows[0].error, /connection refused/)
      const reports = renderLabReports(result)
      assert.equal(JSON.parse(reports.json).counts.error, 1)
      assert.match(reports.markdown, /ERROR: 1/)
      const [header, first] = parseCsv(reports.csv)
      assert.equal(first[header.indexOf('status')], 'ERROR')
      assert.equal(first[header.indexOf('error')], '1')
    }
  }
})

test('redacts all plan credentials, substrings and regex metacharacters across all reports', async () => {
  const secrets = ['TopSecret', 'TopSecretLong', 'p[a]ss.$', 'new/secret', 'quote"secret', 'operatorXYZ']
  const exposure = secrets.map((secret) => `prefix${secret}suffix`).join(' ')
  const input = { title: exposure, devices: [
    { device: exposure, commands: [command(`display ${exposure}`, exposure)],
      username: secrets[5], password: secrets[0], passwords: [secrets[1], secrets[2], secrets[4]],
      new_password: secrets[3] },
    { device: 'throws', commands: [command()] },
    { device: 'structured-error', commands: [command()] },
  ] }
  const result = await runLabTest(input, { runDevice: async (entry) => {
    assert.equal(Object.hasOwn(entry, 'new_password'), false)
    if (entry.device === 'throws') throw new Error(exposure)
    if (entry.device === 'structured-error') return { failure: { message: exposure }, ok: false }
    return { ...success(entry, [exposure]), notes: [exposure, { text: exposure }], password: exposure }
  } })
  assert.equal(result.rows[0].status, 'PASS')
  const reports = renderLabReports(result)
  for (const value of [JSON.stringify(result), ...Object.values(reports)]) {
    for (const secret of secrets) {
      assert.equal(value.includes(secret), false)
      assert.equal(value.includes(JSON.stringify(secret).slice(1, -1)), false)
    }
    assert.match(value, /REDACTED/)
  }
  assert.match(result.rows[0].actual, /prefix\[REDACTED\]suffix/)
  assert.equal(Object.hasOwn(result, 'password'), false)
})

test('validation diagnostics do not echo credentials or unsupported key names', () => {
  const input = plan([command('/secret-password')], { password: 'secret-password' })
  assert.throws(() => validateLabPlan(input), (error) => !error.message.includes('secret-password'))
  input.devices[0]['secret-password'] = true
  assert.throws(() => validateLabPlan(input), (error) => !error.message.includes('secret-password'))
})

// Minimal independent parser checks quoting and multiline CSV cell boundaries.
function parseCsv(text) {
  const rows = []
  let row = [], cell = '', quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1 }
      else quoted = !quoted
    } else if (char === ',' && !quoted) { row.push(cell); cell = '' }
    else if (char === '\r' && text[index + 1] === '\n' && !quoted) {
      row.push(cell); rows.push(row); row = []; cell = ''; index += 1
    } else cell += char
  }
  assert.equal(quoted, false)
  return rows
}

test('reports contain counts/timestamp and protect every CSV cell from formula injection', async () => {
  for (const prefix of ['=', '+', '-', '@', ' ', '\t', '\r', '\n', '\u00a0', '\ufeff']) {
    const value = `${prefix}SUM(1,2) "quoted"\nVRP | <script>alert(1)</script>`
    const input = { title: value, devices: [{ device: value, commands: [command('display version', value)] }] }
    const result = await runLabTest(input, { runDevice: async (entry) => ({
      ...success(entry, [value]), notes: [value],
    }) })
    const reports = renderLabReports(result)
    assert.deepEqual(Object.keys(reports).sort(), ['csv', 'json', 'markdown'])
    assert.deepEqual(JSON.parse(reports.json), result)
    assert.match(reports.markdown, /Total: 1; PASS: 1; FAIL: 0; ERROR: 0; SKIPPED: 0/)
    assert.ok(reports.markdown.includes(result.timestamp))
    assert.equal(reports.markdown.includes('<script>'), false)
    assert.ok(reports.markdown.includes('\\|'))
    const [header, data, ...rest] = parseCsv(reports.csv)
    assert.equal(rest.length, 0)
    assert.equal(header.length, data.length)
    const csvRow = Object.fromEntries(header.map((key, index) => [key, data[index]]))
    for (const key of ['title', 'device', 'expected', 'actual', 'notes']) assert.equal(csvRow[key], `'${value}`)
    assert.equal(csvRow.timestamp, result.timestamp)
    assert.equal(csvRow.total, '1')
    assert.equal(csvRow.pass, '1')
  }
})

test('CSV diagnostics and missing expectations also receive formula protection', async () => {
  const result = await runLabTest(plan(), { runDevice: async (entry) => ({
    ...success(entry), ok: false,
    checks: [{ command: entry.commands[0], pass: false, missing: ['=HYPERLINK("bad")'] }],
  }) })
  const [header, data] = parseCsv(renderLabReports(result).csv)
  assert.equal(data[header.indexOf('missing')], '\'=HYPERLINK("bad")')
  const failure = await runLabTest(plan(), { runDevice: async () => { throw new Error('@danger') } })
  const [errorHeader, errorData] = parseCsv(renderLabReports(failure).csv)
  assert.equal(errorData[errorHeader.indexOf('diagnostic')], "'@danger")
})
