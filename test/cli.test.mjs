import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import test from 'node:test'

import { VrpSession } from '../lib/cli.js'

// Every peer is a real ephemeral loopback TCP server, never an eNSP device.
// Scripts specify exactly which lines may be sent, including interactive input.
async function fixture(t, script, options = {}) {
  const sockets = new Set()
  const timers = new Set()
  const seen = []
  const negotiations = []
  const errors = []
  let cursor = 0
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.setNoDelay(true)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    let pending = Buffer.alloc(0)
    const send = (data, delay = 0) => {
      if (!delay) { socket.write(data); return }
      const timer = setTimeout(() => { timers.delete(timer); if (!socket.destroyed) socket.write(data) }, delay)
      timers.add(timer)
    }
    const accept = (line) => {
      seen.push(line)
      const step = script[cursor++]
      if (!step || step[0] !== line) {
        errors.push(`expected ${JSON.stringify(step?.[0])}, received ${JSON.stringify(line)}`)
        return
      }
      if (typeof step[1] === 'function') step[1]({ socket, send, seen })
      else if (step[1] != null) send(step[1])
    }
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length) {
        if (pending[0] === 255) {
          if (pending.length < 3) break
          negotiations.push([...pending.subarray(0, 3)])
          pending = pending.subarray(3)
        } else if (pending[0] === 32 && script[cursor]?.[0] === ' ') {
          pending = pending.subarray(1)
          accept(' ')
        } else {
          const end = pending.indexOf(13)
          if (end < 0) break
          const line = pending.subarray(0, end).toString('utf8')
          pending = pending.subarray(end + 1)
          accept(line)
        }
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const session = new VrpSession({ port: server.address().port, commandTimeoutMs: 600, ...options })
  t.after(async () => {
    session.close()
    for (const timer of timers) clearTimeout(timer)
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
    assert.deepEqual(errors, [], 'no speculative or skipped command may reach the peer')
    assert.equal(cursor, script.length, 'all scripted exchanges completed')
  })
  return { session, seen, negotiations }
}

test('HRP prefix and native dated syslogs preserve prompt completion',async t=>{
  const {session}=await fixture(t,[['','HRP_M<FW-01>'],['system-view','system-view\r\nHRP_M[FW-01]'],['display clock','display clock\r\n13:00\r\nHRP_M[FW-01]\r\nNov 11 2026 13:00:00-08:00 FW-01 DS/4/DATASYNC_CFGCHANGE:OID test']]);
  assert.equal((await session.open()).prompt,'<FW-01>');
  assert.equal((await session.command('system-view')).prompt,'[FW-01]');
  assert.equal((await session.command('display clock')).ok,true);
});

test('password-only login sends only the supplied password and reaches a prompt', async (t) => {
  const { session, seen } = await fixture(t, [
    ['', 'Password:'], ['secret-A', '\r\n<R1>'], ['display clock', 'display clock\r\n12:00\r\n<R1>'],
  ], { password: 'secret-A' })
  assert.equal((await session.open()).prompt, '<R1>')
  assert.equal((await session.command('display clock')).output, '12:00')
  assert.deepEqual(seen, ['', 'secret-A', 'display clock'])
})

test('AAA login waits through a split authentication header', async (t) => {
  const { session } = await fixture(t, [
    ['', ({ send }) => { send('Login authentication'); send('\r\nUsername:', 60) }],
    ['admin', 'Password:'], ['secret-A', '\r\n<R1>'],
  ], { username: 'admin', password: 'secret-A' })
  assert.equal((await session.open()).prompt, '<R1>')
})

test('password-only retry uses the next candidate without an extra blank response', async (t) => {
  const { session } = await fixture(t, [
    ['', 'Password:'], ['wrong-A', 'Authentication failed\r\nPassword:'], ['right-B', '\r\n<R1>'],
  ], { passwords: ['wrong-A', 'right-B'] })
  await session.open()
  assert.equal(session.passwordUsed, 'right-B')
})

