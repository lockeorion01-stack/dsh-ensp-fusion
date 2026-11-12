const VERIFIED = [
  { model: 'S5700', software: 'V200R001C00', vrp: '5.110', pattern: /Version\s+5\.110\s+\(S5700\s+V200R001C00\)/iu,
    verified: ['console', 'vlan', 'interface', 'static-route', 'ping', 'startup-file', 'lldp-brief'] },
  { model: 'USG6000V', software: 'V500R005C10SPC300', vrp: '5.170', pattern: /Version\s+5\.170\s+\(USG6000V1\s+V500R005C10SPC300\)/iu,
    verified: ['console', 'security-policy', 'source-nat-session', 'static-route', 'ping', 'startup-file', 'lldp-detail'] },
  { model: 'AR2220', software: 'V200R003C00', vrp: '5.130', pattern: /Version\s+5\.130\s+\(AR2200\s+V200R003C00\)/iu,
    verified: ['console', 'interface', 'static-route', 'ping', 'startup-file', 'lldp-brief'] },
]

export function identifyCompatibility(output) {
  const profile = VERIFIED.find(profile => profile.pattern.test(output)
    && (profile.model !== 'AR2220' || /Huawei\s+AR2220\s+Router/iu.test(output)))
  if (!profile) return { status: 'UNVERIFIED', model: null, verified_features: [], notes: ['No matching historical device/version acceptance profile. Topology builder support does not establish runtime command compatibility.'] }
  return { status: 'HISTORICALLY_VERIFIED', model: profile.model, software: profile.software, vrp: profile.vrp,
    observed_failures: profile.model==='S5700'?[{feature:'layer2-tcp-acl',status:'OBSERVED_FAIL',date:'2026-11-12',
      scope:'S5700 VRP5.110/V200R001C00 isolated VLAN77 test: interface/VLAN TCP deny configuration accepted but native guest HTTP remained reachable in three attempts. Not a universal unsupported-feature claim.',
      evidence:'PRIORITY-COMPLETION-20261112.zh-CN.md / policy1, policy2, policy3'}]:[],
    verified_features: profile.verified, environment: 'eNSP 1.2.0.500 / Windows', acceptance_date: '2026-11-11',
    notes: ['Profile identifies previously accepted model/version; current business health still requires explicit assertions.', 'Host service probes and native guest-service acceptance are separate evidence scopes; see ACCEPTANCE-RUNNER.zh-CN.md.', 'Command acceptance alone does not verify forwarding or ACL enforcement; unlisted features remain unverified.'] }
}
