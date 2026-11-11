/**
 * eNSP `.topo` reader/writer.
 *
 * The format is a flat XML document that eNSP itself writes, with three parts
 * that matter to us:
 *
 *   <devices>  one <dev> per device: name, model, com_port, canvas position
 *   <lines>    one <line> per cable, each holding an <interfacePair>
 *   <shapes>   purely decorative annotations
 *
 * Two field quirks were established by experiment and are load-bearing:
 *
 * - `edit_left` / `edit_top` are derived, not independent: `edit_left = cx + 27`
 *   and `edit_top = cy + 54`. Writing them consistently is what keeps a
 *   generated file openable instead of corrupt.
 * - Interface indices inside `<interfacePair>` are **flat indices over the
 *   slot's declared interface list**, starting at 0, not `a/b/c` strings. A
 *   model declares `count` interfaces in `<slot>` order and the index walks that
 *   list, which is why this module carries a port table per model.
 *
 * @module dsh-ensp/topology
 */

import { readFile, writeFile } from 'node:fs/promises'

/**
 * Must stay in sync with build.mjs `MODEL_SPECS` (duplicated to avoid a circular
 * import). Each model lists its `<interface>` declarations **exactly as eNSP
 * writes them**; see `docs/ENSP-FORMAT.md`.
 */
const MODEL_SPECS = {
  S5700: { groups: [['Ethernet', 'GE', 24, 1]] },
  S3700: { groups: [['Ethernet', 'Ethernet', 22, 1], ['Ethernet', 'GE', 2, 1]] },
  AR2220: { groups: [['Ethernet', 'GE', 1, 0], ['Ethernet', 'GE', 2, 1]] },
  AR2240: { groups: [['Ethernet', 'GE', 4, 0]] },
  AR1220: { groups: [['Ethernet', 'GE', 2, 0], ['Ethernet', 'Ethernet', 8, 0]] },
  USG5500: { groups: [['Ethernet', 'GE', 9, 0]] },
  USG6000V: { groups: [['Ethernet', 'GE', 1, 0, 'GigabitEthernet0/0/'], ['Ethernet', 'GE', 7, 0, 'GigabitEthernet1/0/']] },
  AC6005: { groups: [['Ethernet', 'GE', 8, 1]] },
  // PC/Server declare GE in the file but expose Ethernet0/0/1 on the CLI.
  PC: { groups: [['Ethernet', 'GE', 1, 1, 'Ethernet0/0/']] },
  Server: { groups: [['Ethernet', 'GE', 1, 1, 'Ethernet0/0/']] },
  Cloud: { groups: [['Ethernet', 'Ethernet', 3, 0]] },
}

/**
 * Icon bounding box, measured from every cable anchor in eNSP's own samples.
 *
 * The box is **not** centred on (cx, cy): it runs from `cx - 16.2` to
 * `cx + 70.2` horizontally, so its centre is `cx + 27`, not `cx + 43`. Using
 * `height / 2` puts the anchor outside the icon and eNSP then rejects the whole
 * `<lines>` block, which shows up as an empty canvas with no error message.
 *
 * Frequencies across the bundled samples: (+70.2,+27.0) x35, (-16.2,+27.0) x35,
 * (+27.0,+70.2) x29, (+27.0,-16.2) x27.
 */
const ICON = {
  left: -16.2,
  right: 70.2,
  top: -16.2,
  bottom: 70.2,
  centerX: 27.0,
  centerY: 27.0,
}

/**
 * Interfaces exposed by each model eNSP can run, in declaration order.
 * `prefix` + index (offset by `base`) gives the VRP name.
 *
 * Only the models this project actually uses are listed; add more as needed.
 */
export const MODELS = {
  S5700: { ports: [{ prefix: 'GigabitEthernet0/0/', count: 24, base: 1 }], comPort: true },
  S3700: { ports: [{ prefix: 'Ethernet0/0/', count: 24, base: 1 }], comPort: true },
  AR2220: { ports: [{ prefix: 'GigabitEthernet0/0/', count: 3, base: 0 }], comPort: true },
  AR2240: { ports: [{ prefix: 'GigabitEthernet0/0/', count: 4, base: 0 }], comPort: true },
  AR1220: { ports: [{ prefix: 'GigabitEthernet0/0/', count: 8, base: 0 }], comPort: true },
  USG5500: { ports: [{ prefix: 'GigabitEthernet1/0/', count: 9, base: 0 }], comPort: true },
  USG6000V: { ports: [{ prefix: 'GigabitEthernet0/0/', count: 1, base: 0 }, { prefix: 'GigabitEthernet1/0/', count: 7, base: 0 }], comPort: true },
  AC6005: { ports: [{ prefix: 'GigabitEthernet0/0/', count: 8, base: 1 }], comPort: true },
  PC: { ports: [{ prefix: 'Ethernet0/0/', count: 1, base: 1 }], comPort: false },
  Server: { ports: [{ prefix: 'Ethernet0/0/', count: 1, base: 1 }], comPort: false },
  Cloud: { ports: [{ prefix: 'Ethernet0/0/', count: 32, base: 0 }], comPort: false },
}