test('authentication rejection redacts all candidates from message and evidence', async (t) => {
  const secrets = ['wrong-A', 'wrong-B']
  const { session } = await fixture(t, [
    ['', 'Password:'], ['wrong-A', 'Authentication failed wrong-A\r\nPassword:'],
    ['wrong-B', 'Authentication failed wrong-A wrong-B\r\nPassword:'],
  ], { passwords: secrets })
  await assert.rejects(session.open(), (error) => {
    assert.equal(error.kind, 'authentication')
    assert.match(error.message, /2 attempt/)
    for (const secret of secrets) assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes(secret))
    assert.match(error.output, /REDACTED/)
    return true
  })
})

test('authentication timeout also redacts echoed secrets', async (t) => {
  const { session } = await fixture(t, [
    ['', 'Password:'], ['secret-A', 'echo secret-A without a final prompt'],
  ], { password: 'secret-A', commandTimeoutMs: 120 })
  await assert.rejects(session.open(), (error) => {
    assert.match(error.message, /timed out/)
    assert.ok(!`${error.message}${error.output}`.includes('secret-A'))
    return true
  })
})

test('required password change remains an actionable error', async (t) => {
  const { session } = await fixture(t, [
    ['', 'Username:'], ['admin', 'Password:'], ['old-A', 'Change now? [Y/N]:'],
  ], { username: 'admin', password: 'old-A' })
  await assert.rejects(session.open(), /pass new_password/)
})

test('forced password change handles old/new/confirm/press-enter dialogue', async (t) => {
  const { session } = await fixture(t, [
    ['', 'Username:'], ['admin', 'Password:'], ['old-A', 'Change now? [Y/N]:'],
    ['Y', 'Old password:'], ['old-A', 'New password:'], ['new-B', 'Confirm new password:'],
    ['new-B', 'Please Press ENTER.'], ['', '\r\n<USG>'],
  ], { username: 'admin', password: 'old-A', newPassword: 'new-B' })
  assert.equal((await session.open()).prompt, '<USG>')
})

test('idle console wake uses the new login prompt', async (t) => {
  const { session } = await fixture(t, [
    ['', 'Configuration console time out, please press any key to log on'],
    ['', 'Password:'], ['secret-A', '\r\n<R1>'],
  ], { password: 'secret-A' })
  assert.equal((await session.open()).prompt, '<R1>')
})

test('syslog tails, numeric tokens and confirmations do not complete a command', async (t) => {
  const { session } = await fixture(t, [
    ['', '<R1>'],
    ['display status', ({ send }) => {
      send('display status\r\n%%01CFM/4/SAVE(l)[0]\r\n[0]\r\n[Y/N]\r\ntext <R1>\r\n<R1]\r\n')
      send('finished\r\n<R1>', 100)
    }],
  ])
  await session.open()
  const record = await session.command('display status')
  assert.equal(record.ok, true)
  assert.equal(record.prompt, '<R1>')
  assert.match(record.output, /finished/)
})

test('ANSI prompt plus asynchronous log in the same receive completes', async (t) => {
  const { session } = await fixture(t, [
    ['', '\x1b[32m<R1>\x1b[0m'],
    ['display clock', 'display clock\r\n12:00\r\n\x1b[32m<R1>\x1b[0m\r\n%%01LOG/4/EVENT[0]'],
  ])
  await session.open()
  const record = await session.command('display clock')
  assert.equal(record.ok, true)
  assert.equal(record.prompt, '<R1>')
  assert.match(record.output, /12:00/)
})

test('split Telnet negotiation and subnegotiation preserve prompt text', async (t) => {
  const { session, negotiations } = await fixture(t, [
    ['', ({ send }) => {
      send(Buffer.from([255]))
      send(Buffer.from([251]), 10)
      send(Buffer.from([1, 255, 253]), 20)
      send(Buffer.from([3, 255, 250, 24, 1, 255]), 30)
      send(Buffer.from([255, 65, 255]), 40)
      send(Buffer.concat([Buffer.from([240, 255, 241]), Buffer.from('<R1>')]), 50)
    }],
  ])
  assert.equal((await session.open()).prompt, '<R1>')
  assert.deepEqual(negotiations, [[255, 254, 1], [255, 252, 3]])
})

