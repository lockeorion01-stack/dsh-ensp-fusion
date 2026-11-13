import { createRedactor, credentialValues, redactValue } from './redaction.js'

// Use the SDK's documented around-dispatch hook. Never change SDK internals or
// reinterpret failures from tools owned by another plugin.
export function installOutcomeAdapter(ctx, names) {
  if (typeof ctx.on !== 'function') return
  const owned = new Set(names)
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (!owned.has(exec.name) || result.isError || result.value?.ok !== false) return result
    const value = redactValue(result.value, createRedactor(credentialValues(exec.arguments)))
    return {
      isError: true,
      error: { message: 'eNSP operation failed or remains unverified; inspect the structured evidence. No automatic replay.',
        info: { name: 'EnspOperationError', code: 'ENSP_OPERATION_FAILED' } },
      content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      ...(result.meta ? { meta: result.meta } : {}),
      ...(result.additionalContexts ? { additionalContexts: result.additionalContexts } : {}),
    }
  })
}
