import { MODEL_SPECS } from '../upstream/lizi600jin/src/core/build.mjs'

function decode(text) {
  return text.replace(/&(?:quot|apos|lt|gt|amp);|&#(?:x[\da-f]+|\d+);/giu, token => {
    if (token.startsWith('&#')) return String.fromCodePoint(parseInt(token.slice(token[2].toLowerCase() === 'x' ? 3 : 2, -1), token[2].toLowerCase() === 'x' ? 16 : 10))
    return { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' }[token]
  })
}
const attributes = text => Object.fromEntries([...text.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/gu)].map(m => [m[1], decode(m[2])]))

// Read the device's own declaration order. Never map an unknown or invalid
// port index to a guessed GE port; return it as unresolved evidence instead.
export function topologyLldpLinks(xml) {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new Error('DTD/entity declarations are not supported')
  xml = xml.replace(/<!--[\s\S]*?-->/gu, '')
  const devices = new Map(), names = new Set()
  for (const m of xml.matchAll(/<dev\b([^>]*)>([\s\S]*?)<\/dev>/gu)) {
    const d = attributes(m[1]), ports = []
    let groupIndex = 0, legacyMismatch = false
    if (!d.id || !d.name || devices.has(d.id) || names.has(d.name)) throw new Error('topology requires unique device IDs and names')
    names.add(d.name)
    for (const declaration of m[2].matchAll(/<interface\b([^>]*)\/?\s*>/gu)) {
      const p = attributes(declaration[1])
      if (p.interfaceIndex !== undefined) {
        const family = { GE: 'GigabitEthernet', Ethernet: 'Ethernet', XGE: 'TenGigabitEthernet', Serial: 'Serial' }[p.type]
        ports.push(family && [p.slotIndex, p.cardIndex, p.interfaceIndex].every(v => /^\d+$/u.test(v ?? ''))
          ? `${family}${p.slotIndex}/${p.cardIndex}/${p.interfaceIndex}` : null)
      } else {
        const count = Number(p.count)
        if (!Number.isInteger(count) || count < 1 || count > 256) throw new Error('invalid interface declaration count')
        const spec = MODEL_SPECS[d.model], group = spec?.groups[groupIndex++]
        if (!group || group[0] !== p.sztype || group[1] !== p.interfacename || group[2] !== count) legacyMismatch = true
        const prefix = group?.[4] ?? (group?.[1] === 'GE' ? 'GigabitEthernet0/0/' : 'Ethernet0/0/')
        for (let i = 0; i < count; i++) ports.push(group && prefix ? `${prefix}${(group[3] ?? spec.base) + i}` : null)
      }
    }
    if (groupIndex && groupIndex !== MODEL_SPECS[d.model]?.groups.length) legacyMismatch = true
    devices.set(d.id, { ...d, ports: legacyMismatch ? ports.map(() => null) : ports })
  }
  const links = [], excluded = [], unresolved = []
  for (const m of xml.matchAll(/<line\b([^>]*)>([\s\S]*?)<\/line>/gu)) {
    const line = attributes(m[1]), pair = attributes(/<interfacePair\b([^>]*)>/u.exec(m[2])?.[1] ?? '')
    const a = devices.get(line.srcDeviceID), b = devices.get(line.destDeviceID)
    const indices = [pair.srcIndex, pair.tarIndex]
    const descriptor = { a: a?.name ?? line.srcDeviceID, b: b?.name ?? line.destDeviceID }
    if (!a || !b || !indices.every(v => /^\d+$/u.test(v ?? '')) || !a.ports[Number(indices[0])] || !b.ports[Number(indices[1])]) {
      unresolved.push({ ...descriptor, reason: 'Unknown device or unmapped declared interface index' }); continue
    }
    const link = { a: a.name, a_port: a.ports[Number(indices[0])], b: b.name, b_port: b.ports[Number(indices[1])] }
    if ([a.model, b.model].some(model => ['PC', 'Client', 'Server', 'Cloud'].includes(model))) excluded.push({ ...link, reason: 'Endpoint does not participate in LLDP verification' })
    else links.push(link)
  }
  return { links, excluded, unresolved }
}
