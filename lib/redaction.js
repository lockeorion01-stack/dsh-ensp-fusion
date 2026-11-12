// Shared at artifact/tool boundaries. Transport keeps raw evidence internally
// so parsing and assertions are evaluated before presentation is sanitized.
export function scrubSensitiveText(value) {
  return String(value)
    .replace(/(^\s*(?:(?:local-user|snmp-agent|radius-server|hwtacacs-server|authentication|ospf|isis|ike|ipsec|nqa|ntp-service|bgp)\b[^\r\n]*?\b)?(?:password|cipher|secret|community|private-key|pre-shared-key|authentication-key|shared-key)\s+)[^\r\n]*/gimu, '$1[REDACTED]')
    .replace(/\b((?:https?|ftp):\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[REDACTED]@')
    .replace(/^(\s*(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*).*$/gimu, '$1[REDACTED]')
}

export function createRedactor(secrets = [], { configuration = true } = {}) {
  const values = [...new Set(secrets.filter(value => typeof value === 'string' && value.length)
    .flatMap(value => [value, JSON.stringify(value).slice(1, -1)]))].sort((a, b) => b.length - a.length)
  const pattern = values.length ? new RegExp(values.map(value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'gu') : null
  return value => {
    const text = String(value ?? '')
    const cleaned = pattern ? text.replace(pattern, '[REDACTED]') : text
    return configuration ? scrubSensitiveText(cleaned) : cleaned
  }
}

export function credentialValues(value) {
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, item]) =>
    /^(?:password|passwords|new_password|newPassword|token|authorization)$/iu.test(key)
      ? (Array.isArray(item) ? item : [item]).filter(v => typeof v === 'string')
      : (item && typeof item === 'object' ? credentialValues(item) : []))
}

export function redactValue(value, redact = createRedactor()) {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(item => redactValue(item, redact))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(?:password|passwords|new_password|token|authorization)$/iu.test(key) ? '[REDACTED]' : redactValue(item, redact)]))
  return value
}
