/**
 * Transport for the elevated eNSP bridge.
 *
 * eNSP runs elevated, so nothing at the caller's integrity level can drive its
 * windows (UIPI drops PostMessage/SetWindowPos with ERROR_ACCESS_DENIED).  The
 * bridge is therefore started through ``launch.py`` + ShellExecuteW("runas").
 *
 * Two transports:
 *   job   - one elevated process per batch of steps (~0.3 s fixed cost, then
 *           1-70 ms per step).  Always available, no daemon to babysit.
 *   serve - one long-lived elevated process, newline-delimited JSON over
 *           loopback TCP (~0 ms fixed cost).  Used when it can be kept alive.
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { checkControl, remainingTime } from './execution-control.js'

const controlOptions = opts => ({ control: opts?.operation?.control, signal: opts?.signal ?? opts?.operation?.signal, deadline: opts?.deadline ?? opts?.operation?.deadline })

const LAUNCH_TIMEOUT_MS = 30000

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fileExists(path) {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/**
 * Run a short-lived program and collect its output.
 *
 * Output goes through temporary files rather than stdio pipes: piped stdio is
 * unavailable inside some harness sandboxes (``spawn EPERM``), while plain file
 * descriptors always work and keep the child console-free.
 */
export async function runProcess(command, args, { timeoutMs = 15000, env = process.env, signal } = {}) {
  signal?.throwIfAborted()
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ensp-proc-'))
  if (signal?.aborted) { await rm(dir, { recursive: true, force: true }); signal.throwIfAborted() }
  const outPath = join(dir, 'out.txt')
  const errPath = join(dir, 'err.txt')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  const collect = async () => {
    let stdout = ''
    let stderr = ''
    try {
      stdout = await readFile(outPath, 'utf8')
    } catch {
      // no output file
    }
    try {
      stderr = await readFile(errPath, 'utf8')
    } catch {
      // no error file
    }
    await rm(dir, { recursive: true, force: true })
    return { stdout, stderr }
  }
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', outFd, errFd], windowsHide: true, env })
    } catch (error) {
      closeSync(outFd)
      closeSync(errFd)
      resolve(collect().then((io) => ({ code: -1, ...io, stderr: `${io.stderr}${String(error?.message ?? error)}` })))
      return
    }
    let settled = false, interrupted = false
    const finish = async (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancelled)
      closeSync(outFd)
      closeSync(errFd)
      try { resolve({ code: interrupted ? -1 : code, ...(await collect()) }) }
      catch (error) { reject(error) }
    }
    const stop = () => {
      interrupted = true
      try {
        child.kill()
      } catch {
        // already gone
      }
      // Wait for close before collecting output and removing its directory.
      // The child still owns inherited output handles until it has exited.
    }
    const timer = setTimeout(stop, timeoutMs)
    const cancelled = stop
    signal?.addEventListener('abort', cancelled, { once: true })
    if (signal?.aborted) cancelled()
    child.on('error', (error) => {
      try {
        writeFileSync(errPath, `${String(error?.message ?? error)}`, { flag: 'a' })
      } catch {
        // ignore
      }
      finish(-1)
    })
    child.on('close', (code) => { void finish(code ?? -1) })
  })
}

const PROBE_SCRIPT = [
  'import sys',
  'mods = {}',
  'for name in ("win32gui", "win32ui", "win32api", "win32process", "win32clipboard", "PIL"):',
  '    try:',
  '        __import__(name)',
  '        mods[name] = True',
  '    except Exception as exc:',
  '        mods[name] = str(exc)',
  'print(sys.executable)',
  'print(sys.version.split()[0])',
  'for key in sorted(mods):',
  '    print(key, mods[key])',
].join('\n')

/**
 * Guess where a pywin32-capable Python lives: the per-user installs first, then
 * machine-wide ones, newest version first so the probe stops early.
 */
export function discoverPythonCandidates() {
  const homes = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Python') : '',
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Python') : '',
    process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'], 'Python') : '',
    'C:/Python313', 'C:/Python312', 'C:/Python311',
  ].filter(Boolean)
  const found = []
  for (const home of homes) {
    let entries = []
    try {
      entries = readdirSync(home, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const dir = entry.isDirectory() ? join(home, entry.name) : home
      const exe = join(dir, 'python.exe')
      if (existsSync(exe)) found.push(exe)
    }
  }
  const unique = [...new Set(found.map((path) => path.replace(/\\/gu, '/')))]
  return unique.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
}

