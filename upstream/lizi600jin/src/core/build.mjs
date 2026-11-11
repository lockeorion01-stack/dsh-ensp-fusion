/**
 * Topology construction helpers.
 *
 * Building a `.topo` by hand is error-prone because eNSP validates a surprising
 * amount of derived state on load. The rules below were reverse-engineered from
 * files eNSP itself wrote and confirmed by opening generated topologies
 * (`docs/UI-ANCHORS.md` records the surrounding experiments):
 *
 * | Rule | Value |
 * |---|---|
 * | XML declaration | says `encoding="UNICODE"`, file is actually UTF-8 |
 * | `edit_left` / `edit_top` | `cx + 27` / `cy + 54` |
 * | attribute order | `id name model settings com_port bootmode cx cy edit_left edit_top` |
 * | switch interfaces | one slot, `interfacename="GE"`, index base 1 |
 * | PC / Server interfaces | `interfacename="Ethernet"`, index base 1 |
 * | router / firewall interfaces | `interfacename="GE"`, index base 0 |
 * | cable anchors | on the icon's bounding box: `x-16.2` / `x+70.2`, `y-16.2` / `y+70.2` |
 *
 * Two mistakes cost real debugging time and are called out in the code:
 * declaring PC interfaces as `GE` (eNSP silently renders an empty canvas) and
 * omitting `system_mac` handling (the attribute is absent from native files).
 *
 * @module dsh-ensp/build
 */

import { randomUUID } from 'node:crypto'

import { serialiseTopology, interfaceIndex } from './topology.mjs'

/**
 * Interface declarations per model, in slot order, plus the index base.
 *
 * `prefix` is what eNSP writes in `interfacename=`; `vrp` is the name the device
 * itself uses, which differs for switches (`GE` in the file, `GigabitEthernet`
 * on the CLI).
 */
/**
 * Interface declarations per model, **in the exact grouping eNSP writes**.
 *
 * This grouping is not cosmetic. eNSP reconstructs a device's port list from these
 * `<interface>` elements; a single `count="3"` on an AR2220 does not parse into
 * GE0/0/0 + GE0/0/1..2 and the device silently fails to render (empty canvas, no
 * error). The groups below were counted across all 40 bundled sample topologies.
 *
 * `vrp` is the CLI prefix; indices walk the groups in order from 0.
 */
export const MODEL_SPECS = {
  // 24 GE ports, all in one group.
  S5700: { groups: [['Ethernet', 'GE', 24, 1]], base: 1, vrp: 'GigabitEthernet0/0/', console: true },
  // 22 fast ports (Ethernet0/0/1..22) then 2 gigabit (GE0/0/1..2).
  S3700: {
    groups: [['Ethernet', 'Ethernet', 22, 1], ['Ethernet', 'GE', 2, 1]],
    base: 1,
    vrp: 'Ethernet0/0/',
    console: true,
  },
  // 1 + 2: GE0/0/0, then GE0/0/1..2 — the split is required, and the second group
  // starts numbering at 1, not 0.
  AR2220: { groups: [['Ethernet', 'GE', 1, 0], ['Ethernet', 'GE', 2, 1]], base: 0, vrp: 'GigabitEthernet0/0/', console: true },
  AR2240: { groups: [['Ethernet', 'GE', 4, 0]], base: 0, vrp: 'GigabitEthernet0/0/', console: true },
  // 2 GE (GE0/0/0..1) + 8 Ethernet (Ethernet0/0/0..7).
  AR1220: {
    groups: [['Ethernet', 'GE', 2, 0], ['Ethernet', 'Ethernet', 8, 0]],
    base: 0,
    vrp: 'GigabitEthernet0/0/',
    console: true,
  },
  USG5500: { groups: [['Ethernet', 'GE', 9, 0]], base: 0, vrp: 'GigabitEthernet1/0/', console: true },
  USG6000V: { groups: [['Ethernet', 'GE', 1, 0, 'GigabitEthernet0/0/'], ['Ethernet', 'GE', 7, 0, 'GigabitEthernet1/0/']], base: 0, vrp: 'GigabitEthernet1/0/', console: true },
  AC6005: { groups: [['Ethernet', 'GE', 8, 1]], base: 1, vrp: 'GigabitEthernet0/0/', console: true },
  // NOTE: the file says `interfacename="GE"` but the CLI port is Ethernet0/0/1 —
  // eNSP's file vocabulary and VRP's CLI vocabulary differ for this model.
  // Declares `interfacename="GE"` but the CLI port is Ethernet0/0/1 — eNSP's file
  // vocabulary and VRP's vocabulary differ here, so the CLI family is explicit.
  PC: { groups: [['Ethernet', 'GE', 1, 1, 'Ethernet0/0/']], base: 1, vrp: 'Ethernet0/0/', console: false },
  Server: { groups: [['Ethernet', 'GE', 1, 1, 'Ethernet0/0/']], base: 1, vrp: 'Ethernet0/0/', console: false },
  Cloud: { groups: [['Ethernet', 'Ethernet', 3, 0]], base: 0, vrp: 'Ethernet0/0/', console: false },
}

