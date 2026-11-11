/**
 * Minimal VRP console client over TCP.
 *
 * eNSP exposes each started device's console on 127.0.0.1:<com_port> (the port
 * saved in the .topo file).  Talking to it directly is ~200x faster than
 * clicking through the GUI and is unaffected by window focus, so it is the
 * default command channel; the GUI is only used when the screenshot must show
 * the console window itself.
 *
 * Handled here: telnet IAC negotiation, ``---- More ----`` paging, optional
 * AAA login, per-command prompt matching, and prompt-style tracking so
 * ``system-view`` is entered before config commands when asked.
 */

import { createConnection } from 'node:net'

const IAC = 255
const DONT = 254
const DO = 253
const WONT = 252
const WILL = 251
const SB = 250
const SE = 240

// Match a whole terminal line, with balanced delimiters. In particular, neither
// a syslog suffix [0] nor an interactive [Y/N] is a device prompt.
const PROMPT = /^(?:<([\p{L}][\p{L}\p{N}_.:/-]{0,127})>|\[([~*]?[\p{L}][\p{L}\p{N}_.:/-]{0,127})\])$/u
const MORE = /-{2,}[ \t]*More[ \t]*-{2,}\s*$/iu
const USERNAME = /(?:^|\n)[ \t]*(?:Username|Login):[ \t]*$/iu
const PASSWORD = /(?:^|\n)[ \t]*Password:[ \t]*$/iu
const LOGIN_HEADER = /Login authentication\s*$/iu
const LOGIN_FAILED = /authentication failed|login failed|wrong password|bad passwords|Error:\s*(?:username or password|password)/iu
const WAKE = /press any key to log on|console time(?:d)? out/iu
const CLI_ERROR = /^\s*(?:Error\s*[:：]|错误\s*[:：]|%\s*(?:Error|Unrecognized|Unknown|Incomplete|Ambiguous|Invalid)\b|(?:Unrecognized|Unknown|Incomplete|Ambiguous|Invalid)\s+command\b)/imu
const PROMPT_SETTLE_MS = 50
/** A USG that still has the factory password forces a change on first login. */
const PASSWORD_CHANGE = /Change now\?\s*\[\s*Y\s*\/\s*N\s*\]\s*:?\s*$/iu
/** Firewall consoles park here once the user interface is handed over. */
const PRESS_ENTER = /Please Press ENTER\.?\s*$/iu
/** ``save`` asks "Are you sure to continue? (y/n)[n]:" or "... [Y/N]:" — both must be answered. */
const SAVE_CONFIRM = /(?:\[\s*y\s*\/\s*n\s*\]|\(\s*y\s*\/\s*n\s*\))(?:\s*\[\s*[yn]\s*\])?\s*[:：]?\s*$/iu
/** S5700 asks for the file name after the confirmation. */
const SAVE_FILENAME = /(?:Please\s+(?:input|enter)\s+(?:the\s+)?file\s*name|请输入文件名)[^\r\n]*[:：]\s*$/iu
const SAVE_SUCCESS = /^\s*(?:Info\s*:\s*)?(?:Save\s+(?:the\s+)?(?:current\s+)?configuration\s+successfully|(?:The\s+)?(?:current\s+)?configuration\s+(?:was\s+|has\s+been\s+)?saved\s+(?:to\s+the\s+device\s+)?successfully|Configuration\s+file\s+(?:had|has)\s+been\s+saved\s+successfully|Successfully\s+saved\s+(?:the\s+)?(?:current\s+)?configuration|配置(?:文件)?保存成功)[.!。]?\s*$/imu

// Asynchronous VRP logs can follow a save question in the same TCP packet.
// Ignore only trailing recognized syslog lines for dialogue matching, while
// retaining the complete original output for evidence and success checks.
function saveQuestion(text) {
  const lines = text.split('\n')
  while (lines.length) {
    const last = lines.at(-1).trim()
    if (!last || /^%%/u.test(last)
      || /^(?:\*?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{4}\b|\d{4}-\d{2}-\d{2}\b).*(?:%%|\b[A-Z][A-Z0-9_]*\/[0-7]\/[A-Z0-9_]+:)/iu.test(last)) lines.pop()
    else break
  }
  return lines.join('\n')
}

function cleanText(buffer) {
  return buffer
    .toString('utf8')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u0000/gu, '')
    .replace(/\r\n/gu, '\n')
    .replace(/\r/gu, '\n')
}

