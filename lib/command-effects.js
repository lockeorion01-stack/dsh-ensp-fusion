// This legacy rule controls auto-save only. It is NOT a read-only permission.
export function shouldAutoSave(commands) {
  return commands.some(command => !/^(?:$|display\b|dis\s|ping\b|tracert\b|dir\b|more\b|save\b|screen-length\b|system-view\b|quit\b|return\b|undo\s+terminal\b|terminal\b|reset\s+counters\b|refresh\b)/iu.test(String(command ?? '').trim()))
}
export function classifyCommandEffects(command) {
  const line = String(command ?? '').trim()
  let kind = 'unknown'
  if (line && !/[\p{Cc}\p{Cf};|&<>`]/u.test(line) && !/\$\(/u.test(line)) {
    if (/^(?:display\s+(?:version|current-configuration|saved-configuration|startup|interface|ip\s+(?:interface|routing-table)|ospf\s+peer|lldp\s+neighbor)|dir)(?:\s|$)/iu.test(line)) kind = 'query'
    else if (/^(?:ping|tracert)(?:\s|$)/iu.test(line)) kind = 'active_probe'
    else if (/^save(?:\s|$)/iu.test(line)) kind = 'persistence'
    else if (/^(?:reset\s+counters|refresh)(?:\s|$)/iu.test(line)) kind = 'state_change'
    else if (/^(?:system-view|quit|return|screen-length\s+\d+|(?:undo\s+)?terminal\s+\S+)$/iu.test(line)) kind = 'session_control'
  }
  return { kind, read_only: kind === 'query', generates_traffic: kind === 'active_probe', replay_allowed: false }
}