test('paging preserves Unicode text and sends one space per marker', async (t) => {
  const { session } = await fixture(t, [
    ['', '<R1>'], ['display current-configuration', 'display current-configuration\r\n配置一\r\n---- More ----'],
    [' ', '\r\n配置二\r\n---- More ----'], [' ', '\r\n配置三\r\n<R1>'],
  ])
  await session.open()
  const record = await session.command('display current-configuration')
  for (const text of ['配置一', '配置二', '配置三']) assert.ok(record.output.includes(text))
  assert.ok(!record.output.includes('More'))
})

test('syslog-redrawn prompt inside a paged configuration does not end the command', async (t) => {
  const { session } = await fixture(t, [
    ['', '<R1>'],
    ['display current-configuration', ({ send }) => {
      send('display current-configuration\r\n<R1>\r\n#\r\n sysname R1\r\n')
      send('---- More ----', 100)
    }],
    [' ', '\r\ninterface GigabitEthernet0/0/0\r\n ip address 10.0.13.1 255.255.255.0\r\nreturn\r\n<R1>'],
    ['display clock', 'display clock\r\n12:00\r\n<R1>'],
  ])
  await session.open()
  const config = await session.command('display current-configuration')
  assert.match(config.output, /ip address 10\.0\.13\.1/)
  assert.equal((await session.command('display clock')).ok, true)
})

test('run separates setup from user results and preserves positional assertions', async (t) => {
  const { session } = await fixture(t, [
    ['', '<R1>'], ['system-view', 'system-view\r\nEnter system view\r\n[R1]'],
    ['display clock', 'display clock\r\n12:00\r\n[R1]'],
  ])
  await session.open()
  const result = await session.run(['display clock'], { systemView: true })
  assert.equal(result.ok, true)
  assert.equal(result.failure, null)
  assert.deepEqual(result.skipped, [])
  assert.deepEqual(result.results.map((row) => row.command), ['display clock'])
  assert.equal(result.results[0].output, '12:00')
  assert.deepEqual(result.setupResults.map((row) => row.command), ['system-view'])
})

test('CLI rejection stops the batch and records completed, failed and skipped work', async (t) => {
  const { session } = await fixture(t, [
    ['', '<R1>'], ['first', 'first\r\nOK\r\n<R1>'], ['bad', 'bad\r\nError: Unrecognized command\r\n<R1>'],
  ])
  await session.open()
  const result = await session.run(['first', 'bad', 'never-send'])
  assert.equal(result.ok, false)
  assert.deepEqual(result.results.map((row) => row.ok), [true, false])
  assert.deepEqual(result.skipped, ['never-send'])
  assert.equal(result.failure.index, 1)
  assert.equal(result.failure.phase, 'command')
  assert.equal(result.failure.kind, 'cli')
  assert.match(result.failure.output, /Unrecognized/)
})

test('setup rejection prevents all user commands', async (t) => {
  const { session } = await fixture(t, [
    ['', '<R1>'], ['system-view', 'Error: Permission denied\r\n<R1>'],
  ])
  await session.open()
  const result = await session.run(['sysname R2'], { systemView: true })
  assert.equal(result.ok, false)
  assert.deepEqual(result.results, [])
  assert.equal(result.setupResults[0].ok, false)
  assert.equal(result.failure.phase, 'setup')
  assert.equal(result.failure.index, null)
  assert.deepEqual(result.skipped, ['sysname R2'])
})

test('transport EOF returns a failed record with partial evidence and skips the tail', async (t) => {
  const { session } = await fixture(t, [
    ['', '<R1>'], ['first', 'OK\r\n<R1>'], ['broken', ({ socket }) => socket.end('partial evidence')],
  ])
  await session.open()
  const result = await session.run(['first', 'broken', 'never-send'])
  assert.equal(result.ok, false)
  assert.equal(result.failure.kind, 'transport')
  assert.equal(result.results[1].ok, false)
  assert.match(result.results[1].output, /partial evidence/)
  assert.deepEqual(result.skipped, ['never-send'])
})

