const APP = /^(?:eNSP_(?:Client|PCServer|VBoxServer)|DeepSeek Harness|dsh)\.exe$/iu
const hexId = value => { try { const id = BigInt(String(value)); return id > 0n ? id.toString(16) : null } catch { return null } }
export function correlateIncident(events, operations = [], { windowMs = 120000 } = {}) {
  const records = new Map(), reports = new Map(), instances = new Map(), ungrouped = []
  for (const row of events) {
    if (![1000, 1001].includes(Number(row.id))) continue
    if (row.provider && !['Application Error', 'Windows Error Reporting'].includes(row.provider)) continue
    const app = Number(row.id) === 1000 ? row.data?.AppName : row.data?.P1
    if (!APP.test(app ?? '')) continue
    const key = row.recordId != null ? `${row.channel ?? 'Application'}:${row.recordId}` : JSON.stringify(row)
    if (!records.has(key)) records.set(key, row)
  }
  for (const row of records.values()) {
    const d = row.data ?? {}
    if (Number(row.id) === 1001) {
      const id = d.ReportId
      if (id) { const r = reports.get(id) ?? { report_id: id, app: d.P1, records: [] }; r.records.push(row.recordId); reports.set(id, r) }
      continue
    }
    const pid = hexId(d.ProcessId), creation = hexId(d.ProcessCreationTime)
    const fault = { record_id: row.recordId ?? null, at: row.time, module: d.ModuleName ?? null,
      code: d.ExceptionCode ?? null, offset: d.FaultingOffset ?? null, report_id: d.IntegratorReportId ?? null }
    if (!pid || !creation || creation === '0') { ungrouped.push({ app: d.AppName, ...fault, reason: 'incomplete-process-identity' }); continue }
    const key = `${d.AppName.toLowerCase()}:${pid}:${creation}`
    const instance = instances.get(key) ?? { app: d.AppName, pid: `0x${pid}`, process_creation_time: `0x${creation}`, faults: [], correlations: [] }
    instance.faults.push(fault); instances.set(key, instance)
  }
  for (const instance of instances.values()) {
    const seen = new Set()
    for (const fault of instance.faults) {
      const at = Date.parse(fault.at)
      for (const op of operations) {
        const start = Date.parse(op.started ?? op.at), end = Date.parse(op.finished ?? op.at ?? op.started)
        if (!Number.isFinite(at) || !Number.isFinite(start) || !Number.isFinite(end) || at < start - windowMs || at > end + windowMs) continue
        const id = op.operation_id ?? op.call_id
        if (!id || seen.has(id)) continue
        seen.add(id)
        const same = hexId(op.target_pid) === hexId(instance.pid) && op.target_creation_time
          && hexId(op.target_creation_time) === hexId(instance.process_creation_time)
        instance.correlations.push({ operation_id: id, tool: op.tool ?? null, relation: same ? 'same_process' : 'temporal_only', causal: false })
      }
    }
  }
  for (const instance of instances.values()) for (const fault of instance.faults) {
    if (fault.report_id && reports.has(fault.report_id)) fault.wer_record_ids = [...reports.get(fault.report_id).records]
  }
  return { raw_records: records.size, application_error_records: [...records.values()].filter(r => Number(r.id) === 1000).length,
    affected_instances: instances.size, ungrouped_records: ungrouped, instances: [...instances.values()], wer_reports: [...reports.values()],
    limits: ['Affected instances are not proven independent terminations.', 'Time and process correlations do not establish causation.'] }
}