/**
 * Find a Python interpreter that has pywin32 + Pillow, and its pythonw sibling.
 * pythonw matters: it never flashes a console window during a batch.
 */
export async function resolveRuntime(config, cache, options = {}) {
  if (cache?.runtime) return cache.runtime
  const candidates = []
  for (const entry of [config.pythonExecutable, ...(config.pythonCandidates ?? []), ...discoverPythonCandidates()]) {
    if (typeof entry !== 'string' || entry.trim() === '') continue
    candidates.push(entry.trim())
  }
  const failures = []
  for (const exe of candidates) {
    checkControl(options)
    if (!exe.toLowerCase().endsWith('.exe') && !(await fileExists(exe))) {
      failures.push(`${exe}: not found`)
      continue
    }
    const result = await runProcess(exe, ['-c', PROBE_SCRIPT], { timeoutMs: remainingTime(options, 20000), signal: options.signal })
    checkControl(options)
    if (result.code !== 0) {
      failures.push(`${exe}: probe failed ${result.stderr.trim().slice(0, 160)}`)
      continue
    }
    const lines = result.stdout.trim().split(/\r?\n/u)
    const realExe = lines[0]?.trim() ?? exe
    const version = lines[1]?.trim() ?? ''
    const modules = {}
    for (const line of lines.slice(2)) {
      const [key, ...rest] = line.split(' ')
      modules[key] = rest.join(' ') === 'True'
    }
    const missing = Object.entries(modules).filter(([, ok]) => !ok).map(([key]) => key)
    if (missing.length > 0) {
      failures.push(`${exe}: missing ${missing.join(', ')}`)
      continue
    }
    const pythonw = realExe.replace(/python\.exe$/iu, 'pythonw.exe')
    const runtime = {
      python: realExe,
      pythonw: existsSync(pythonw) ? pythonw : realExe,
      version,
      modules,
    }
    if (cache) cache.runtime = runtime
    return runtime
  }
  const hint = 'Set pythonExecutable to a python.exe that can `import win32gui, win32ui, PIL`.'
  const tried = failures.length > 0 ? failures.join(' | ') : 'no candidate found'
  throw new Error(`dsh-ensp: no usable Python runtime for the GUI bridge (${tried}). ${hint}`)
}

export class Bridge {
  constructor(config, paths) {
    this.config = config
    this.paths = paths
    this.cache = {}
    this.serving = null
    this.starting = null
    this.tasks = new Map()
  }

  forOperation(operation) {
    if (!operation) return this
    const owner = this
    return new Proxy(this, { get(target, key) {
      if (key === 'steps' || key === 'request') return (value, opts = {}) => owner[key](value, { ...opts, operation })
      if (key === 'ping') return () => owner.ping({ operation })
      return Reflect.get(target, key, target)
    } })
  }

  async queryTask(taskId) {
    const ref = this.tasks.get(taskId)
    if (!ref) return { task_id: taskId, state: 'unknown', stop_confirmed: false }
    if (ref.transport === 'job') {
      try { return JSON.parse(await readFile(ref.result, 'utf8')) } catch { return { task_id: taskId, state: 'unknown', stop_confirmed: false, status_path: ref.status } }
    }
    return this.requestTo(ref.info, { op: 'task_status', task_id: taskId }, { timeoutMs: 500 })
  }

  async runtime(options) {
    return resolveRuntime(this.config, this.cache, options)
  }

  async workDir() {
    if (!this.cache.dir) this.cache.dir = await mkdtemp(join(tmpdir(), 'dsh-ensp-'))
    return this.cache.dir
  }