/** Total ports across groups. */
function totalPorts(spec) {
  return spec.groups.reduce((n, g) => n + g[2], 0)
}

/**
 * Resolve a VRP interface name to the flat index eNSP stores.
 *
 * The flat index walks every declared group, so on an AR1220 index 2 is the first
 * `Ethernet` port, not `GE0/0/2`.
 */
export function vrpToFlatIndex(model, port) {
  const spec = MODEL_SPECS[model]
  if (!spec) return null

  // A model can expose several CLI families (AR1220: GE for its 2 gigabit ports,
  // Ethernet for its 8 fast ports), and the flat index simply continues across them
  // in declaration order. Walk the groups and test each group's own CLI prefix.
  let offset = 0
  for (const group of spec.groups) {
    const [, enspPrefix, count] = group
    const firstNumber = group[3] ?? spec.base
    const cliPrefix = group[4] ?? cliPrefixFor(enspPrefix)
    if (port.startsWith(cliPrefix)) {
      const tail = port.slice(cliPrefix.length)
      if (/^\d+$/.test(tail)) {
        const n = Number(tail) - firstNumber
        if (n >= 0 && n < count) return offset + n
      }
    }
    offset += count
  }
  return null
}

/** CLI prefix for an eNSP interface-name group. */
function cliPrefixFor(enspPrefix) {
  return enspPrefix === 'GE' ? 'GigabitEthernet0/0/' : 'Ethernet0/0/'
}

/** Canvas geometry, matching eNSP's own writer. */
export const ICON = { w: 86, h: 86, left: -16.2, right: 70.2, top: -16.2, bottom: 70.2 }

/**
 * `settings` blob eNSP writes for a simulated PC. Empty for every other model.
 * Without it eNSP still shows the PC but with no address, which breaks the
 * "ping between the two PCs" step.
 */
function pcSettings({ ip = '192.168.10.1', mask = '255.255.255.0', gateway = '192.168.10.254', mac } = {}) {
  const macAddr = mac ?? `54-89-98-${Array.from({ length: 3 }, () =>
    Math.floor(Math.random() * 256).toString(16).toUpperCase().padStart(2, '0')).join('-')}`
  return (
    ` -simpc_ip ${ip}  -simpc_mask ${mask}  -simpc_gateway ${gateway}  -simpc_mac ${macAddr}` +
    '  -simpc_mc_dstip 0.0.0.0  -simpc_mc_dstmac 00-00-00-00-00-00' +
    '  -simpc_dns1 0.0.0.0  -simpc_dns2 0.0.0.0' +
    '  -simpc_ipv6 ::  -simpc_prefix 128  -simpc_gatewayv6 ::' +
    '  -simpc_dhcp_state 0  -simpc_dhcpv6_state 0  -simpc_dns_auto_state 0 '
  )
}

/**
 * Fluent topology builder.
 */
export class TopologyBuilder {
  #devices = []
  #links = []
  #nextComPort

  constructor({ firstComPort = 2000 } = {}) {
    this.#nextComPort = firstComPort
  }