test('transport timeout returns structured failure and invalidates the connection', async (t) => {
  const { session } = await fixture(t, [
    ['', '<R1>'], ['slow', 'unfinished output'],
  ], { commandTimeoutMs: 120 })
  await session.open()
  const result = await session.run(['slow', 'never-send'])
  assert.equal(result.failure.kind, 'transport')
  assert.match(result.failure.message, /timed out/)
  assert.match(result.failure.output, /unfinished/)
  assert.deepEqual(result.skipped, ['never-send'])
  assert.equal(session.closed, true)
  await assert.rejects(session.command('later'), /not connected/)
})

test('invalid commands reject the whole batch before setup or user writes', async (t) => {
  const { session, seen } = await fixture(t, [['', '<R1>']])
  await session.open()
  for (const invalid of ['', '  ', 'one\ntwo', 'one\rtwo', 'one\0two', 'one\u2028two', null, 42]) {
    await assert.rejects(session.run(['valid', invalid], { systemView: true }), /single-line/)
    await assert.rejects(session.command(invalid), /single-line/)
  }
  await assert.rejects(session.run([]), /non-empty array/)
  await assert.rejects(session.run(new Array(2)), /single-line/)
  assert.deepEqual(seen, [''])
})

test('a direct rejected command returns ok:false without throwing', async (t) => {
  const { session } = await fixture(t, [
    ['', '<R1>'], ['bad', 'Error: Unrecognized command\r\n<R1>'],
  ])
  await session.open()
  const record = await session.command('bad')
  assert.equal(record.ok, false)
  assert.equal(record.error.kind, 'cli')
})

test('reopening the same session is not closed by the old socket callback', async (t) => {
  const { session } = await fixture(t, [
    ['', '<R1>'], ['', '<R1>'], ['display clock', '12:00\r\n<R1>'],
  ])
  await session.open()
  await session.open()
  assert.equal((await session.command('display clock')).ok, true)
})

test('duplicate prompts are drained before the next command response', async (t) => {
  const { session } = await fixture(t, [
    ['', '<R1>'],
    ['first', ({ send }) => { send('first output\r\n<R1>'); send('\r\n<R1>', 20) }],
    ['second', ({ send }) => send('second output\r\n<R1>', 90)],
  ])
  await session.open()
  const result = await session.run(['first', 'second'])
  assert.equal(result.ok, true)
  assert.match(result.results[1].output, /second output/)
})

test('save answers delayed confirmation and filename prompts, then waits for completion', async (t) => {
  const { session } = await fixture(t, [
    ['', '[R1]'], ['return', '\r\n<R1>'],
    ['save', ({ send }) => { send('save\r\nPreparing...'); send('\r\nAre you sure to continue? (y/n)[n]:', 80) }],
    ['Y', 'Please input the file name(*.cfg,*.zip)[vrpcfg.zip]:'],
    ['', ({ send }) => { send('Configuration file had been saved successfully\r\n'); send('<R1>', 80) }],
  ])
  await session.open()
  const result = await session.save({ timeoutMs: 800 })
  assert.equal(result.ok, true)
  assert.equal(result.prompt, '<R1>')
  assert.deepEqual(result.results.map((row) => row.command), ['save'])
  assert.deepEqual(result.setupResults.map((row) => row.command), ['return'])
  assert.equal(result.results[0].ok, true)
})

test('save handles syslogs arriving after confirmation and filename questions', async (t) => {
  const log = '\r\nNov 11 2026 13:59:42-08:00 R1 %%01CFM/4/SAVE(l)[52]:The user chose Y when deciding whether to save the configuration to the device.'
  const { session } = await fixture(t, [
    ['', '<R1>'],
    ['save', 'Are you sure to continue?[Y/N]' + log],
    ['Y', 'Info: Please input the file name ( *.cfg, *.zip ) [vrpcfg.zip]:' + log],
    ['', 'Save the configuration successfully.\r\n<R1>'],
  ])
  await session.open()
  const result = await session.save({ timeoutMs: 1000 })
  assert.equal(result.ok, true)
  assert.match(result.results[0].output, /%%01CFM/)
})

