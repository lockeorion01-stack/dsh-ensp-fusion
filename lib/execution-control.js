import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

// Deadlines are monotonic and process-local. A Python helper receives remaining
// milliseconds, never this process's monotonic clock value.
export function createExecutionControl({ signal, deadline, timeoutMs = 180000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('execution timeout must be positive')
  if (deadline !== undefined && !Number.isFinite(deadline)) throw new RangeError('execution deadline must be finite')
  const end = Math.min(deadline ?? Infinity, performance.now() + timeoutMs)
  const controller = new AbortController(), pending = new Set(), taskRefs = [], settlements = new Set()
  let dispatched = false, uncertain = false, sequence = 0
  const abort = () => controller.abort(signal?.reason ?? new Error('Operation cancelled'))
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('Operation deadline exceeded'), { code: 'ENSP_DEADLINE' })), Math.max(1, Math.ceil(end - performance.now())))
  const control = {
    signal: controller.signal, deadline: end,
    remaining(cap = Infinity) { return Math.max(0, Math.min(cap, end - performance.now())) },
    check() {
      if (performance.now() >= end && !controller.signal.aborted) controller.abort(Object.assign(new Error('Operation deadline exceeded'), { code: 'ENSP_DEADLINE' }))
      if (controller.signal.aborted) throw control.error()
    },
    dispatch() { control.check(); dispatched = true; const token = ++sequence; pending.add(token); return token },
    observe(token) { pending.delete(token) },
    unconfirmed() { uncertain = true },
    task(ref) { taskRefs.push(ref) },
    settle(promise) { settlements.add(promise); promise.catch(() => { uncertain = true }).finally(() => settlements.delete(promise)) },
    async drain() { await Promise.allSettled([...settlements]) },
    outcome() { return { status: uncertain || pending.size ? 'unconfirmed' : 'cancelled',
      may_have_applied: dispatched, stop_confirmed: !uncertain && !pending.size,
      ...(taskRefs.length ? { task_refs: taskRefs.slice(-20) } : {}) } },
    error() { return Object.assign(new Error(controller.signal.reason?.code === 'ENSP_DEADLINE' ? 'Operation deadline exceeded' : 'Operation cancelled'),
      { name: 'EnspCancellationError', code: controller.signal.reason?.code === 'ENSP_DEADLINE' ? 'ENSP_DEADLINE' : 'ENSP_CANCELLED', kind: 'cancelled', execution: control.outcome() }) },
    dispose() { clearTimeout(timer); signal?.removeEventListener('abort', abort) },
  }
  return control
}

export function executionOptions(exec) { return { signal: exec?.signal, deadline: exec?.deadline, control: exec?.operation?.control } }
export function checkControl(options = {}) { options.control?.check(); options.signal?.throwIfAborted() }
export function remainingTime(options = {}, cap = 180000) {
  checkControl(options)
  return Math.max(1, Math.floor(options.control?.remaining(cap) ?? Math.min(cap, (options.deadline ?? Infinity) - performance.now())))
}
export async function controlledDelay(ms, options = {}) {
  checkControl(options)
  await delay(Math.min(ms, remainingTime(options, ms)), undefined, { signal: options.control?.signal ?? options.signal }).catch(error => {
    checkControl(options); throw error
  })
  checkControl(options)
}

export function processCancellation() {
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error('Operator cancelled operation'))
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel)
  return { signal: controller.signal, dispose() { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) } }
}
