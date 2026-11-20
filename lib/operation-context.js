import { randomUUID, createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { buildInfo } from './build-info.js'
import { normalizeOperationResult } from './operation-result.js'
import { createRedactor, credentialValues, redactValue } from './redaction.js'
import { openExecutionLog } from './execution-events.js'
import { createExecutionControl } from './execution-control.js'

export function instrumentTool(tool, config = {}) {
  const schema = tool.output?.schema
  let outputSchema
  if (schema) {
    const { required, ...rest } = schema
    const properties = { ...schema.properties, ok: { type: 'boolean' }, error: { type: 'string' } }
    // DSH supports oneOf only as a standalone union, with complete typed
    // branches. Normal replies retain the tool's required fields; interruption
    // before dispatch can return just the error and execution evidence.
    const execution = statuses => ({ type: 'object', additionalProperties: true, required: ['schema_version', 'status'], properties: {
      schema_version: { type: 'integer', const: 1 }, status: { type: 'string', enum: statuses },
    } })
    outputSchema = { oneOf: [
      { ...rest, required: [...new Set([...(required ?? []), 'execution'])], properties: {
        ...properties, execution: execution(['success', 'failed', 'partial', 'inconclusive']),
      } },
      { ...rest, required: ['ok', 'execution'], properties: {
        ...properties, ok: { type: 'boolean', const: false }, execution: execution(['cancelled', 'unconfirmed']),
      } },
    ] }
  }
  const boundaryEvidence = new Map()
  return { ...tool, finalizeContent(exec, result) {
    const evidence = boundaryEvidence.get(exec.token)
    boundaryEvidence.delete(exec.token)
    // rc.3 canonicalizes caller cancellation to ABORTED after the body drains.
    // Its public finalizer retains our stop evidence without replacing its error.
    if (evidence && (result.error?.info?.code === 'ABORTED' || (evidence.code === 'ENSP_GUI_VALIDATION' && result.error))) return [{ type: 'text', text: JSON.stringify(evidence, null, 2) }]
    try { return tool.finalizeContent?.(exec, result) } catch { return undefined }
  }, output: { ...tool.output, ...(outputSchema ? { schema: outputSchema } : {}) }, async execute(args, exec = {}) {
    const id = randomUUID(), started = performance.now()
    const control = createExecutionControl({ signal: exec.signal, deadline: exec.deadline, timeoutMs: config.timeoutMs ?? 180000 })
    const redact = createRedactor(credentialValues(args))
    const source = exec.entrypoint ?? (exec.agent ? 'dsh' : 'direct')
    const metadata = { operation_id: id, ...(exec.operation?.id ? { parent_operation_id: exec.operation.id } : {}),
      ...(typeof exec.callId === 'string' || typeof exec.callId === 'number' ? { call_id: redact(String(exec.callId)).slice(0, 128) } : {}),
      tool: tool.name, entrypoint: source, build_fingerprint: buildInfo().fingerprint }
    let log, logError, omittedEvents = 0, loggingDisabled = config.diagnosticLogging === false || process.env.ENSP_FUSION_DIAGNOSTICS === 'off'
    if (!loggingDisabled) {
      const root = config.diagnosticDirectory || process.env.ENSP_FUSION_DIAGNOSTICS_DIR || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'dsh-ensp-fusion', 'diagnostics') : null)
      try { if (!root) throw Error('no diagnostic directory configured'); log = await openExecutionLog(root, id) }
      catch (error) { logError = error.code ?? 'DIAGNOSTIC_LOG_UNAVAILABLE' }
    }
    const context = { id, signal: control.signal, deadline: control.deadline, control, async event(type, detail = {}) {
      // Explicit whitelist: never persist args, commands, replies or error text.
      const safe = {}
      for (const key of ['phase', 'index', 'pid', 'hwnd', 'port', 'count', 'status']) if (typeof detail[key] === 'number' || typeof detail[key] === 'boolean') safe[key] = detail[key]
      if (typeof detail.phase === 'string') safe.phase = detail.phase.slice(0, 48)
      if (typeof detail.status === 'string') safe.status = detail.status.slice(0, 32)
      const row = { ...metadata, at: new Date().toISOString(), elapsed_ms: Math.round(performance.now() - started), type, ...safe }
      if (type === 'finished') row.omitted_events = omittedEvents
      if (typeof args?.topology_path === 'string') row.topology_ref = createHash('sha256').update(args.topology_path).digest('hex')
      try { await log?.event(row) } catch (error) { logError = error.code ?? 'DIAGNOSTIC_LOG_WRITE_FAILED'; omittedEvents++ }
    } }
    await context.event('started', { port: args?.port })
    const onAbort = () => { void context.event('cancel_requested') }
    control.signal.addEventListener('abort', onAbort, { once: true })
    let value
    try { control.check(); value = await tool.execute(args, { ...exec, signal: control.signal, deadline: control.deadline, operation: context }) }
    catch (error) {
      if (control.signal.aborted || error?.kind === 'cancelled') {
        value = { ok: false, error: 'Operation cancelled or deadline exceeded', execution: { schema_version: 1, ...control.outcome() } }
      } else {
      await context.event('finished', { status: 'threw' })
      try { await log?.close() } catch (closeError) { logError = closeError.code ?? 'DIAGNOSTIC_LOG_CLOSE_FAILED' }
      const failure = new Error(redact(error?.message ?? String(error)))
      for (const key of ['name', 'code', 'kind', 'output', 'phase', 'status', 'stepIndex', 'field']) {
        const field = error?.[key]
        if (typeof field === 'string' || typeof field === 'number') failure[key] = typeof field === 'string' ? redact(field) : field
      }
      await control.drain()
      failure.execution = { ...metadata, schema_version: 1, ...control.outcome(), status: 'unconfirmed', stop_confirmed: false, operation_verification: 'unconfirmed',
        evidence_persisted: !!log && !logError, may_have_applied: true }
      if (error?.code === 'ENSP_GUI_VALIDATION') Object.assign(failure.execution,
        { status: 'failed', stop_confirmed: true, may_have_applied: false })
      if (exec.token && error?.code === 'ENSP_GUI_VALIDATION') {
        if (boundaryEvidence.size >= 1024) boundaryEvidence.delete(boundaryEvidence.keys().next().value)
        boundaryEvidence.set(exec.token, { ok: false, error: failure.message, code: failure.code,
          stepIndex: failure.stepIndex, field: failure.field, execution: failure.execution })
      }
      control.signal.removeEventListener('abort', onAbort); control.dispose()
      throw failure
      }
    }
    await control.drain()
    if (control.signal.aborted || control.outcome().status === 'unconfirmed') {
      value = { ...value, ok: false, execution: { ...value?.execution, schema_version: 1, ...control.outcome() } }
      await context.event(value.execution.stop_confirmed ? 'stop_confirmed' : 'stop_unconfirmed')
    }
    control.signal.removeEventListener('abort', onAbort); control.dispose()
    value = normalizeOperationResult(tool.name, value)
    await context.event('finished', { status: value.execution.status })
    try { await log?.close() } catch (error) { logError = error.code ?? 'DIAGNOSTIC_LOG_CLOSE_FAILED' }
    const returned = redactValue({ ...value, execution: { ...value.execution, ...metadata,
      elapsed_ms: Math.round(performance.now() - started), evidence_persisted: !!log && !logError,
      evidence_refs: log && !logError ? [`${id}.closed.jsonl`] : [],
      ...(logError ? { evidence_error: logError } : {}), logging_disabled: loggingDisabled } }, redact)
    if (exec.token && ['cancelled', 'unconfirmed'].includes(returned.execution.status)) {
      if (boundaryEvidence.size >= 1024) boundaryEvidence.delete(boundaryEvidence.keys().next().value)
      boundaryEvidence.set(exec.token, returned)
    }
    return returned
  } }
}