function findPrompt(text) {
  for (const line of text.split('\n').reverse()) {
    const candidate = line.trim().replace(/^HRP_[MS]\s*/u, '')
    const match = PROMPT.exec(candidate)
    if (match && !/^(?:y|n|y\/n|yes\/no)$/iu.test(match[1] ?? match[2])) return candidate
    // VRP can redraw a prompt in the middle of paged output when a syslog
    // arrives. Only actual trailing syslogs may follow a completed prompt.
    if (candidate && !/^%%/u.test(candidate)
      && !/^(?:\*?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{4}\b|\d{4}-\d{2}-\d{2}\b).*(?:%%|\b[A-Z][A-Z0-9_]*\/[0-7]\/[A-Z0-9_]+:)/iu.test(candidate)) return ''
  }
  return ''
}

function validateLine(line) {
  if (typeof line !== 'string' || !line.trim() || /[\r\n\u0000\u2028\u2029]/u.test(line)) {
    throw new TypeError('each command must be a non-empty single-line string without CR, LF or NUL')
  }
  return line.trim()
}

function timeoutBudget(value) {
  const budget = Number(value)
  if (!Number.isFinite(budget) || budget <= 0) throw new RangeError('timeout must be a positive finite number')
  return budget
}

export class VrpSession {
  constructor(options = {}) {
    this.host = options.host ?? '127.0.0.1'
    this.port = Number(options.port)
    this.username = options.username ?? ''
    const given = options.passwords
    const candidates = Array.isArray(given) && given.length > 0
      ? given.filter((item) => typeof item === 'string' && item.length > 0)
      : (options.password ? [options.password] : [])
    this.passwords = candidates
    this.password = candidates[0] ?? ''
    this.newPassword = options.newPassword ?? ''
    this.commandTimeoutMs = timeoutBudget(options.commandTimeoutMs ?? 20000)
    this.connectTimeoutMs = timeoutBudget(options.connectTimeoutMs ?? 4000)
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.collected = ''
    this.prompt = ''
    this.log = []
    this.closed = false
    this.transportError = null
    this.iacState = 'data'
    this.iacCommand = null
    this.lastDataAt = 0
  }

  redact(text) {
    let result = String(text ?? '')
    const secrets = [...this.passwords, this.password, this.newPassword].filter(Boolean)
      .sort((a, b) => b.length - a.length)
    for (const secret of secrets) result = result.split(secret).join('[REDACTED]')
    return result
  }

  failure(message, kind = 'transport', output = '') {
    const error = new Error(this.redact(message))
    error.kind = kind
    error.output = this.redact(output)
    return error
  }

