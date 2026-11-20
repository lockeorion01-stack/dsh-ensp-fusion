// Only declared result boundaries are inspected. CLI output is opaque text.
const legacyResult = (name, value) => ({
  ensp_status: () => typeof value.workspaceRoot === 'string' && !!value.bridge && Array.isArray(value.instances),
  ensp_topo: () => typeof value.topologyPath === 'string' && Array.isArray(value.devices),
  ensp_shot: () => typeof value.path === 'string', ensp_capture: () => Array.isArray(value.shots),
  ensp_ref: () => typeof value.out === 'string', ensp_doc: () => typeof value.captioned === 'string' || typeof value.bare === 'string',
}[name]?.() ?? false)
const FUSION = new Set(['ensp_services','ensp_lldp','ensp_diagnose','ensp_inspect','ensp_scenarios','ensp_build','ensp_wait'])
const MAX_DATA_BYTES = 4 * 1024 * 1024
export function normalizeOperationResult(toolName, result) {
  const value = result && typeof result === 'object' && !Array.isArray(result) ? result : {}
  const previous = value.execution?.schema_version === 1 ? value.execution : {}
  const paths = key => Array.isArray(previous[key]) ? previous[key].filter(v => typeof v === 'string').slice(0,10000) : []
  const failed = paths('failed_paths'), skipped = paths('skipped_paths'), unknown = paths('unknown_paths')
  let successes = 0, actionEvidence = false
  function item(row, path, required = false) {
    if (!row || typeof row !== 'object') { unknown.push(path); return }
    if (row.skipped === true || ['SKIP', 'SKIPPED'].includes(row.status)) skipped.push(path)
    else if (row.ok === false || row.pass === false || ['FAIL', 'ERROR', 'FAILED'].includes(row.status)) failed.push(path)
    else if (row.ok === true || row.pass === true || ['PASS', 'OK'].includes(row.status)) successes++
    else if (required || row.ok !== undefined || row.pass !== undefined) unknown.push(path)
  }
  const scan = (rows, path, required = true) => { if (Array.isArray(rows)) rows.forEach((r, i) => item(r, `${path}[${i}]`, required)); else if (rows !== undefined) unknown.push(path) }
  let data = value.data
  if (typeof data === 'string' && /^\s*[{[]/u.test(data)) {
    if (Buffer.byteLength(data) > MAX_DATA_BYTES) unknown.push('data:limit')
    else { try { data = JSON.parse(data) } catch { unknown.push('data:invalid-json') } }
  }
  if (FUSION.has(toolName) && value.ok !== false && (!data || typeof data !== 'object' || Array.isArray(data))) unknown.push('data:invalid-payload')
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : value
  if (value.ok === false) { if (previous.schema_version !== 1) failed.push('ok') }
  else if (value.ok !== true && (value.ok !== undefined || !legacyResult(toolName, value))) unknown.push('ok')
  if (payload !== value) item(payload, 'data')
  const prefix = payload === value ? '' : 'data.'
  if (toolName === 'ensp_cli' || !toolName) {
    if (payload.devices !== undefined && !Array.isArray(payload.devices)) unknown.push(`${prefix}devices`)
    const devices = Array.isArray(payload.devices) ? payload.devices : [payload]
    devices.forEach((device, i) => {
      const p = Array.isArray(payload.devices) ? `${prefix}devices[${i}]` : prefix.replace(/\.$/u, '')
      if (!device || typeof device !== 'object') { unknown.push(p); return }
      // Even the first command can have changed state before a failed reply.
      // A nested transport failure must retain that uncertainty too.
      if ((Array.isArray(device.results) && device.results.length)
          || (Array.isArray(device.setupResults) && device.setupResults.length)
          || device.saved?.performed === true || device.failure?.outcome === 'unconfirmed') actionEvidence = true
      if (device !== value) item(device, p || 'result', true)
      const at = key => p ? `${p}.${key}` : key
      scan(device.results, at('results')); scan(device.setupResults, at('setupResults')); scan(device.checks, at('checks'))
      if (device.saved?.performed) item(device.saved, at('saved'), true)
      if (device.skipped?.length) skipped.push(at('skipped'))
    })
  }
  if (toolName === 'ensp_gui') scan(payload.steps, `${prefix}steps`)
  if (['ensp_capture', 'ensp_shot'].includes(toolName)) scan(payload.shots, `${prefix}shots`, toolName === 'ensp_capture')
  if (['ensp_services', 'ensp_labtest'].includes(toolName)) scan(payload.rows, `${prefix}rows`)
  if (toolName === 'ensp_inspect') scan(payload.results, `${prefix}results`)
  if (toolName === 'ensp_doc' && payload.verification != null) item(payload.verification, `${prefix}verification`, true)
  if (toolName === 'ensp_lldp') {
    if (payload.status === 'DIFFERENT') failed.push('data.status')
    else if (payload.status !== 'MATCH') unknown.push('data.status')
  }
  if (['cancelled', 'unconfirmed'].includes(previous.status)) unknown.push('execution.status')
  const ok = value.ok !== false && !failed.length && !skipped.length && !unknown.length
  const status = ok ? 'success' : previous.status === 'unconfirmed' ? 'unconfirmed'
    : previous.status === 'cancelled' ? 'cancelled' : failed.length || skipped.length
      ? successes ? 'partial' : 'failed' : 'inconclusive'
  const assertion = ok ? 'pass' : unknown.length ? 'inconclusive' : 'fail'
  const business = toolName === 'ensp_services' ? assertion : 'not_requested'
  return { ...value, ok, execution: { ...previous, schema_version: 1, status,
    operation_verification: ok ? (toolName === 'ensp_gui' && value.outcome?.taskVerified !== true ? 'dispatched' : 'confirmed') : 'unconfirmed',
    business_verification: business, may_have_applied: previous.may_have_applied ?? (!ok && (actionEvidence || successes > 0 || payload.failure?.outcome === 'unconfirmed' || toolName === 'ensp_gui')),
    ...(['ensp_services','ensp_labtest','ensp_lldp'].includes(toolName) ? { assertion_verification: assertion,
      verification_scope: toolName === 'ensp_services' ? 'host-service-probes' : toolName === 'ensp_lldp' ? 'provided-lldp-observations' : 'declared-command-assertions' } : {}),
    failed_paths: [...new Set(failed)], skipped_paths: [...new Set(skipped)], unknown_paths: [...new Set(unknown)],
    evidence_refs: previous.evidence_refs ?? [] } }
}

export function operationSucceeded(toolName, result) { return normalizeOperationResult(toolName, result).ok }
export function assertOperationSucceeded(toolName, result) {
  const normalized = normalizeOperationResult(toolName, result)
  if (!normalized.ok) throw Object.assign(new Error(`eNSP ${toolName ?? 'operation'} ${normalized.execution.status}; inspect structured evidence before retrying`),
    { code: 'ENSP_OPERATION_FAILED', result: normalized })
  return result
}
