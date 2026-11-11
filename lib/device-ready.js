import { VrpSession } from './cli.js'

/** A listening socket is transport evidence, never proof of VRP readiness.
 * Probe a prompt and a real read-only command. Never change passwords or save.
 */
export async function waitDevicesReady(devices, { timeoutMs = 120000, sessionFactory = options => new VrpSession(options) } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('ready timeout must be positive')
  const deadline = Date.now() + timeoutMs
  const states = devices.map(device => ({ device: device.name, port: device.comPort, ready: false, state: 'pending' }))
  while (Date.now() < deadline && states.some(s => !s.ready && s.state !== 'authentication_required')) {
    for (const [i, state] of states.entries()) {
      if (state.ready || state.state === 'authentication_required') continue
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const target = devices[i]
      const budget = Math.min(3000, Math.max(1, Math.floor(remaining / 2)))
      const session = sessionFactory({ port: target.comPort, username: target.username, password: target.password,
        connectTimeoutMs: Math.min(budget, 700), commandTimeoutMs: budget })
      let timer
      try {
        const response = await Promise.race([
          (async () => {
            await session.open()
            return session.command('display version', { timeoutMs: budget })
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => {
            session.close()
            reject(new Error('readiness deadline exceeded'))
          }, Math.min(remaining, 2 * budget)) }),
        ])
        if (response.ok && /Versatile Routing Platform|\bVRP\b/iu.test(response.output)) {
          Object.assign(state, { ready: true, state: 'ready', prompt: response.prompt })
          delete state.error
        } else Object.assign(state, { state: 'not_vrp', error: 'display version did not confirm VRP' })
      } catch (error) {
        // An invalid credential is terminal for this probe; do not cause lockout
        // by retrying it every poll. Return only a classification, no banners.
        Object.assign(state, { state: error.kind === 'authentication' ? 'authentication_required' : 'booting_or_unreachable',
          error: error.kind === 'authentication' ? 'provide console credentials; password changes are not performed by readiness probes' : 'console did not complete a prompt and display version' })
      } finally { clearTimeout(timer); session.close() }
    }
    if (states.some(s => !s.ready && s.state !== 'authentication_required') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(400, deadline - Date.now())))
    }
  }
  return { ok: states.every(s => s.ready), devices: states }
}
