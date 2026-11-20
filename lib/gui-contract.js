const OPS = ('select_tab select_list ping windows ensp pidwindows screen children texts find info dpi wait exists shot show focus resize close close_project dialog_decision device_control start_devices normalize_canvas device_click cursor move click ncclick postclick drag wheel type safetype activate raise fg posttext key paste settext bmclick wndat exeinfo open explore spawn kill free_ports sleep exit start_all stop_all wait_ports open_console device_window close_console').split(' ')
export const GUI_STEP_SCHEMA = {
  type: 'object', additionalProperties: true,
  description: 'Whole batch validates before GUI dispatch. shot/screen require out (path is a compatible alias; conflicting aliases are rejected). sleep: {op:"sleep",ms:1200} or legacy t in seconds (0..60). key: {op:"key",key:"o",mods:["ctrl"]}. Raw open/spawn/bmclick acknowledge dispatch only; use ensp_project for verified project checkpoints.',
  properties: {
    op: { type: 'string', enum: OPS, required: true },
    hwnd: { type: 'integer', description: 'Positive current handle; inspect immediately before use; stale handles are rejected.' },
    ms: { type: 'number', description: 'sleep only: 0..60000 milliseconds; cannot combine with t.' },
    t: { type: 'number', description: 'Legacy sleep seconds, 0..60; prefer ms.' },
    out: { type: 'string', description: 'shot/screen output in the session workspace; path is accepted as an alias.' },
    path: { type: 'string' }, device: { type: 'string' }, key: { type: 'string' },
    mods: { type: 'array', items: { type: 'string', enum: ['ctrl', 'alt', 'shift', 'win'] } },
    timeout_ms: { type: 'integer', description: '0..600000 milliseconds.' },
    timeout: { type: 'number', description: 'Raw bridge wait timeout in seconds, 0..60.' },
    wait: { type: 'number', description: 'Raw bridge delay in seconds, 0..60; not proof of readiness.' },
  },
}

const WINDOW_OPS = new Set(('select_tab select_list children texts info dpi shot focus resize close close_project dialog_decision device_control start_devices normalize_canvas device_click ncclick postclick safetype activate raise posttext settext bmclick find show').split(' '))
const NAMED_KEYS = new Set(('enter tab esc escape space backspace del delete insert up down left right home end pageup pagedown ctrl shift alt win f1 f2 f3 f4 f5 f6 f7 f8 f9 f10 f11 f12').split(' '))

