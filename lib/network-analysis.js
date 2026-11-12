// Independent Node implementation inspired by the reference project's workflow.
// Observations are evidence, never authority to change device configuration.
export function normalizeInterface(value) {
  const text = String(value ?? '').replace(/\s+/gu, '')
  const m = /^([a-z-]+)(\d+(?:\/\d+)*)$/iu.exec(text)
  if (!m) return text
  const names = { ge: 'GigabitEthernet', gig: 'GigabitEthernet', gigabitethernet: 'GigabitEthernet', xge: 'TenGigabitEthernet', xgigabitethernet: 'TenGigabitEthernet', tengigabitethernet: 'TenGigabitEthernet', eth: 'Ethernet', ethernet: 'Ethernet', 'eth-trunk': 'Eth-Trunk', serial: 'Serial', meth: 'MEth' }
  return `${names[m[1].toLowerCase()] ?? m[1]}${m[2]}`
}

export function parseLldp(device, output) {
  if (typeof device !== 'string' || !device.trim() || typeof output !== 'string') throw new Error('device and output must be strings')
  if (/Error:|not enabled|not enable|LLDP.*disabled|unrecognized command/iu.test(output)) return { device, status: 'ERROR', neighbors: [], error: 'LLDP unavailable or command rejected' }
  const neighbors = []
  const add = (local, remote, port) => {
    if (local && remote && port) neighbors.push({ a: device, a_port: normalizeInterface(local), b: remote, b_port: normalizeInterface(port) })
  }
  let incomplete = false
  if (/Interface\s+\S+\s+has\s+\d+\s+Neighbors:/iu.test(output)) {
    for (const block of output.split(/Interface\s+(\S+)\s+has\s+(\d+)\s+Neighbors:/iu).slice(1).reduce((all, value, i, parts) => {
      if (i % 3 === 0) all.push({ local: value, count: Number(parts[i+1]), body: parts[i+2] })
      return all
    }, [])) {
      let parsed = 0
      for (const record of block.body.split(/Neighbor\s+\d+\s*:/iu).slice(1)) {
        const remote = /^\s*SysName\s*:\s*(\S+)/imu.exec(record)?.[1]
        const port = /^\s*PortId\s*:\s*([^\r\n]+)/imu.exec(record)?.[1]?.trim()
        if (remote && port) { add(block.local, remote, port); parsed++ }
      }
      incomplete ||= parsed !== block.count
    }
  } else if (/LLDP\s+neighbor-information\s+of\s+port/iu.test(output)) {
    for (const block of output.split(/LLDP\s+neighbor-information\s+of\s+port\s+/iu).slice(1)) {
      const local = /^([^:\r\n]+):/u.exec(block)?.[1]
      // A local port can have several neighbor records.
      for (const record of block.split(/Neighbor\s+index\s*:/iu)) {
        add(local, /^\s*System\s*name\s*:\s*(\S+)/imu.exec(record)?.[1], /^\s*Port\s*ID\s*:\s*([^\r\n]+)/imu.exec(record)?.[1]?.trim())
      }
    }
  } else {
    for (const line of output.split(/\r?\n/u)) {
      const row = line.trim().split(/\s*\|\s*|\s{2,}/u)
      if (row.length >= 3 && /^[A-Za-z-]+\s*\d+(?:\/\d+)+$/u.test(row[0]) && /^[A-Za-z-]+\s*\d+(?:\/\d+)+$/u.test(row[2])) add(row[0], row[1], row[2])
    }
  }
  const recognized = neighbors.length || /Local\s*Intf|Total\s+(?:neighbors|number)|no\s+(?:LLDP\s+)?neighbors|LLDP\s+neighbor-information|Interface\s+\S+\s+has\s+0\s+Neighbors:/iu.test(output)
  return { device, status: recognized && !incomplete ? 'OK' : 'UNKNOWN', neighbors,
    ...(incomplete ? { error: 'Neighbor identity missing or incomplete; collect display lldp neighbor detail output' } : {}) }
}

function edge(link) {
  if (!link || ['a','a_port','b','b_port'].some(k => typeof link[k] !== 'string' || !link[k].trim())) throw new Error('links require nonempty a, a_port, b, b_port')
  const endpoints = [[link.a, normalizeInterface(link.a_port)], [link.b, normalizeInterface(link.b_port)]].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return { key: JSON.stringify(endpoints), pair: JSON.stringify(endpoints.map(e => e[0]).sort()), link: { a: endpoints[0][0], a_port: endpoints[0][1], b: endpoints[1][0], b_port: endpoints[1][1] } }
}

