import { VrpSession } from './cli.js'
import { performance } from 'node:perf_hooks'
import { classifyConsoleFailure } from './console-diagnostics.js'
import { checkControl, controlledDelay, remainingTime } from './execution-control.js'

/** A listening socket is transport evidence, never proof of VRP readiness.
 * Probe a prompt and a real read-only command. Never change passwords or save.
 */
export async function waitDevicesReady(devices, { timeoutMs = 120000, sessionFactory = options => new VrpSession(options), ...options } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('ready timeout must be positive')
  if (!Array.isArray(devices) || devices.some(device => !device || typeof device.name !== 'string' || !Number.isInteger(device.comPort) || device.comPort < 1 || device.comPort > 65535)
      || new Set(devices.map(device => device.comPort)).size !== devices.length) throw new TypeError('readiness devices require names and unique console ports')
  const deadline = performance.now() + timeoutMs
  const states = devices.map(device => ({ device: device.name, port: device.comPort, ready: false, state: 'pending', attempts: 0 }))
  let retryDelay = 400
  while (performance.now() < deadline && states.some(s => !s.ready && s.retryable !== false)) {
    checkControl(options)
    for (const [i, state] of states.entries()) {
      if (state.ready || state.retryable === false) continue
      checkControl(options)
      const remaining = Math.min(deadline - performance.now(), remainingTime(options, timeoutMs))
      if (remaining <= 0) break
      const target = devices[i]
      const budget = Math.min(3000, Math.max(1, Math.floor(remaining / 2)))
      const session = sessionFactory({ ...options, port: target.comPort, username: target.username, password: target.password,
        connectTimeoutMs: Math.min(budget, 700), commandTimeoutMs: budget })
      state.attempts++
      let timer, expired = false, abort
      try {
        const response = await Promise.race([
          (async () => {
            await session.open()
            checkControl(options)
            if (expired) throw Error('readiness probe already expired; no command sent')
            return session.command('display version', { timeoutMs: budget })
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => {
            expired = true
            session.close()
            reject(new Error('readiness deadline exceeded'))
          }, Math.min(remaining, 2 * budget)) }),
          new Promise((_, reject) => {
            abort = () => { expired = true; session.close(); reject(options.control?.error() ?? Error('readiness cancelled')) }
            options.signal?.addEventListener('abort', abort, { once: true })
            if (options.signal?.aborted) abort()
          }),
        ])
        if (response.ok && /Versatile Routing Platform|\bVRP\b/iu.test(response.output)) {
          Object.assign(state, { ready: true, state: 'ready', prompt: response.prompt })
          delete state.error
        } else Object.assign(state, { state: 'not_vrp', retryable: false,
          action: 'Inspect console identity and native evidence before another probe; no automatic replay.',
          error: 'display version did not confirm VRP' })
      } catch (error) {
        checkControl(options)
        // An invalid credential is terminal for this probe; do not cause lockout
        // by retrying it every poll. Return only a classification, no banners.
        Object.assign(state, { ...classifyConsoleFailure(error),
          error: error.kind === 'authentication' ? 'provide console credentials; password changes are not performed by readiness probes' : 'console did not complete a prompt and display version' })
      } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); session.close() }
    }
    if (states.some(s => !s.ready && s.retryable !== false) && performance.now() < deadline) {
      await controlledDelay(Math.min(retryDelay, deadline - performance.now()), options)
      retryDelay = Math.min(2000, retryDelay * 2)
    }
  }
  return { ok: states.every(s => s.ready), devices: states }
}