  // Keep Telnet framing state across TCP chunks; refuse options we do not
  // implement. Subnegotiation and two-byte commands must not eat console text.
  receive(chunk) {
    const bytes = []
    for (const byte of chunk) {
      if (this.iacState === 'data') {
        if (byte === IAC) this.iacState = 'iac'
        else bytes.push(byte)
      } else if (this.iacState === 'iac') {
        if (byte === IAC) {
          bytes.push(byte)
          this.iacState = 'data'
        } else if (byte === SB) this.iacState = 'sub'
        else if ([DO, DONT, WILL, WONT].includes(byte)) {
          this.iacCommand = byte
          this.iacState = 'option'
        } else this.iacState = 'data'
      } else if (this.iacState === 'option') {
        if (this.iacCommand === DO || this.iacCommand === WILL) {
          this.socket.write(Buffer.from([IAC, this.iacCommand === DO ? WONT : DONT, byte]))
        }
        this.iacState = 'data'
      } else if (this.iacState === 'sub') {
        if (byte === IAC) this.iacState = 'sub-iac'
      } else {
        this.iacState = byte === SE ? 'data' : 'sub'
      }
    }
    if (bytes.length) {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(bytes)])
      this.lastDataAt = performance.now()
    }
  }

  writeLine(line) {
    if (!this.socket || this.closed || this.transportError) {
      throw this.failure('telnet session is not connected')
    }
    // A CR is sufficient for VRP. A following LF can answer the next dialogue
    // with an unintended blank line, especially during save and authentication.
    this.socket.write(`${line}\r`)
  }

  async open() {
    this.close()
    this.closed = false
    this.transportError = null
    this.buffer = Buffer.alloc(0)
    this.collected = ''
    this.prompt = ''
    this.iacState = 'data'
    try {
      await new Promise((resolve, reject) => {
        const socket = createConnection({ host: this.host, port: this.port })
        this.socket = socket
        const timer = setTimeout(() => {
          socket.destroy()
          reject(new Error(`telnet connect timeout to ${this.host}:${this.port}`))
        }, this.connectTimeoutMs)
        socket.once('connect', () => {
          clearTimeout(timer)
          resolve()
        })
        socket.on('error', (error) => {
          clearTimeout(timer)
          if (this.socket === socket) this.transportError = error
          reject(new Error(`telnet ${this.host}:${this.port} failed: ${error.message}`))
        })
        socket.on('data', (chunk) => { if (this.socket === socket) this.receive(chunk) })
        socket.once('close', () => {
          clearTimeout(timer)
          if (this.socket === socket) this.closed = true
          reject(new Error('telnet session closed by device'))
        })
      })
      this.writeLine('')
      let banner = ''
      for (let round = 0; round < 6; round += 1) {
        const ready = await this.waitFor(
          (text) => findPrompt(text) || USERNAME.test(text) || PASSWORD.test(text)
            || LOGIN_HEADER.test(text) || WAKE.test(text) || PRESS_ENTER.test(text),
          this.commandTimeoutMs,
        )
        banner += ready.output
        if (findPrompt(ready.output)) return { banner, prompt: this.prompt }
        if (WAKE.test(ready.output) || PRESS_ENTER.test(ready.output)) {
          this.writeLine('')
          continue
        }
        await this.loginIfNeeded(ready.output)
        return { banner, prompt: this.prompt }
      }
      throw this.failure('login did not reach a prompt', 'authentication', banner)
    } catch (error) {
      this.close()
      throw this.failure(error.message, error.kind ?? 'transport', error.output ?? '')
    }
  }

  async loginIfNeeded(loginText = '') {
    let text = loginText || cleanText(this.buffer)
    if (LOGIN_HEADER.test(text)) {
      text = (await this.waitFor((value) => USERNAME.test(value) || PASSWORD.test(value), this.commandTimeoutMs)).output
    }
    if (!USERNAME.test(text) && !PASSWORD.test(text)) return
    if (!this.passwords.length) throw this.failure('device asks for a password but no credentials were provided', 'authentication')
    const candidates = this.passwords.length > 0 ? this.passwords : [this.password]
    let lastError = null
    for (let index = 0; index < candidates.length; index += 1) {
      this.password = candidates[index]
      try {
        await this.authenticate(text)
        this.passwordUsed = this.password
        return
      } catch (error) {
        lastError = error
        if (!error.retryable) throw error
        if (index + 1 >= candidates.length) break
        text = error.output
        if (!USERNAME.test(text) && !PASSWORD.test(text)) {
          text = (await this.waitFor((value) => USERNAME.test(value) || PASSWORD.test(value), this.commandTimeoutMs)).output
        }
      }
    }
    throw this.failure(`console authentication failed after ${candidates.length} attempt(s)`, 'authentication', lastError?.output)
  }

  async authenticate(loginText = 'Username:') {
    if (USERNAME.test(loginText)) {
      if (!this.username) throw this.failure('device asks for a username but no credentials were provided', 'authentication')
      this.writeLine(this.username)
      await this.waitFor((text) => PASSWORD.test(text), this.commandTimeoutMs)
    }
    this.writeLine(this.password)
    // The firewall may answer with one more interactive step before the prompt:
    // "The password needs to be changed. Change now? [Y/N]:" and then
    // "Please Press ENTER."  Handle both, and treat a second "Username:" as a
    // wrong password instead of waiting for the device's own timer.
    for (let round = 0; round < 4; round += 1) {
      const step = await this.waitFor(
        (text) => findPrompt(text) || USERNAME.test(text) || PASSWORD.test(text)
          || LOGIN_FAILED.test(text) || LOGIN_HEADER.test(text)
          || PASSWORD_CHANGE.test(text) || PRESS_ENTER.test(text),
        this.commandTimeoutMs,
      )
      const now = step.output
      if (PASSWORD_CHANGE.test(now)) {
        if (!this.newPassword) {
          // Answering "N" on a USG drops the console back to "Login authentication",
          // so refusing is not an option: ask the caller for a new password.
          throw this.failure('device forces a password change on first login; pass new_password to accept it', 'authentication', now)
        }
        this.writeLine('Y')
        await this.waitFor((text) => /old password:\s*$/iu.test(text), this.commandTimeoutMs)
        this.writeLine(this.password)
        await this.waitFor((text) => /new password:\s*$/iu.test(text), this.commandTimeoutMs)
        this.writeLine(this.newPassword)
        await this.waitFor((text) => /confirm new password:\s*$/iu.test(text), this.commandTimeoutMs)
        this.writeLine(this.newPassword)
        this.password = this.newPassword
        continue
      }
      if (PRESS_ENTER.test(now)) {
        this.writeLine('')
        continue
      }
      if (USERNAME.test(now) || PASSWORD.test(now) || LOGIN_HEADER.test(now) || LOGIN_FAILED.test(now)) {
        const error = this.failure('console authentication failed', 'authentication', now)
        error.retryable = true
        throw error
      }
      if (findPrompt(now)) return
    }
    throw this.failure('login did not reach a prompt', 'authentication')
  }

  /** Wait until ``ready()`` is true, answering paging prompts on the way. */
  async waitFor(ready, timeoutMs) {
    const deadline = performance.now() + timeoutBudget(timeoutMs)
    let answered = 0
    while (performance.now() < deadline) {
      const text = cleanText(this.buffer)
      const more = MORE.exec(text)
      if (more) {
        if (answered >= 400) throw this.failure('paging limit exceeded', 'transport', this.collected + text)
        if (this.closed || this.transportError) throw this.failure('telnet session closed while paging', 'transport', this.collected + text)
        this.collected += text.slice(0, more.index)
        this.buffer = Buffer.alloc(0)
        this.socket.write(' ')
        answered += 1
        await sleep(40)
        continue
      }
      if (ready(text)) {
        const prompt = findPrompt(text)
        if (prompt && !this.closed && performance.now() - this.lastDataAt < PROMPT_SETTLE_MS) {
          await sleep(10)
          continue
        }
        const cleaned = this.collected + text
        this.collected = ''
        this.buffer = Buffer.alloc(0)
        if (prompt) this.prompt = prompt
        return { output: cleaned, prompt: this.prompt }
      }
      if (this.closed || this.transportError) {
        throw this.failure(`telnet session closed by device${this.transportError ? `: ${this.transportError.message}` : ''}`, 'transport', this.collected + text)
      }
      await sleep(25)
    }
    const partial = this.collected + cleanText(this.buffer)
    this.collected = ''
    this.buffer = Buffer.alloc(0)
    // A late response must never be attributed to a subsequent command.
    this.close()
    throw this.failure(`command timed out after ${timeoutMs} ms; partial output: ${this.redact(partial).slice(-300)}`, 'transport', partial)
  }

  async command(line, { timeoutMs } = {}) {
    line = validateLine(line)
    const budget = timeoutBudget(timeoutMs ?? this.commandTimeoutMs)
    if (/^save$/iu.test(line)) {
      const saved = await this.save({ timeoutMs: budget })
      return { ...saved.results.at(-1), command: line }
    }
    let result
    try {
      // Discard idle output already received before this command. Prompt settling
      // in waitFor also absorbs closely spaced duplicate device prompts.
      this.buffer = Buffer.alloc(0)
      this.collected = ''
      this.writeLine(line)
      result = await this.waitFor((text) => findPrompt(text), budget)
    } catch (error) {
      this.close()
      throw this.failure(error.message, error.kind ?? 'transport', error.output ?? '')
    }
    const output = tidy(result.output, line)
    const ok = !CLI_ERROR.test(output)
    const entry = { command: line, output, prompt: result.prompt, ok }
    if (!ok) entry.error = { kind: 'cli', message: 'device rejected command' }
    this.log.push(entry)
    return entry
  }

  /**
   * Run sequentially and stop on the first failure. results contains only user
   * commands (including the failed attempt); setupResults holds system-view.
   * failure is null or {phase, index, command, kind, message, output}; index is
   * zero-based for user commands and null for setup. skipped contains unsent
   * user command strings. Only invalid input throws from this batch API.
   */
  async run(commands, { systemView = false } = {}) {
    if (!Array.isArray(commands) || commands.length === 0) throw new TypeError('commands must be a non-empty array')
    // Validate the complete batch before sending even its setup command.
    const lines = Array.from(commands, validateLine)
    const results = []
    const setupResults = []
    let failure = null
    const attempt = async (command, phase, index, target) => {
      let record
      try {
        record = await this.command(command)
      } catch (error) {
        record = { command, output: this.redact(error.output ?? ''), prompt: this.prompt, ok: false,
          error: { kind: error.kind ?? 'transport', message: this.redact(error.message) } }
        this.log.push(record)
      }
      target.push(record)
      if (!record.ok) {
        failure = { phase, index, command, kind: record.error.kind, message: record.error.message, output: this.redact(record.output) }
        return false
      }
      return true
    }
    if (systemView && !/^\[/u.test(this.prompt)) {
      await attempt('system-view', 'setup', null, setupResults)
    }
    if (!failure) {
      for (const [index, line] of lines.entries()) {
        if (!await attempt(line, 'command', index, results)) break
      }
    }
    return { ok: failure === null, prompt: this.prompt, results, setupResults, failure,
      skipped: lines.slice(results.length) }
  }

  /**
   * Write the running configuration to flash (``save`` in user view).
   *
   * Lab work is expected to survive a device restart, so this is the default
   * finishing move after any configuration change; pass ``save: false`` when the
   * user explicitly wants a throw-away experiment.  A device left in
   * system-view is returned first, because ``save`` only exists in user view.
   */
  async save({ timeoutMs } = {}) {
    const budget = timeoutBudget(timeoutMs ?? Math.max(this.commandTimeoutMs, 60000))
    const deadline = performance.now() + budget
    const setupResults = []
    let output = ''
    try {
      if (/^\[/u.test(this.prompt)) {
        const returned = await this.command('return', { timeoutMs: budget })
        setupResults.push(returned)
        if (!returned.ok || !/^</u.test(returned.prompt)) {
          throw this.failure('save failed to enter user view', 'save', returned.output)
        }
      }
      if (performance.now() >= deadline) throw this.failure('save dialogue timed out during setup', 'save')
      this.buffer = Buffer.alloc(0)
      this.collected = ''
      this.writeLine('save')
      for (let round = 0; round < 9; round += 1) {
        const remaining = deadline - performance.now()
        if (remaining <= 0) throw this.failure('save dialogue timed out', 'save')
        const step = await this.waitFor(
          (text) => SAVE_FILENAME.test(saveQuestion(text)) || SAVE_CONFIRM.test(saveQuestion(text)) || findPrompt(text) || CLI_ERROR.test(text),
          remaining,
        )
        output += step.output
        if (CLI_ERROR.test(step.output)) throw this.failure('device rejected save', 'save')
        const success = SAVE_SUCCESS.exec(output)
        if (success && findPrompt(output.slice(success.index + success[0].length))) {
          const entry = { command: 'save', output: tidy(output, 'save'), prompt: this.prompt, ok: true }
          this.log.push(entry)
          return { ok: true, prompt: this.prompt, results: [entry], setupResults }
        }
        if (findPrompt(step.output)) throw this.failure('save returned a prompt without confirmed success', 'save')
        if (round === 8) throw this.failure('save dialogue exceeded interaction limit', 'save')
        this.writeLine(SAVE_FILENAME.test(saveQuestion(step.output)) ? '' : 'Y')
        output += '\n'
      }
    } catch (error) {
      // An incomplete dialogue leaves the console in an unknown input state.
      this.close()
      const evidence = this.redact(output + (error.output ?? ''))
      throw this.failure(`save failed: ${error.message}; partial output: ${evidence.slice(-300)}`, error.kind ?? 'save', evidence)
    }
  }

  close() {
    try {
      this.socket?.destroy()
    } catch {
      // ignore
    }
    this.socket = null
    this.closed = true
  }
}

/** Remove the echoed command line and trailing prompt from raw output. */
function tidy(output, command) {
  const lines = output.split('\n')
  while (lines.length && !lines[0].trim()) lines.shift()
  if (lines[0]?.trim() === command) lines.shift()
  while (lines.length && !lines.at(-1).trim()) lines.pop()
  if (lines.length && findPrompt(lines.at(-1))) lines.pop()
  return lines.join('\n').trimEnd()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Quick reachability probe for a console port. */
export function probePort(port, { host = '127.0.0.1', timeoutMs = 700 } = {}) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: Number(port) })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve({ port: Number(port), open: false, reason: 'timeout' })
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve({ port: Number(port), open: true })
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      resolve({ port: Number(port), open: false, reason: error.code ?? error.message })
    })
  })
}