/** Canvas geometry constants, taken from eNSP's own writer. */
export const GEOMETRY = {
  editLeftOffset: 27,
  editTopOffset: 54,
}

/**
 * Resolve a flat interface index into a VRP interface name for a model.
 *
 * @param {string} model
 * @param {number} index
 * @returns {string|null}
 */
export function interfaceName(model, index) {
  const spec = MODEL_SPECS[model]
  if (!spec) return null
  let remaining = index
  for (const group of spec.groups) {
    const [, enspPrefix, count, firstNumber, cliOverride] = group
    const cli = cliOverride ?? (enspPrefix === 'GE' ? 'GigabitEthernet0/0/' : 'Ethernet0/0/')
    const first = firstNumber ?? (cli.startsWith('Gigabit') ? 0 : 0)
    if (remaining < count) return `${cli}${remaining + first}`
    remaining -= count
  }
  return null
}

/**
 * Inverse of {@link interfaceName}.
 *
 * @param {string} model
 * @param {string} name
 * @returns {number|null} flat index, or null when the name does not belong to the model
 */
export function interfaceIndex(model, name) {
  const spec = MODEL_SPECS[model]
  if (!spec) return null
  let offset = 0
  for (const group of spec.groups) {
    const [, enspPrefix, count, firstNumber, cliOverride] = group
    const cli = cliOverride ?? (enspPrefix === 'GE' ? 'GigabitEthernet0/0/' : 'Ethernet0/0/')
    const first = firstNumber ?? 0
    if (name.startsWith(cli)) {
      const tail = name.slice(cli.length)
      if (/^\d+$/.test(tail)) {
        const n = Number(tail) - first
        if (n >= 0 && n < count) return offset + n
      }
    }
    offset += count
  }
  return null
}

/** Total declared interface count for a model. */
function portCount(model) {
  const spec = MODELS[model]
  if (!spec) return 0
  return spec.ports.reduce((sum, g) => sum + g.count, 0)
}

