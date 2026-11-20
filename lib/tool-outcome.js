import { createRedactor, credentialValues, redactValue } from './redaction.js'
import { normalizeOperationResult } from './operation-result.js'

// Use the SDK's documented around-dispatch hook. Never change SDK internals or
// reinterpret failures from tools owned by another plugin.
export function installOutcomeAdapter(ctx, names) {
  if (typeof ctx.on !== 'function') return
  const owned = new Set(names)
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (!owned.has(exec.name) || result.isError) return result
    const value = redactValue(normalizeOperationResult(exec.name, result.value), createRedactor(credentialValues(exec.arguments)))
    if (value.ok) return result
    return {
      isError: true,
      error: { message: 'eNSP operation failed or remains unverified; inspect the structured evidence. No automatic replay.'
        + (value.execution?.operation_id ? ' operation_id=' + value.execution.operation_id + '; export matching session evidence with ensp_logexport.' : ''),
        info: { name: 'EnspOperationError', code: 'ENSP_OPERATION_FAILED' } },
      content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      ...(result.meta ? { meta: result.meta } : {}),
      ...(result.additionalContexts ? { additionalContexts: result.additionalContexts } : {}),
    }
  })
}
