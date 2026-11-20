import { createHash } from 'node:crypto'

// Track the exact source span of each editable value. All opaque XML, including
// comments, CDATA, unknown attributes and extension nodes, stays byte-for-text intact.
function readGeometry(text) {
  if (text.length > 8 * 1024 * 1024) throw Error('layout input exceeds 8 MiB')
  const nodes = [], stack = [], geometry = []
  const token = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[\w:.-]+(?:[^<>"']|"[^"]*"|'[^']*')*>/guy
  const attr = /\s+([\w:.-]+)\s*=\s*(["'])(.*?)\2/gsuy
  let end = 0, roots = 0
  for (;;) {
    const start = text.indexOf('<', end)
    if (start < 0) break
    token.lastIndex = start
    const raw = token.exec(text)?.[0]
    if (!raw) throw Error('unsupported or malformed layout XML')
    end = token.lastIndex
    if (/^<[!?]/u.test(raw)) continue
    const closing = raw.startsWith('</')
    const name = /^<\/?([\w:.-]+)/u.exec(raw)[1]
    if (closing) {
      if (stack.pop()?.name !== name) throw Error('unbalanced layout XML')
      continue
    }
    if (!stack.length && (++roots !== 1 || name !== 'topo')) throw Error('expected one native topo root')
    const parent = stack.at(-1)
    const path = (parent?.path ?? '') + '/' + name
    const node = { name, path, parent, a: Object.create(null), spans: Object.create(null) }
    let cursor = name.length + 1
    const editable = {
      '/topo/devices/dev': ['edit_left','edit_top'],
      '/topo/lines/line/interfacePair': ['srcOffset_X','srcOffset_Y','srcBoundRectIsMoved','tarOffset_X','tarOffset_Y','tarBoundRectIsMoved'],
      '/topo/txttips/txttip': ['left','top','right','bottom'], '/topo/txttip': ['left','top','right','bottom'],
      '/topo/shapes/shape': ['upleftcorner'],
    }[path]
    while (cursor < raw.length) {
      attr.lastIndex = cursor
      const m = attr.exec(raw)
      if (!m) break
      cursor = attr.lastIndex
      if (Object.hasOwn(node.a, m[1])) throw Error('duplicate layout XML attribute')
      node.a[m[1]] = m[3]
      if (editable?.includes(m[1])) {
        const span = [start + cursor - 1 - m[3].length, start + cursor - 1]
        node.spans[m[1]] = span
        geometry.push(span)
      }
    }
    if (!/^\s*\/?>$/u.test(raw.slice(cursor))) throw Error('unsupported layout XML attributes')
    if (editable || path === '/topo/lines/line') nodes.push(node)
    if (!raw.endsWith('/>')) stack.push(node)
    if (stack.length > 64 || nodes.length > 2000) throw Error('layout complexity limit exceeded')
  }
  if (stack.length || roots !== 1) throw Error('incomplete layout XML')
  const hash = createHash('sha256')
  let cursor = 0
  for (const [start, end] of geometry) {
    hash.update(text.slice(cursor, start)).update('\0')
    cursor = end
  }
  return { nodes, signature: hash.update(text.slice(cursor)).digest('hex') }
}

function number(value) {
  if (typeof value !== 'string' || !value.trim()) return NaN
  return Number(value)
}

function intersects(a, b) {
  return a.x < b.x + b.w + 2 && b.x < a.x + a.w + 2 && a.y < b.y + b.h + 2 && b.y < a.y + a.h + 2
}

function segmentHits(box, from, to) {
  let enter = 0, exit = 1
  for (const [axis, size] of [['x','w'], ['y','h']]) {
    const delta = to[axis] - from[axis], low = box[axis] - from[axis], high = low + box[size]
    if (!delta) { if (low > 0 || high < 0) return false; continue }
    enter = Math.max(enter, Math.min(low / delta, high / delta))
    exit = Math.min(exit, Math.max(low / delta, high / delta))
    if (enter > exit) return false
  }
  return true
}

function scene(nodes) {
  const boxes = [], segments = [], unsupported = [], devices = new Set(), frames = [], objects = Object.create(null)
  objects['canvas:origin'] = { boundary: 'left or top' }
  const missing = (id) => unsupported.push(id)
  function add(id, x, y, w, h, extra = {}) {
    if (![x,y,w,h].every(Number.isFinite) || w <= 0 || h <= 0) { missing(id); return }
    const box = { id, x, y, w, h, ...extra }
    boxes.push(box)
    return box
  }
  let tips = 0, pairs = 0, lines = 0
  for (const node of nodes) {
    const a = node.a
    if (node.name === 'dev') {
      if (!a.id || devices.has(a.id)) throw Error('layout needs a unique id for each device')
      devices.add(a.id)
      objects['icon:' + a.id] = objects['name:' + a.id] = { deviceId: a.id, name: a.name }
      add('icon:' + a.id, number(a.cx), number(a.cy), 54, 54, { owner: a.id })
      const width = Math.max(16, Array.from(a.name ?? '').reduce((n,c) => n + (c.codePointAt(0) > 255 ? 14 : 8), 0))
      // The native name is centred horizontally on edit_left.
      add('name:' + a.id, number(a.edit_left) - width/2, number(a.edit_top), width, 18,
        { owner: a.id, node, kind: 'name', radius: 80 })
    } else if (node.name === 'shape' && a.type === '1') {
      const [x,y] = (a.upleftcorner ?? '').split(',').map(number)
      const w = number(a.width), h = number(a.height)
      if ([x,y,w,h].every(Number.isFinite)) frames.push({ x,y,w,h,node })
    } else if (node.name === 'txttip') {
      const x = number(a.left), y = number(a.top)
      objects['tip:' + tips] = { annotation: a.content }
      add('tip:' + tips++, x,y,number(a.right)-x, number(a.bottom)-y, { node, kind: 'tip', radius: 64 })
    } else if (node.name === 'line') lines++
    else if (node.name === 'interfacePair') {
      const owners = [node.parent.a.srcDeviceID, node.parent.a.destDeviceID]
      const id = 'pair:' + pairs++, ends = []
      objects[id] = { source: owners[0], target: owners[1], srcIndex: a.srcIndex, tarIndex: a.tarIndex ?? a.destIndex }
      for (const [i,p] of ['src','tar'].entries()) {
        objects[id + ':' + p] = { deviceId: owners[i], interfaceIndex: i ? (a.tarIndex ?? a.destIndex) : a.srcIndex }
        const x = number(a[p+'BoundRect_X']), y = number(a[p+'BoundRect_Y'])
        const dx = number(a[p+'Offset_X']), dy = number(a[p+'Offset_Y'])
        ends.push({ x,y })
        if (![dx,dy].every(Number.isFinite) || !['0','1'].includes(a[p+'BoundRectIsMoved'])) { missing(id + ':' + p); continue }
        const moved = a[p+'BoundRectIsMoved'] === '1'
        add(id + ':' + p, x + 2 + (moved ? dx : 0), y + 2 + (moved ? dy : 0), 76, 16,
          { node, kind: 'port', prefix: p, owner: owners[i], segment: id, radius: 128, anchor: { x: x+2, y: y+2 } })
      }
      if (ends.every(e => Number.isFinite(e.x) && Number.isFinite(e.y))) segments.push({ id, ends, owners })
    }
  }
  // Keep a compact native number badge and its text together. An ambiguous
  // match stays fixed. Large layer backgrounds intentionally contain labels.
  const used = new Set()
  for (const box of boxes.filter(b => b.kind === 'tip')) {
    box.band = frames.filter(f => f.w >= box.w + 80 && f.h >= box.h + 16 &&
      box.x >= f.x && box.y >= f.y && box.x + box.w <= f.x + f.w && box.y + box.h <= f.y + f.h)
      .sort((a,b) => a.w*a.h-b.w*b.h)[0]
    const matching = frames.filter(f => Math.abs(f.x-box.x)<=4 && Math.abs(f.y-box.y)<=4 &&
      Math.abs(f.w-box.w)<=8 && Math.abs(f.h-box.h)<=8)
    if (matching.length === 1 && !used.has(matching[0])) {
      box.frame = matching[0]; used.add(box.frame)
      // Keep the badge border inside the collision bounds as well as the text.
      const left = Math.min(box.x, box.frame.x), top = Math.min(box.y, box.frame.y)
      box.w = Math.max(box.x+box.w, box.frame.x+box.frame.w)-left
      box.h = Math.max(box.y+box.h, box.frame.y+box.frame.h)-top
      box.x = left; box.y = top
    } else if (matching.length) {
      box.radius = 0
      for (const other of boxes) if (matching.includes(other.frame)) other.radius = 0
      missing(box.id + ':ambiguous-frame')
    }
  }
  if (boxes.length + segments.length > 700) throw Error('layout exceeds 700 foreground objects and segments')
  return { boxes, segments, unsupported, objects, counts: { devices: devices.size, lines, interfacePairs: pairs, annotations: tips } }
}

function hits(box, all) {
  const ids = []
  if (box.x < 0 || box.y < 0) ids.push('canvas:origin')
  for (const other of all.boxes) {
    if (box.id !== other.id && intersects(box, other)) ids.push(other.id)
  }
  for (const s of all.segments) {
    if (!box.kind && s.owners.includes(box.owner)) continue
    if (segmentHits(box, ...s.ends)) ids.push(s.id)
  }
  return ids
}

function conflicts(all) {
  const found = new Map()
  for (const box of all.boxes) {
    for (const id of hits(box, all)) {
      const pair = [box.id, id].sort()
      found.set(JSON.stringify(pair), pair)
    }
  }
  return { count: found.size, examples: [...found.values()].slice(0,80) }
}

export function topologyLayout(text, { correct = false } = {}) {
  const original = readGeometry(text), all = scene(original.nodes)
  const before = conflicts(all)
  const edits = [], moves = []
  const labels = all.boxes.filter(box => box.radius).map(box => ({ box, originX: box.x, originY: box.y }))
  // Reserve space for names and annotations before moving the more flexible port labels.
  labels.sort((a,b) => Number(a.box.kind === 'port') - Number(b.box.kind === 'port'))
  let checks = 0
  const comparisons = all.boxes.length + all.segments.length
  let budgetReached = false
  // Search a bounded neighbourhood of the original label on each pass so
  // that another label moving away can unblock a previously crowded port.
  search: for (let pass = 0; correct && pass < 3; pass++) {
    let improved = false
    for (const { box, originX, originY } of labels) {
      const initial = hits(box, all).length
      if (!initial) continue
      let best = initial, bestX = box.x, bestY = box.y
      for (let r = 0; r <= box.radius && best; r += 8) {
        for (let u = -r; u <= r && best; u += 8) {
          const offsets = Math.abs(u) === r ? [[u, 0],[u,-r],[u,r]] : [[u,-r],[u,r],[-r,u],[r,u]]
          for (const [dx,dy] of offsets) {
            const x = originX + dx, y = originY + dy
            if (x < 0 || y < 0 || (box.anchor && Math.hypot(x-box.anchor.x,y-box.anchor.y) > 144)) continue
            if (box.band && (x < box.band.x || y < box.band.y || x+box.w > box.band.x+box.band.w || y+box.h > box.band.y+box.band.h)) continue
            checks += comparisons
            if (checks > 16000000) { budgetReached = true; break search }
            const n = hits({ ...box, x,y }, all).length
            if (n < best) { best = n; bestX = x; bestY = y }
            if (!best) break
          }
        }
      }
      if (best < initial) { box.x = bestX; box.y = bestY; improved = true }
    }
    if (!improved) break
  }
  for (const { box, originX, originY } of labels) {
    const dx = box.x-originX, dy = box.y-originY
    if (!dx && !dy) continue
    function change(node, key, value) {
      const [start,end] = node.spans[key]
      edits.push({ start,end,value: String(value) })
    }
    const node = box.node
    if (box.kind === 'name') {
      change(node,'edit_left',number(node.a.edit_left)+dx); change(node,'edit_top',number(node.a.edit_top)+dy)
    } else if (box.kind === 'port') {
      change(node,box.prefix+'Offset_X', (box.x-box.anchor.x).toFixed(6))
      change(node,box.prefix+'Offset_Y', (box.y-box.anchor.y).toFixed(6))
      change(node,box.prefix+'BoundRectIsMoved',1)
    } else {
      for (const [key,delta] of [['left',dx],['right',dx],['top',dy],['bottom',dy]]) change(node,key,number(node.a[key])+delta)
      if (box.frame) change(box.frame.node,'upleftcorner',[box.frame.x+dx,box.frame.y+dy].join(','))
    }
    moves.push({ id: box.id, dx,dy })
  }
  const parts = []
  let cursor = 0
  for (const edit of edits.sort((a,b) => a.start-b.start)) {
    if (edit.start < cursor) throw Error('overlapping native attribute edits')
    parts.push(text.slice(cursor,edit.start),edit.value); cursor = edit.end
  }
  const candidate = parts.join('') + text.slice(cursor)
  const verified = readGeometry(candidate)
  if (verified.signature !== original.signature) throw Error('non-layout topology data changed')
  const after = edits.length ? conflicts(scene(verified.nodes)) : before
  if (edits.length && after.count >= before.count) throw Error('candidate failed to reduce estimated conflicts')
  return { text: candidate, report: { counts: all.counts, before, after, moves, unsupported: all.unsupported,
    remainingObjects: Object.fromEntries([...new Set(after.examples.flat())].map(id => [id,all.objects[id]])),
    searchBudgetReached: budgetReached, semanticHash: verified.signature, nativeVisualVerified: false,
    limits: ['Estimated canvas units for icons, names and port labels; straight-line approximation.', 'Check native viewport, subnet ownership, clipping and font rendering on the candidate.'] } }
}