  /** Launch the bridge elevated and wait for the job result file. */
  async runJob(steps, { timeoutMs, stopOnError = false, operation, signal, deadline } = {}) {
    const options = controlOptions({ operation, signal, deadline })
    checkControl(options)
    const runtime = await this.runtime(options)
    checkControl(options)
    const dir = await this.workDir()
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const jobPath = join(dir, `job-${stamp}.json`)
    const resultPath = join(dir, `res-${stamp}.json`)
    const budget = remainingTime(options, Number(timeoutMs ?? this.config.timeoutMs ?? 180000))
    if (!Number.isFinite(budget) || budget <= 0) throw new Error('bridge timeout must be positive')
    const taskId = randomUUID(), cancelPath = join(dir, `cancel-${stamp}.json`), statusPath = join(dir, `status-${stamp}.json`)
    if (this.tasks.size >= 4096) throw new Error('bridge task reference capacity reached')
    this.tasks.set(taskId, { transport: 'job', result: resultPath, status: statusPath })
    operation?.control?.task({ task_id: taskId, transport: 'job', status_path: statusPath, result_path: resultPath })
    await writeFile(jobPath, JSON.stringify({ steps, result: resultPath, stop_on_error: stopOnError, operation_id: operation?.id,
      task_id: taskId, cancel_path: cancelPath, timeout_ms: budget, status: statusPath }), 'utf8')
    checkControl(options)
    const token = operation?.control?.dispatch()
    let cancelWrite
    const cancel = () => { cancelWrite ??= writeFile(cancelPath, JSON.stringify({ task_id: taskId }), { flag: 'wx' }).catch(() => {}) }
    options.signal?.addEventListener('abort', cancel, { once: true })
    let cancelledAt
    try {
    await operation?.event('dispatched', { phase: 'bridge-job', count: steps.length })
    const launched = await runProcess(runtime.python, [
      this.paths.launch, '--bridge', this.paths.bridge, '--python', runtime.pythonw, '--job', jobPath,
    ], { timeoutMs: remainingTime(options, 20000), signal: options.signal }).catch(error => {
      if (!options.signal?.aborted) throw error
      return { code: -1 }
    })
    if (launched.code !== 0 && !options.signal?.aborted) {
      throw new Error(`dsh-ensp: could not start the elevated bridge (UAC refused?). ${launched.stdout.trim()} ${launched.stderr.trim()}`.trim())
    }
    const expires = Date.now() + budget + 2000
    while (Date.now() < expires) {
      if (options.signal?.aborted) { cancel(); cancelledAt ??= Date.now(); if (Date.now() - cancelledAt >= 2000) break }
      if (await fileExists(resultPath)) {
        const raw = await readFile(resultPath, 'utf8')
        try {
          const parsed = JSON.parse(raw)
          if (parsed.uncertain === true || parsed.stop_confirmed === false) operation?.control?.unconfirmed()
          else operation?.control?.observe(token)
          await operation?.event('observed', { phase: 'bridge-job', pid: parsed.pid })
          if (!options.signal?.aborted) { await rm(jobPath, { force: true }); await rm(resultPath, { force: true }); this.tasks.delete(taskId) }
          return parsed
        } catch {
          // still being written
        }
      }
      await sleep(25)
    }
    operation?.control?.unconfirmed()
    throw new Error(`dsh-ensp: bridge batch timed out after ${budget} ms`)
    } finally { options.signal?.removeEventListener('abort', cancel); await cancelWrite }
  }

  /** One request/response over the resident bridge socket. */
  async request(payload, opts = {}) {
    checkControl(controlOptions(opts))
    const info = await this.ensureServing()
    return this.requestTo(info, payload, opts)
  }