/** Decode one attribute from a tag's raw text. */
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`))
  return m ? m[1] : null
}

/**
 * Parse a `.topo` document.
 *
 * @param {string} xml
 * @returns {{version: string|null, devices: Array<{
 *   id: string, name: string, model: string, comPort: number|null,
 *   bootmode: number, x: number, y: number, interfaces: number }>,
 *   links: Array<{srcId: string, dstId: string, srcIndex: number, dstIndex: number,
 *   media: string, srcName: string, dstName: string, srcPort: string|null, dstPort: string|null}>}}
 */
export function parseTopology(xml) {
  const version = attr(xml.match(/<topo[^>]*>/)?.[0] ?? '', 'version')

  const devices = []
  for (const m of xml.matchAll(/<dev\b([^>]*)>([\s\S]*?)<\/dev>/g)) {
    const head = m[1]
    const body = m[2]
    const model = attr(head, 'model')
    const declared = [...body.matchAll(/<interface\b[^>]*count="(\d+)"/g)]
      .reduce((sum, x) => sum + Number(x[1]), 0)
    devices.push({
      id: attr(head, 'id'),
      name: attr(head, 'name'),
      model,
      comPort: Number(attr(head, 'com_port') ?? 0) || null,
      bootmode: Number(attr(head, 'bootmode') ?? 0),
      x: Number(attr(head, 'cx') ?? 0),
      y: Number(attr(head, 'cy') ?? 0),
      interfaces: declared || portCount(model),
    })
  }

  const byId = new Map(devices.map((d) => [d.id, d]))
  const links = []
  for (const m of xml.matchAll(/<line\b([^>]*)>([\s\S]*?)<\/line>/g)) {
    const head = m[1]
    const body = m[2]
    const pair = body.match(/<interfacePair\b([^>]*)>/)?.[1] ?? ''
    const srcId = attr(head, 'srcDeviceID')
    const dstId = attr(head, 'destDeviceID')
    const src = byId.get(srcId)
    const dst = byId.get(dstId)
    const srcIndex = Number(attr(pair, 'srcIndex') ?? 0)
    const dstIndex = Number(attr(pair, 'tarIndex') ?? 0)
    links.push({
      srcId,
      dstId,
      srcIndex,
      dstIndex,
      media: attr(pair, 'lineName') ?? 'Copper',
      srcName: src?.name ?? null,
      dstName: dst?.name ?? null,
      srcPort: src ? interfaceName(src.model, srcIndex) : null,
      dstPort: dst ? interfaceName(dst.model, dstIndex) : null,
    })
  }

  return { version, devices, links }
}

/**
 * Read and parse a `.topo` file.
 *
 * eNSP writes a UTF-8 file while its XML declaration says `encoding="UNICODE"`,
 * so we ignore the declaration and decode as UTF-8, stripping a BOM if present.
 *
 * @param {string} file
 */
export async function readTopology(file) {
  const raw = await readFile(file)
  const text = raw.toString('utf8').replace(/^\uFEFF/, '')
  return { ...parseTopology(text), file }
}

/**
 * Build the `<devices>` block exactly as eNSP writes it.
 *
 * Attribute order matters for byte-level diffing against native files, and
 * `system_mac` must be absent (native files only include it for a few models).
 */
function renderDevices(devices) {
  const rows = devices.map((d) => {
    const spec = MODEL_SPECS[d.model] ?? { groups: [['Ethernet', 'GE', 24]] }
    const editLeft = Math.round(d.x + GEOMETRY.editLeftOffset)
    const editTop = Math.round(d.y + GEOMETRY.editTopOffset)
    const settings = d.settings ?? ''
    const interfaces = spec.groups
      .map(([sztype, name, count]) =>
        `                <interface sztype="${sztype}" interfacename="${name}" count="${count}" />`)
      .join('\n')
    const slot = d.model === 'USG6000V'
      ? '            <slot id="1">\n' + Array.from({length:8}, (_,i) =>
          `                <interface category="Ethernet" type="GE" slotIndex="${i ? 1 : 0}" cardIndex="0" interfaceIndex="${i ? i-1 : 0}" />`).join('\n') + '\n            </slot>\n'
      : `            <slot number="slot17" isMainBoard="1">\n${interfaces}\n            </slot>\n`
    return (
      `        <dev id="${d.id}" name="${d.name}" model="${d.model}" settings="${settings}" ` +
      `com_port="${d.comPort ?? 0}" bootmode="${d.bootmode ?? 1}" ` +
      `cx="${d.x.toFixed(6)}" cy="${d.y.toFixed(6)}" ` +
      `edit_left="${editLeft}" edit_top="${editTop}">\n` +
      slot +
      `        </dev>`
    )
  })
  return `    <devices>\n${rows.join('\n')}\n    </devices>`
}

/**
 * Serialise a topology back to `.topo` XML.
 *
 * Cable anchors must sit on the device icon's bounding box, which eNSP computes as
 * a fixed offset from the device's canvas position. Putting them anywhere else
 * makes eNSP draw the link from the wrong point (or drop it).
 *
 * @param {{devices: Array<object>, links: Array<object>}} topo
 * @returns {string}
 */
export function serialiseTopology(topo) {
  const byId = new Map(topo.devices.map((d) => [d.id, d]))

  const lines = topo.links.map((l) => {
    const src = byId.get(l.srcId)
    const dst = byId.get(l.dstId)
    if (!src || !dst) throw new Error(`link references unknown device: ${l.srcId} -> ${l.dstId}`)

    // Anchor on the facing sides: right edge of the source, left edge of the target,
    // both at the icon's true vertical centre.
    const sx = src.x + ICON.right
    const sy = src.y + ICON.centerY
    const tx = dst.x + ICON.left
    const ty = dst.y + ICON.centerY

    return (
      `        <line srcDeviceID="${src.id}" destDeviceID="${dst.id}">\n` +
      `            <interfacePair lineName="${l.media ?? 'Copper'}" ` +
      `srcIndex="${l.srcIndex}" srcBoundRectIsMoved="0" ` +
      `srcBoundRect_X="${sx.toFixed(6)}" srcBoundRect_Y="${sy.toFixed(6)}" ` +
      `srcOffset_X="0.000000" srcOffset_Y="0.000000" ` +
      `tarIndex="${l.dstIndex}" tarBoundRectIsMoved="0" ` +
      `tarBoundRect_X="${tx.toFixed(6)}" tarBoundRect_Y="${ty.toFixed(6)}" ` +
      `tarOffset_X="0.000000" tarOffset_Y="0.000000" />\n` +
      `        </line>`
    )
  })

  return (
    `<?xml version="1.0" encoding="UNICODE" ?>\n` +
    `<topo version="1.2.00.390">\n` +
    `${renderDevices(topo.devices)}\n` +
    `    <lines>\n${lines.join('\n')}\n    </lines>\n` +
    `    <shapes />\n` +
    `    <txttips />\n` +
    `</topo>\n`
  )
}

/**
 * Write a topology to disk.
 * @param {string} file
 * @param {object} topo
 */
export async function writeTopology(file, topo) {
  await writeFile(file, serialiseTopology(topo), 'utf8')
  return file
}

/**
 * Summarise a topology for display: device count, link count, console map.
 *
 * @param {{devices: Array<object>, links: Array<object>}} topo
 */
export function summarise(topo) {
  return {
    devices: topo.devices.length,
    links: topo.links.length,
    consoles: Object.fromEntries(
      topo.devices.filter((d) => d.comPort).map((d) => [d.name, d.comPort]),
    ),
    byModel: topo.devices.reduce((acc, d) => {
      acc[d.model] = (acc[d.model] ?? 0) + 1
      return acc
    }, {}),
  }
}
