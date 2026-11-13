import { writeFile } from 'node:fs/promises'
import { VrpSession } from './cli.js'
import { createChangeJournal } from './change-journal.js'
import { createRedactor, credentialValues, redactValue } from './redaction.js'
import { makeRecoveryGuard, verifyRecoveryGuard } from './recovery-guard.js'

const READ_ONLY_COMMAND = /^(display\b|dis\s|ping\b|tracert\b|dir\b|more\b|save\b|screen-length\b|system-view\b|quit\b|return\b|undo\s+terminal\b|terminal\b|reset\s+counters\b|refresh\b)/iu

export function isReadOnlyCommand(line) {
  const text = String(line ?? '').trim()
  return text === '' || READ_ONLY_COMMAND.test(text)
}

export function matchExpect(output, pattern) {
  const text = String(output ?? '')
  const slash = /^\/(.*)\/([a-z]*)$/u.exec(pattern)
  if (slash) {
    try {
      return new RegExp(slash[1], slash[2] || 'i').test(text)
    } catch (error) {
      return false
    }
  }
  return text.toLowerCase().includes(pattern.toLowerCase())
}


export function createDeviceRunner({ resolveWorkspacePath, prepareOutput, ensureDeviceWindow }) {
  return async function runOnDevice(entry, { devices, exec, config, bridge, echoArgs, changeRoot }) {
    const notes = []
    const deviceName = entry.device
    let port = entry.port
    if (port !== undefined && port !== null && port !== '' && Number(port) <= 0) {
      throw new Error(`port 必须是正整数（收到 ${JSON.stringify(port)}）；不指定端口时用 device + topology_path 自动解析。`)
    }
    if (!port) {
      if (!deviceName || !devices) throw new Error('provide port, or device + topology_path')
      if (String(deviceName).includes(',') || String(deviceName).includes('，')) {
        throw new Error(`device 只接受一个设备名（收到“${deviceName}”）；要给多台设备下发，请用 devices:[{device, commands}, …]。`)
      }
      const device = devices.find((item) => item.name.toLowerCase() === String(deviceName).toLowerCase())
      if (!device) throw new Error(`device "${deviceName}" is not in the topology`)
      if (!device.comPort) throw new Error(`device "${deviceName}" has no console port (it never started)`)
      port = device.comPort
    }
    const rawCommands = Array.isArray(entry.commands) ? entry.commands : []
    const expectList = Array.isArray(entry.expect) ? entry.expect : []
    const specs = rawCommands.map((item, index) => (typeof item === 'string'
      ? { cmd: item, expect: expectList[index] || null }
      : { cmd: String(item?.cmd ?? ''), expect: item?.expect ?? expectList[index] ?? null }))
      .filter((spec) => spec.cmd.length > 0)
    const commands = specs.map((spec) => spec.cmd)
    const session = new VrpSession({
      port,
      username: entry.username,
      password: entry.password,
      passwords: entry.passwords,
      newPassword: entry.new_password,
      commandTimeoutMs: entry.command_timeout_ms,
    })
    let prompt = ''
    let results = []
    let saved
    let checks = []
    let ok = true
    let failure
    let skipped = []
    let setupResults = []
    let phase = 'connect'
    let saveAttempted = false
    let journal
    const journalResults = [], journalSetup = []
    let beforeConfiguration = ''
    let identityVersion = ''
    let recoveryVerified
    try {
      if (changeRoot) {
        journal = createChangeJournal(changeRoot, entry, text => session.redact(text))
        journal.event('started')
      }
      const opened = await session.open().catch((error) => {
        if (/authentication failed|wrong password/iu.test(error.message)) {
          throw Object.assign(new Error(`${error.message}｜仅使用用户提供或已核实的凭据，不猜测口令；可通过 credential_file 引用。`), { kind: error.kind ?? 'authentication', output: error.output ?? '' })
        }
        throw error
      })
      prompt = opened.prompt
      if (journal) {
        phase = 'snapshot-before'
        const snapshot = await session.command('display current-configuration')
        if (!snapshot.ok || !snapshot.output?.trim()) throw new Error('Prechange snapshot failed; no planned commands sent')
        beforeConfiguration = snapshot.output
        journal.snapshot('before', snapshot.output)
        const identity = await session.command('display version')
        if (!identity.ok) throw new Error('Device identity collection failed; no planned commands sent')
        identityVersion = identity.output
        makeRecoveryGuard(beforeConfiguration, identityVersion)
        if (entry.recovery_of) {
          phase = 'recovery-preconditions'
          recoveryVerified = verifyRecoveryGuard(entry.recovery_guard, beforeConfiguration, identityVersion)
          journal.event('recovery-verified', recoveryVerified)
        }
        journal.event('prepared')
      }
      phase = 'commands'
      const ran = await session.run(commands, { systemView: entry.system_view === true, confirmLldpDisable: entry.confirm_lldp_disable === true,
        commandOptions: entry.command_options ?? [],
        beforeCommand: journal ? data => journal.event('command-started', data) : undefined,
        afterCommand: journal ? data => {
          const { phase: commandPhase, index, ...record } = data
          const target = commandPhase === 'setup' ? journalSetup : journalResults
          target.push(record)
          journal.event('command-finished', data)
        } : undefined })
      prompt = ran.prompt
      results = ran.results
      setupResults = ran.setupResults ?? []
      failure = ran.failure ?? undefined
      skipped = ran.skipped ?? []
      checks = []
      for (let index = 0; index < specs.length; index += 1) {
        const spec = specs[index]
        if (!spec.expect) continue
        const result = results[index]
        const output = result?.output ?? ''
        const patterns = (Array.isArray(spec.expect) ? spec.expect : [spec.expect])
          .flat()
          .filter((item) => item !== null && item !== undefined && String(item).length > 0)
        const missing = patterns.filter((pattern) => !matchExpect(output, String(pattern)))
        checks.push({ command: spec.cmd, pass: Boolean(result) && result.ok !== false && missing.length === 0, missing,
          status: !result ? 'SKIP' : (result.ok === false ? 'ERROR' : (missing.length ? 'FAIL' : 'PASS')) })
      }
      ok = ran.ok !== false && checks.every((check) => check.pass)
      const mutating = commands.some((line) => !isReadOnlyCommand(String(line)))
      const wantSave = entry.save === false ? false : (entry.save === true ? true : mutating)
      const explicitSave = /^save$/iu.test(commands.at(-1) ?? '') && results.at(-1)?.ok === true
      if (explicitSave && ok) {
        saved = { performed: true, ok: true, output: results.at(-1).output }
      } else if (wantSave && ok) {
        phase = 'save'
        journal?.event('save-started')
        saveAttempted = true
        const done = await session.save()
        prompt = done.prompt
        results = [...results, ...done.results]
        const last = done.results[done.results.length - 1] ?? {}
        const saveOk = done.ok !== false && /successfully|had been saved|已保存|保存成功/iu.test(last.output ?? '')
        saved = { performed: true, ok: saveOk, output: last.output ?? '' }
        ok = ok && saveOk
        if (!saveOk) notes.push(`${deviceName}: 保存结果未确认，请检查 display saved-configuration 或 dir。`)
      } else {
        saved = { performed: false, reason: !ok ? 'batch-failed' : (entry.save === false ? 'disabled-by-args' : 'read-only batch') }
      }
    } catch (error) {
      ok = false
      failure = { phase, kind: error.kind ?? 'transport', command: phase === 'save' ? 'save' : null, message: error.message, output: error.output ?? '', outcome: 'unconfirmed' }
      saved = { performed: saveAttempted, ok: false, output: error.output ?? '', reason: 'failed-or-unconfirmed' }
      notes.push(error.message)
      if (journal) {
        results = journalResults
        setupResults = journalSetup
        skipped = commands.slice(results.length)
      }
      if (!results.length) skipped = [...commands]
    } finally {
      try {
        if (journal) {
          // Keep the device lock until final evidence is collected. If the
          // transport is lost, preserve uncertainty instead of reconnecting.
          if (!session.closed && session.socket && beforeConfiguration) {
            const after = await session.command('display current-configuration')
            if (!after.ok || !after.output?.trim()) throw new Error('Postchange snapshot failed')
            journal.snapshot('after', after.output)
            journal.guard(makeRecoveryGuard(after.output, identityVersion))
            const beforeLines = new Set(beforeConfiguration.split('\n'))
            const afterLines = new Set(after.output.split('\n'))
            journal.event('configuration-diff', { added: [...afterLines].filter(line => !beforeLines.has(line)), removed: [...beforeLines].filter(line => !afterLines.has(line)) })
          }
          journal.event('finished', { ok, saved, failure, skipped })
        }
      } catch (error) {
        ok = false
        notes.push(`Change journal incomplete: ${error.message}`)
        failure ??= { phase: 'journal', message: error.message, outcome: 'unconfirmed' }
        if (error.output) {
          try { journal?.snapshot('after-partial', error.output) } catch { /* preserve existing evidence */ }
        }
        try {
          journal?.event('evidence-failed', { message: error.message })
          journal?.event('finished', { ok: false, saved, failure, skipped, evidence_incomplete: true })
        } catch { /* retain existing durable events */ }
      } finally { session.close() }
    }
    if (!ok && commands.some((line) => !isReadOnlyCommand(line))) notes.push('部分配置可能已生效；失败不会自动回滚，请先检查设备状态再重试。')

    let echo
    let screenshot
    let artifactError
    if (ok && echoArgs && echoArgs.echo_to_window) {
      try {
        if (!deviceName) throw new Error('echo_to_window needs device so the window can be found')
        if (!echoArgs.allow_cursor_takeover) {
          notes.push('回显需要打开设备窗口（会短暂接管鼠标并还原）。')
        }
        const opened = await ensureDeviceWindow(bridge, config, devices, deviceName, { settle: 1.1 })
        if (!opened.open) {
          throw new Error(opened.needsTopology
            ? `设备窗口「${deviceName}」没有显示：回显需要 topology_path 才能双击图标打开它。`
            : `设备窗口「${deviceName}」打不开（试过 ${opened.tried} 个图标位置）。`)
        }
        // Real keystrokes, guarded: refuse rather than leak them into another app.
        //
        // The line must end with "\n": bridge type_text maps "\n" to VK_RETURN and
        // deliberately skips "\r", so a "\r" terminator types the command but never
        // submits it — the text then sits in the input buffer and the screenshot
        // shows no output at all.
        // A device console that idled for a while logs out and shows
        // "press any key to log on" — the first keystroke only wakes it. Activate the
        // window and send a bare Enter first, otherwise the first command is eaten.
        const steps = [
          { op: 'activate', title: deviceName },
          { op: 'safetype', title: deviceName, text: '\n', per_char: 0.02 },
          { op: 'sleep', t: 0.5 },
        ]
        for (const line of commands) {
          // 0.02 s/char drops the odd space on slower consoles (AR); 0.05 is safe.
          steps.push({ op: 'safetype', title: deviceName, text: `${line}\n`, per_char: 0.05 })
          steps.push({ op: 'sleep', t: Number(echoArgs.echo_gap_ms ?? 900) / 1000 })
        }
        steps.push({ op: 'sleep', t: Number(echoArgs.echo_settle_ms ?? 1800) / 1000 })
        if (echoArgs.screenshot_out) {
          const out = await resolveWorkspacePath(echoArgs.screenshot_out, exec, config, { kind: 'screenshot_out' })
          await prepareOutput(out, true, 'screenshot_out')
          // Re-activate right before the capture: an occluded console window keeps a
          // stale device context and the PNG then shows the previous screen.
          steps.push({ op: 'activate', title: deviceName })
          steps.push({ op: 'sleep', t: 0.2 })
          steps.push({ op: 'shot', title: deviceName, out })
          screenshot = out
        }
        const echoed = await bridge.steps(steps)
        const failures = echoed.steps.filter((step) => !step.ok)
        echo = {
          window: opened.method,
          typed: echoed.steps.filter((step) => step.op === 'safetype' && step.ok).length,
          reexecutes: true,
        }
        if (failures.length > 0) {
          ok = false
          artifactError = { phase: 'echo', message: failures[0].error }
          notes.push(`回显失败 ${failures.length} 步：${failures[0].error}`)
        }
      } catch (error) {
        ok = false
        artifactError = { phase: 'echo', message: error.message }
        notes.push(`GUI evidence failed; console results are retained: ${error.message}`)
      }
    }

    let transcript
    if (entry.output_file) {
      try {
        const out = await resolveWorkspacePath(entry.output_file, exec, config, { kind: 'output_file' })
        await prepareOutput(out, true, 'output_file')
        const body = results.map((row) => `### ${row.command}\n${row.output ?? ''}`).join('\n\n')
        await writeFile(out, createRedactor(credentialValues(entry))(`${body}\n`), 'utf8')
        transcript = out
      } catch (error) {
        ok = false
        artifactError = { phase: 'transcript', message: error.message }
        notes.push(`Transcript write failed; device execution results are retained: ${error.message}`)
      }
    }

    return redactValue({ device: deviceName, port, prompt, results, setupResults, failure, skipped, artifactError, echo, screenshot, transcript, saved, checks, ok, notes, recovery_verified: recoveryVerified, change_journal: journal?.path }, createRedactor(credentialValues(entry)))
  }
}