  /** Talk to a specific resident, including before it has passed readiness. */
  async requestTo(info, payload, { timeoutMs = 120000, signal, onSent } = {}) {
    signal?.throwIfAborted()
    const message = `${JSON.stringify({ ...payload, token: info.token })}\n`
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: info.port })
      let buffer = ''
      let settled = false
      const finish = (error, response) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancelled)
        socket.destroy()
        if (error) {
          if (error.kind !== 'cancelled') info.healthy = false
          reject(error)
        } else {
          resolve(response)
        }
      }
      const timer = setTimeout(() => {
        finish(new Error('dsh-ensp: resident bridge request timed out'))
      }, timeoutMs)
      const cancelled = () => finish(Object.assign(new Error('resident request cancelled; task stop requires confirmation'), { kind: 'cancelled' }))
      signal?.addEventListener('abort', cancelled, { once: true })
      socket.setEncoding('utf8')
      socket.on('connect', () => {
        if (signal?.aborted) { cancelled(); return }
        onSent?.()
        socket.write(message)
      })
      socket.on('data', (chunk) => {
        buffer += chunk
        const index = buffer.indexOf('\n')
        if (index === -1) return
        const line = buffer.slice(0, index)
        try {
          finish(null, JSON.parse(line))
        } catch (error) {
          finish(error)
        }
      })
      socket.on('error', (error) => finish(error))
      const closed = () => finish(new Error('dsh-ensp: resident bridge socket closed before a complete response'))
      socket.on('end', closed)
      socket.on('close', closed)
    })
  }

  /** Start one resident process; separate from readiness for offline injection. */
  async launchResident() {
    const runtime = await this.runtime()
    const dir = await this.workDir()
    const port = 20000 + Math.floor(Math.random() * 20000)
    const token = Math.random().toString(36).slice(2)
    const logPath = join(dir, 'bridge.log')
    const started = await runProcess(runtime.python, [
      this.paths.launch, '--bridge', this.paths.bridge, '--python', runtime.pythonw,
      '--args', `--port ${port} --token ${token} --log "${logPath}"`,
    ], { timeoutMs: 20000 })
    if (started.code !== 0) throw new Error('dsh-ensp: could not start the resident bridge')
    return { port, token, logPath, healthy: false }
  }

  async ensureServing() {
    if (this.starting) return this.starting
    if (this.serving?.healthy) return this.serving
    this.starting = (async () => {
      const info = await this.launchResident()
      this.serving = info
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await sleep(100)
        try {
          const pong = await this.requestTo(info, { op: 'ping' }, { timeoutMs: 2000 })
          if (pong?.ok) {
            info.healthy = true
            info.info = pong
            return info
          }
        } catch {
          // not up yet
        }
      }
      throw new Error(`dsh-ensp: resident bridge did not answer on port ${info.port}`)
    })()
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  /** Use the configured transport; auto can fall back before any step is attempted. */
  async steps(steps, opts = {}) {
    const options = controlOptions(opts)
    checkControl(options)
    const mode = this.config.mode ?? 'auto'
    if (mode === 'job') return this.runJob(steps, opts)
    let attempted = false
    try {
      const results = []
      for (const [index, step] of steps.entries()) {
        checkControl(options)
        const startup = this.ensureServing()
        // Shared resident startup is harmless without a task. An aborted
        // waiter must not cancel other callers' startup or send its GUI step.
        const info = options.signal ? await new Promise((resolve, reject) => {
          const abort = () => { cleanup(); reject(opts.operation?.control?.error() ?? new Error('Bridge startup waiter cancelled')) }
          const cleanup = () => options.signal.removeEventListener('abort', abort)
          options.signal.addEventListener('abort', abort, { once: true })
          startup.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
          if (options.signal.aborted) abort()
        }) : await startup
        checkControl(options)
        // Even a lost first response may follow a completed mutation. Never replay it.
        attempted = true
        await opts.operation?.event('dispatched', { phase: 'bridge-resident', index })
        const taskId = randomUUID()
        if (this.tasks.size >= 4096) throw new Error('bridge task reference capacity reached')
        this.tasks.set(taskId, { transport: 'serve', info })
        const taskRef = { task_id: taskId, transport: 'serve', port: info.port }
        const token = opts.operation?.control?.dispatch()
        let payload
        try {
          payload = await this.requestTo(info, { ...step, operation_id: opts.operation?.id, task_id: taskId,
            timeout_ms: remainingTime(options, opts.timeoutMs ?? this.config.timeoutMs ?? 180000) },
          { timeoutMs: remainingTime(options, opts.timeoutMs ?? this.config.timeoutMs ?? 180000), signal: options.signal })
          if ((payload.task_id !== undefined && payload.task_id !== taskId) || payload.stop_confirmed === false || payload.uncertain === true) {
            throw new Error('resident task reply has no confirmed matching stop; inspect task state before retrying')
          }
          opts.operation?.control?.observe(token)
          this.tasks.delete(taskId)
        } catch (error) {
          opts.operation?.control?.task(taskRef)
          if (options.signal?.aborted) {
            let status
            const end = Date.now() + 2000
            try {
              status = await this.requestTo(info, { op: 'cancel_task', task_id: taskId }, { timeoutMs: 500 })
              while (status?.stop_confirmed !== true && Date.now() < end) {
                await sleep(50)
                status = await this.queryTask(taskId)
              }
            } catch {}
            if (status?.task_id === taskId && status.stop_confirmed === true) opts.operation?.control?.observe(token)
            else opts.operation?.control?.unconfirmed()
          } else opts.operation?.control?.unconfirmed()
          throw error
        }
        await opts.operation?.event('observed', { phase: 'bridge-resident', index })
        results.push({ ...payload, index, op: step.op })
        if (opts.stopOnError && payload.ok === false) break
        if (step.op === 'exit') this.serving = null
      }
      return { ok: results.every((result) => result.ok === true), steps: results, transport: 'serve' }
    } catch (error) {
      if (mode === 'serve' || attempted || options.signal?.aborted) throw error
      return this.runJob(steps, opts)
    }
  }

  async ping(opts = {}) {
    try {
      const result = await this.steps([{ op: 'ping' }], { ...opts, timeoutMs: 30000 })
      return { available: true, ...result.steps[0], transport: result.transport ?? 'job' }
    } catch (error) {
      return { available: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

export { LAUNCH_TIMEOUT_MS }