test('exact save command routes through the dialogue and returns one user result', async (t) => {
  const { session } = await fixture(t, [
    ['', '<R1>'], ['save', 'Are you sure to continue?[Y/N]'],
    ['Y', 'Save the configuration successfully.\r\n<R1>'],
  ])
  await session.open()
  const result = await session.run(['save'])
  assert.equal(result.ok, true)
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].command, 'save')
})

test('non-interactive save sends no speculative confirmation', async (t) => {
  const { session } = await fixture(t, [
    ['', '<R1>'], ['save', 'Info: Save the configuration successfully.\r\n<R1>'],
  ])
  await session.open()
  assert.equal((await session.save({ timeoutMs: 300 })).ok, true)
})

test('save rejects a final prompt without a save-specific success message', async (t) => {
  const { session } = await fixture(t, [
    ['', '<R1>'], ['save', 'Connection established successfully.\r\n<R1>'],
  ])
  await session.open()
  await assert.rejects(session.save({ timeoutMs: 300 }), (error) => {
    assert.match(error.message, /without confirmed success/)
    assert.match(error.output, /Connection established/)
    return true
  })
})

test('save success text without a final prompt fails with retained evidence', async (t) => {
  const { session } = await fixture(t, [
    ['', '<R1>'], ['save', 'Save the configuration successfully.\r\n'],
  ])
  await session.open()
  await assert.rejects(session.save({ timeoutMs: 120 }), (error) => {
    assert.match(error.message, /timed out/)
    assert.match(error.output, /Save the configuration successfully/)
    return true
  })
})

test('save rejection through run becomes a structured failure and stops the batch', async (t) => {
  const { session } = await fixture(t, [
    ['', '<R1>'], ['save', 'Error: Not enough disk space\r\n<R1>'],
  ])
  await session.open()
  const result = await session.run(['save', 'never-send'])
  assert.equal(result.ok, false)
  assert.equal(result.failure.kind, 'save')
  assert.match(result.failure.output, /Not enough disk space/)
  assert.deepEqual(result.skipped, ['never-send'])
})

test('save does not execute after return is rejected', async (t) => {
  const { session } = await fixture(t, [
    ['', '[R1]'], ['return', 'Error: Permission denied\r\n[R1]'],
  ])
  await session.open()
  await assert.rejects(session.save({ timeoutMs: 300 }), (error) => {
    assert.match(error.message, /enter user view/)
    assert.match(error.output, /Permission denied/)
    return true
  })
})

test('save uses one deadline across dialogue steps', async (t) => {
  const { session } = await fixture(t, [
    ['', '<R1>'],
    ['save', ({ send }) => send('Continue?[Y/N]:', 80)],
    ['Y', ({ send }) => send('Save the configuration successfully.\r\n<R1>', 180)],
  ])
  await session.open()
  await assert.rejects(session.save({ timeoutMs: 180 }), /timed out/)
})

test('save repetition is bounded and never reports unconfirmed success', async (t) => {
  const { session } = await fixture(t, [
    ['', '<R1>'], ['save', 'Continue?[Y/N]:'],
    ...Array.from({ length: 8 }, () => ['Y', 'Continue?[Y/N]:']),
  ])
  await session.open()
  await assert.rejects(session.save({ timeoutMs: 600 }), /interaction limit/)
})

 test('save recognizes AC6005 has-been success followed by activation note', async (t) => {
 const {session}=await fixture(t, [['','<AC1>'],['save','Are you sure to continue? (y/n)[n]:'],['Y','Configuration file has been saved successfully\r\nNote: The configuration file will take effect after being activated\r\n<AC1>']]);
 await session.open(); assert.equal((await session.save()).ok,true);
 });