  /**
   * Add a device.
   *
   * @param {string} name
   * @param {string} model - key of {@link MODEL_SPECS}
   * @param {{x?: number, y?: number, comPort?: number|null, bootmode?: number,
   *   pc?: {ip?: string, mask?: string, gateway?: string, mac?: string}}} [options]
   */
  add(name, model, options = {}) {
    const spec = MODEL_SPECS[model]
    if (!spec) throw new Error(`unknown model "${model}"; known: ${Object.keys(MODEL_SPECS).join(', ')}`)
    if (this.#devices.some((d) => d.name === name)) throw new Error(`duplicate device name "${name}"`)

    const comPort =
      options.comPort !== undefined
        ? options.comPort
        : spec.console
          ? this.#nextComPort++
          : 0

    this.#devices.push({
      id: randomUUID(),
      name,
      model,
      settings: model === 'PC' ? pcSettings(options.pc) : '',
      comPort,
      bootmode: options.bootmode ?? 1,
      x: options.x ?? 100,
      y: options.y ?? 100,
    })
    return this
  }

  /**
   * Connect two devices using **VRP interface names** (what you type on the CLI).
   *
   * @param {string} aName
   * @param {string} aPort e.g. `GigabitEthernet0/0/1` or `Ethernet0/0/1`
   * @param {string} bName
   * @param {string} bPort
   * @param {{media?: string}} [options]
   */
  link(aName, aPort, bName, bPort, options = {}) {
    const a = this.#devices.find((d) => d.name === aName)
    const b = this.#devices.find((d) => d.name === bName)
    if (!a) throw new Error(`no device "${aName}"`)
    if (!b) throw new Error(`no device "${bName}"`)

    const ai = this.#vrpToIndex(a, aPort)
    const bi = this.#vrpToIndex(b, bPort)

    this.#links.push({
      srcId: a.id,
      dstId: b.id,
      srcIndex: ai,
      dstIndex: bi,
      media: options.media ?? 'Copper',
    })
    return this
  }

  /** Map a VRP interface name to the flat slot index eNSP stores. */
  #vrpToIndex(device, port) {
    const spec = MODEL_SPECS[device.model]
    if (!spec) throw new Error(`unknown model "${device.model}"`)
    const index = vrpToFlatIndex(device.model, port)
    if (index === null) {
      const all = spec.groups
        .map((g) => {
          const first = g[3] ?? spec.base
          return `${cliPrefixFor(g[1])}${first}..${first + g[2] - 1}`
        })
        .join(', ')
      throw new Error(
        `${device.name} (${device.model}) has no interface ${port}; expected one of: ${all}`,
      )
    }
    return index
  }

  finish() {
    return {
      devices: this.#devices.map((d) => ({ ...d })),
      links: this.#links.map((l) => ({ ...l })),
    }
  }

  toXml() {
    return serialiseTopology(this.finish())
  }
}

/** Start a builder. */
export function buildTopology(options) {
  return new TopologyBuilder(options)
}

/**
 * Deterministic grid layout.
 * @param {object} topo
 */
export function autoLayout(topo, { columns = 4, paddingX = 220, paddingY = 200, originX = 120, originY = 80 } = {}) {
  topo.devices.forEach((device, i) => {
    device.x = originX + (i % columns) * paddingX
    device.y = originY + Math.floor(i / columns) * paddingY
  })
  return topo
}

/**
 * Two PCs on one Layer-2 switch — the smallest lab that proves the whole chain
 * (generate → open → boot → configure → verify).
 *
 * @param {{vlan?: number, subnet?: string}} [options]
 */
export function twoPcLab({ vlan = 10, subnet = '192.168.10' } = {}) {
  const topo = buildTopology({ firstComPort: 2000 })
    .add('SW1', 'S5700', { x: 300, y: 120 })
    .add('PC1', 'PC', { x: 180, y: 320, pc: { ip: `${subnet}.1`, gateway: `${subnet}.254` } })
    .add('PC2', 'PC', { x: 420, y: 320, pc: { ip: `${subnet}.2`, gateway: `${subnet}.254` } })
    .link('PC1', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/1')
    .link('PC2', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/2')
    .finish()

  topo.meta = { vlan, subnet, pc1: `${subnet}.1`, pc2: `${subnet}.2` }
  return topo
}

/**
 * Switch configuration for {@link twoPcLab}: both ports into one VLAN.
 * @param {{vlan?: number}} [options]
 */
export function twoPcLabConfig({ vlan = 10 } = {}) {
  return [
    'system-view',
    `vlan ${vlan}`,
    ' quit',
    'interface GigabitEthernet0/0/1',
    ' port link-type access',
    ` port default vlan ${vlan}`,
    ' quit',
    'interface GigabitEthernet0/0/2',
    ' port link-type access',
    ` port default vlan ${vlan}`,
    ' quit',
    'return',
  ].join('\n')
}