function validateStep(step, index) {
  const fail = (field, message) => {
    const error = new Error('steps[' + index + '].' + field + ': ' + message)
    Object.assign(error, { name: 'GuiStepValidationError', code: 'ENSP_GUI_VALIDATION', stepIndex: index, field })
    throw error
  }
  const text = (key, required = true) => {
    if (step[key] === undefined && !required) return
    if (typeof step[key] !== 'string' || !step[key].trim() || /[\p{Cc}]/u.test(step[key])) fail(key, 'requires a nonempty string without control characters')
  }
  const integer = (key, min, max, required = true) => {
    if (step[key] === undefined && !required) return
    if (!Number.isSafeInteger(step[key]) || step[key] < min || step[key] > max) fail(key, 'must be an integer in ' + min + '..' + max)
  }
  const tuple = (key, size, required = true) => {
    if (step[key] === undefined && !required) return
    if (!Array.isArray(step[key]) || step[key].length !== size || step[key].some(n => !Number.isSafeInteger(n) || Math.abs(n) > 2147483647)) fail(key, 'requires ' + size + ' integer coordinates')
  }
  if (['shot', 'screen'].includes(step.op)) {
    if (step.path !== undefined) {
      text('path')
      if (step.out !== undefined && step.out !== step.path) fail('out', 'conflicts with path; provide one output path')
      step.out = step.path
      delete step.path
    }
    text('out')
    tuple('crop', 4, false)
    if (step.crop && (step.crop[2] <= 0 || step.crop[3] <= 0)) fail('crop', 'width and height must be positive')
    if (step.mode !== undefined && !['blit', 'print'].includes(step.mode)) fail('mode', 'must be blit or print')
  }
  for (const key of ['hwnd', 'dialog_hwnd', 'pid']) {
    if (step[key] !== undefined && (!Number.isSafeInteger(step[key]) || step[key] < 1)) fail(key, 'must be a positive integer; rediscover stale handles')
  }
  for (const key of ['title', 'cls', 'device']) text(key, false)
  for (const key of ['ensp', 'include_hidden', 'visible_only', 'normal', 'front', 'restore', 'client', 'double', 'nomove', 'raise_first', 'breakaway']) {
    if (step[key] !== undefined && typeof step[key] !== 'boolean') fail(key, 'must be boolean')
  }
  if (WINDOW_OPS.has(step.op) && step.hwnd === undefined && step.ensp !== true && !step.title && !step.cls) fail('hwnd', 'requires hwnd, title, cls or ensp:true')
  if (step.op === 'wait' && !step.title && !step.cls) fail('title', 'wait requires title or cls')
  if (step.op === 'exists') integer('hwnd', 1, Number.MAX_SAFE_INTEGER)
  if (step.op === 'pidwindows') integer('pid', 1, 0xffffffff)
  if (['move', 'ncclick', 'postclick', 'resize', 'wndat'].includes(step.op) || (step.op === 'click' && step.ensp_rel === undefined)) {
    integer('x', -2147483648, 2147483647); integer('y', -2147483648, 2147483647)
  }
  if (step.ensp_rel !== undefined) tuple('ensp_rel', 2)
  if (step.op === 'resize') { integer('w', 1, 2147483647); integer('h', 1, 2147483647) }
  if (step.op === 'drag') for (const key of ['x1', 'y1', 'x2', 'y2']) integer(key, -2147483648, 2147483647)
  if (['move', 'drag'].includes(step.op)) integer('steps', 1, 10000, false)
  if (step.op === 'wheel') {
    integer('delta', -2147483648, 2147483647, false)
    if ((step.x === undefined) !== (step.y === undefined)) fail('x', 'wheel requires both x and y or neither')
    integer('x', -2147483648, 2147483647, false); integer('y', -2147483648, 2147483647, false)
  }
  if (step.button !== undefined && !['left', 'right', 'middle'].includes(step.button)) fail('button', 'must be left, right or middle')
  integer('clics', 1, 100, false)
  if (['device_control', 'normalize_canvas'].includes(step.op)) tuple('toolbar', 2, step.op === 'device_control')
  if (step.op === 'device_click') {
    for (const key of ['cx', 'cy']) integer(key, -2147483648, 2147483647)
    for (const key of ['half_width', 'half_height']) integer(key, 0, 10000, false)
  }
  if (['type', 'safetype', 'posttext', 'paste', 'settext'].includes(step.op) && typeof step.text !== 'string') fail('text', 'requires a string')
  if (step.per_char !== undefined && (!Number.isFinite(step.per_char) || step.per_char < 0 || step.per_char > 60)) fail('per_char', 'must be 0..60 seconds; the batch deadline still applies')
  if (step.op === 'key' && (typeof step.key !== 'string' || !step.key || /[\p{Cc}\^+]/u.test(step.key) || (step.key.length !== 1 && !NAMED_KEYS.has(step.key.toLowerCase())))) fail('key', 'unknown key; use key:"o",mods:["ctrl"] for Ctrl+O')
  if (step.expect !== undefined && !(Number.isSafeInteger(step.expect) && step.expect > 0) && !(typeof step.expect === 'string' && step.expect.trim())) fail('expect', 'must be a window handle or nonempty title')
  if (['open_console', 'device_window', 'close_console'].includes(step.op)) text('device')
  tuple('icon_offset', 2, false)
  if (['open', 'explore', 'exeinfo'].includes(step.op)) text('path')
  if (step.op === 'close_project' && step.save !== undefined && !['ask', 'save', 'discard', 'cancel'].includes(step.save)) fail('save', 'must be ask, save, discard or cancel')
  if (step.op === 'dialog_decision') {
    integer('dialog_hwnd', 1, Number.MAX_SAFE_INTEGER)
    if (!['save', 'discard', 'cancel'].includes(step.decision)) fail('decision', 'must be save, discard or cancel')
  }
  if (step.op === 'start_all' && step.method !== undefined && !['keyboard', 'toolbar'].includes(step.method)) fail('method', 'must be keyboard or toolbar')
  if (['activate', 'safetype'].includes(step.op) && step.method !== undefined && !['auto', 'setfg', 'raise', 'click', 'switch'].includes(step.method)) fail('method', 'unsupported activation method')
  if (step.op === 'wait_ports' && step.want !== undefined && !['open', 'closed'].includes(step.want)) fail('want', 'must be open or closed')
  if (step.op === 'spawn') { text('exe'); text('workdir', false); text('cmdline', false) }
  if (step.op === 'kill' && (!Array.isArray(step.names) || !step.names.length || step.names.some(name => typeof name !== 'string' || !name.trim() || /[\p{Cc}]/u.test(name)))) fail('names', 'requires a nonempty array of image names')
  if (['free_ports', 'wait_ports'].includes(step.op) && (step.ports !== undefined || step.op === 'free_ports')) {
    if (!Array.isArray(step.ports) || !step.ports.length || step.ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) fail('ports', 'requires ports in 1..65535')
  }
  integer('depth', 0, 2147483647, false)
  if (step.op === 'select_tab') integer('index', 0, 2147483647)
  if (step.op === 'select_list') {
    if ((step.index !== undefined) === (step.text !== undefined)) fail('index', 'requires exactly one index or text')
    integer('index', 0, 2147483647, false); text('text', false); integer('expected_count', 1, 2147483647, false)
  }
}

export function normalizeGuiSteps(steps, timeoutMs = 180000) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 256) throw new Error('steps must contain 1..256 operations')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900000) throw new Error('timeout_ms must be an integer in 1..900000 milliseconds')
  let sleeps = 0
  const normalized = steps.map((source, index) => {
    try {
    if (!source || typeof source !== 'object' || Array.isArray(source) || !OPS.includes(source.op)) throw new Error(`steps[${index}].op is unsupported; use the published operation enum`)
    const step = { ...source }
    validateStep(step, index)
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
    } catch (error) {
      if (error.code === 'ENSP_GUI_VALIDATION') throw error
      const field = !source || !OPS.includes(source.op) ? 'op' : /^([a-z_]+)/u.exec(error.message)?.[1] ?? 'step'
      throw Object.assign(new Error('steps[' + index + '].' + field + ': ' + error.message),
        { name: 'GuiStepValidationError', code: 'ENSP_GUI_VALIDATION', stepIndex: index, field })
    }
  })
  if (sleeps >= timeoutMs) throw new Error('sleep duration exhausts the GUI batch timeout_ms; no operations sent')
  return normalized
}
