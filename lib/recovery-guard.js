import { createHash } from 'node:crypto'

const hash = value => createHash('sha256').update(value).digest('hex')
export function configurationFingerprint(configuration) {
  // Pager redraws add indentation; native async logs are evidence, not config.
  const lines = String(configuration).replace(/\r/gu, '').split('\n').map(line => line.trim()
    // This native log can share the pager redraw line with real configuration.
    // Remove its complete, bounded grammar, retaining the configuration suffix.
    .replace(/^(?:\*?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{4}\s+\S+\s+\S+\s+)DS\/4\/DATASYNC_CFGCHANGE:OID [\d.]+ configurations have been changed\. The current change number is \d+, the change loop count is \d+, and the maximum number of records is \d+\.\s*/u,'')
    .replace(/^(?:\*?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{4}\s+\S+\s+\S+\s+)LLDP\/4\/NBRCHGTRAP:OID: [\d.]+ Neighbor information is changed\. \(LldpStatsRemTablesInserts=\d+, LldpStatsRemTablesDeletes=\d+, LldpStatsRemTablesDrops=\d+, LldpStatsRemTablesAgeouts=\d+\)\s*/u,'')
    .replace(/^(?:\*?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{4}\s+\S+\s+\S+\s+)?%%\d+PHY\/[0-7]\/PHY\(l\)\[\d+\]:\s+[A-Za-z0-9/.-]+: change status to (?:up|down)\s*/u,'').trim())
    .filter(line => line && !/^%%/u.test(line)
      // USG prepends a standalone console clock to display output. It is not
      // configuration and changes between the guarded write and recovery.
      && !/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(line)
      && !/^(?:\*?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{4}\b|\d{4}-\d{2}-\d{2}\b).*(?:%%|\b[A-Z][A-Z0-9_]*\/[0-7]\/[A-Z0-9_]+:)/iu.test(line))
  if (!lines.some(line => /^sysname\s+\S+$/u.test(line))) throw new Error('Recovery guard requires a configuration with sysname')
  return hash(lines.join('\n'))
}
export function makeRecoveryGuard(configuration, version) {
  const sysname = /^\s*sysname\s+(\S+)\s*$/mu.exec(configuration)?.[1]
  const identity = String(version).split(/\r?\n/u).map(line => line.trim().replace(/\s+uptime\b.*$/iu, ''))
    .filter(line => /\bVersion\s+\d/iu.test(line) || /(?:Huawei|Quidway).*(?:Router|Switch|Firewall)/iu.test(line))
  if (!sysname || !identity.some(line => /\bVersion\s+\d/iu.test(line))) throw new Error('Recovery guard could not identify device software')
  return { version: 1, sysname, identity_hash: hash(identity.join('\n')), configuration_hash: configurationFingerprint(configuration) }
}
export function validateRecoveryGuard(guard) {
  if (guard?.version !== 1 || typeof guard.sysname !== 'string' || !/^[^\s\p{Cc}]{1,128}$/u.test(guard.sysname)
    || !/^[a-f0-9]{64}$/u.test(guard.identity_hash) || !/^[a-f0-9]{64}$/u.test(guard.configuration_hash)) throw new Error('Invalid recovery guard')
  return guard
}
export function verifyRecoveryGuard(expected, configuration, version) {
  validateRecoveryGuard(expected)
  const actual = makeRecoveryGuard(configuration, version)
  if (expected.sysname !== actual.sysname || expected.identity_hash !== actual.identity_hash) throw new Error('Recovery blocked: device identity differs from the recorded post-change state')
  if (expected.configuration_hash !== actual.configuration_hash) throw new Error('Recovery blocked: configuration drift detected; review current state and create a new recovery plan')
  return { verified: true, sysname: actual.sysname, identity_hash: actual.identity_hash, configuration_hash: actual.configuration_hash }
}
