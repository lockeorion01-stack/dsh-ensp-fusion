const OPS = ('select_tab select_list ping windows ensp pidwindows screen children texts find info dpi wait exists shot show focus resize close close_project dialog_decision device_control start_devices normalize_canvas device_click cursor move click ncclick postclick drag wheel type safetype activate raise fg posttext key paste settext bmclick wndat exeinfo open explore spawn kill free_ports sleep exit start_all stop_all wait_ports open_console device_window close_console').split(' ')
export const GUI_STEP_SCHEMA = {
  type: 'object', additionalProperties: true,
  description: 'op-specific arguments. sleep: {op:"sleep",ms:1200} or legacy t in seconds (0..60). key: {op:"key",key:"o",mods:["ctrl"]}. Raw open/spawn/bmclick acknowledge dispatch only; use ensp_project for verified project checkpoints.',
  properties: {
    op: { type: 'string', enum: OPS, required: true },
    hwnd: { type: 'integer', description: 'Positive current handle; inspect immediately before use; stale handles are rejected.' },
    ms: { type: 'number', description: 'sleep only: 0..60000 milliseconds; cannot combine with t.' },
    t: { type: 'number', description: 'Legacy sleep seconds, 0..60; prefer ms.' },
    path: { type: 'string' }, device: { type: 'string' }, key: { type: 'string' },
    mods: { type: 'array', items: { type: 'string', enum: ['ctrl', 'alt', 'shift', 'win'] } },
    timeout_ms: { type: 'integer', description: '0..600000 milliseconds.' },
    timeout: { type: 'number', description: 'Raw bridge wait timeout in seconds, 0..60.' },
    wait: { type: 'number', description: 'Raw bridge delay in seconds, 0..60; not proof of readiness.' },
  },
}

export function normalizeGuiSteps(steps, timeoutMs = 180000) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 256) throw new Error('steps must contain 1..256 operations')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900000) throw new Error('timeout_ms must be an integer in 1..900000 milliseconds')
  let sleeps = 0
  const normalized = steps.map((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source) || !OPS.includes(source.op)) throw new Error(`steps[${index}].op is unsupported; use the published operation enum`)
    const step = { ...source }
    if (step.hwnd !== undefined && (!Number.isSafeInteger(step.hwnd) || step.hwnd < 1)) throw new Error('hwnd must be a positive integer; rediscover stale handles')
    if (step.timeout_ms !== undefined && (!Number.isSafeInteger(step.timeout_ms) || step.timeout_ms < 0 || step.timeout_ms > 600000)) throw new Error('step timeout_ms must be 0..600000 milliseconds')
    if (['open', 'explore', 'exeinfo'].includes(step.op) && (typeof step.path !== 'string' || !step.path.trim())) throw new Error(`${step.op} requires path`)
    if (step.op === 'dialog_decision' && (!Number.isSafeInteger(step.dialog_hwnd) || step.dialog_hwnd < 1 || !['save', 'discard', 'cancel'].includes(step.decision))) throw new Error('dialog_decision requires current dialog_hwnd and decision: save/discard/cancel')
    for (const key of ['wait', 'timeout', 'settle', 'delay', 'hold']) {
      if (step[key] !== undefined && (!Number.isFinite(step[key]) || step[key] < 0 || step[key] > 60)) throw new Error(`${key} is in seconds, range 0..60; sleep supports explicit ms`)
    }
    if (step.op === 'sleep') {
      if (step.t !== undefined && step.ms !== undefined) throw new Error('sleep accepts ms or t (seconds), not both')
      const seconds = step.ms === undefined ? step.t ?? 0.5 : step.ms / 1000
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new Error('sleep must be 0..60 seconds; use ms:1200 for 1.2 seconds')
      step.t = seconds
      delete step.ms
      sleeps += seconds * 1000
    } else if (step.ms !== undefined || step.t !== undefined) throw new Error('ms and t are only supported for sleep')
    if (step.op === 'key' && (typeof step.key !== 'string' || !step.key || /[\^+]/u.test(step.key))) throw new Error('key requires a key name; use key:"o",mods:["ctrl"] for Ctrl+O')
    if (step.mods !== undefined && (!Array.isArray(step.mods) || step.mods.some(mod => !['ctrl', 'alt', 'shift', 'win'].includes(mod)))) throw new Error('mods must contain ctrl, alt, shift or win')
    return step
  })
  if (sleeps >= timeoutMs) throw new Error('sleep duration exhausts the GUI batch timeout_ms; no operations sent')
  return normalized
}