export function compareLldp(links, observations, { maxAgeMs = null, requireBidirectional = true, now = Date.now() } = {}) {
  if (!Array.isArray(links) || !Array.isArray(observations)) throw new Error('links and observations must be arrays')
  if (typeof requireBidirectional !== 'boolean') throw new Error('require_bidirectional must be boolean')
  if (maxAgeMs !== null && (!Number.isInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 86400000)) throw new Error('max_age_ms must be 1..86400000')
  const scans = observations.map(o => {
    const scan = parseLldp(o?.device, o?.output)
    if (maxAgeMs !== null) {
      const timestamp = typeof o.collected_at === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(o.collected_at) ? Date.parse(o.collected_at) : NaN
      const age = now - timestamp
      if (!Number.isFinite(age) || age < -5000 || age > maxAgeMs) return { ...scan, status: 'STALE', collected_at: o.collected_at ?? null, error: 'Missing, future or expired collection timestamp' }
      return { ...scan, collected_at: o.collected_at, age_ms: age }
    }
    return scan
  })
  // Prefer the newest dated scan per device; stale or malformed scans remain
  // visible as evidence but cannot manufacture a topology difference.
  const newest = new Map()
  for (const scan of scans) if (scan.status === 'OK') {
    const old = newest.get(scan.device)
    if (!old || Date.parse(scan.collected_at) >= Date.parse(old.collected_at) || !scan.collected_at) newest.set(scan.device, scan)
  }
  const usable = [...newest.values()]
  const expected = new Map(links.map(l => { const e = edge(l); return [e.key,e] }))
  const actual = new Map(usable.flatMap(s => s.neighbors).map(l => { const e = edge(l); return [e.key,e] }))
  const directions = new Map()
  for (const scan of usable) for (const neighbor of scan.neighbors) {
    const key = edge(neighbor).key
    if (!directions.has(key)) directions.set(key, new Set())
    directions.get(key).add(scan.device)
  }
  const matched = [], topo_only = [], lldp_only = [], mismatched = []
  for (const [key,e] of expected) {
    if (actual.has(key)) { matched.push(e.link); actual.delete(key) }
    else topo_only.push(e)
  }
  // Retain all unmatched parallel links rather than pairing them arbitrarily.
  for (const e of topo_only) {
    const candidates = [...actual.values()].filter(a => a.pair === e.pair)
    if (candidates.length) mismatched.push({ expected: e.link, observed: candidates.map(a => a.link) })
  }
  lldp_only.push(...[...actual.values()].map(e => e.link))
  const covered = new Set(usable.map(s => s.device))
  const devices = [...new Set(links.flatMap(l => [l.a,l.b]))]
  const unobserved = devices.filter(d => !covered.has(d))
  const unidirectional = [...expected.values()].filter(e => directions.has(e.key) && directions.get(e.key).size !== 2).map(e => e.link)
  return { status: mismatched.length || lldp_only.length ? 'DIFFERENT' : !links.length || topo_only.length || unobserved.length || (requireBidirectional && unidirectional.length) || scans.some(s => s.status !== 'OK') ? 'INCONCLUSIVE' : 'MATCH', matched, topo_only: topo_only.map(e => e.link), lldp_only, mismatched, unobserved, unidirectional, freshness_checked: maxAgeMs !== null, require_bidirectional: requireBidirectional, scans,
    notes: ['LLDP absence is not proof of a missing cable; check enablement, boot state, timing and device support.', 'Device names must match exactly; renamed sysnames require explicit mapping before comparison.'] }
}

const RULES = [
  ['unrecognized_command', /unrecognized command/iu, '型号、版本或视图不支持该语法；先核对版本和帮助。', ['display version']],
  ['incomplete_command', /incomplete command/iu, '参数不完整，使用设备命令帮助补全。', []],
  ['ambiguous_command', /ambiguous command/iu, '缩写有歧义，使用完整关键字。', []],
  ['wrong_parameter', /wrong parameter|too many parameters/iu, '检查参数范围、数量和接口名称。', ['display ip interface brief']],
  ['wrong_view', /system view|wrong view|user view/iu, '确认当前提示符和命令所属视图。', []],
  ['connection_refused', /ECONNREFUSED|connection refused|连接失败/iu, '核对拓扑控制台端口与设备启动状态。', []],
  ['connection_closed', /connection closed|connection lost|对端关闭/iu, '会话可能注销或设备重启；重新探测后建立新会话。', []],
  ['timeout', /timeout|timed out|超时/iu, '执行结果未确认；先读取状态，避免重复下发配置。', []],
  ['interface_not_exist', /interface.*(?:not exist|does not exist)/iu, '核对设备实际接口和槽位。', ['display ip interface brief']],
  ['ip_conflict', /(?:IP|address).*(?:conflict|overlap)/iu, '核对接口地址与子网规划。', ['display ip interface brief']],
  ['vlan_not_exist', /vlan.*(?:not exist|does not exist)/iu, '检查 VLAN 是否已创建。', ['display vlan']],
  ['lldp_disabled', /LLDP.*(?:not enable|disabled)/iu, 'LLDP 未开启；是否开启应由调用方明确决定。', ['display lldp neighbor brief']],
]

export function diagnoseOutput(output) {
  if (typeof output !== 'string' || !output.trim()) throw new Error('output must be a nonempty string')
  const findings = RULES.filter(([, pattern]) => pattern.test(output)).map(([category,, suggestion, probes]) => ({ category, suggestion, probes }))
  const loss = /(\d+(?:\.\d+)?)%\s*packet loss/iu.exec(output)
  if (loss && Number(loss[1]) > 0) findings.push({ category: 'ping_loss', loss_percent: Number(loss[1]), suggestion: '检查接口、ARP、路由和策略；丢包率不能仅凭命令执行成功判定。', probes: ['display ip interface brief','display ip routing-table','display arp'] })
  return { status: findings.length ? 'FINDINGS' : 'UNKNOWN', findings, notes: ['规则匹配是诊断线索；未匹配不代表健康。不会自动修改或重试设备配置。'] }
}
