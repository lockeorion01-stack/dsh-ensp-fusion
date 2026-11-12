import { createDeviceRunner, isReadOnlyCommand, matchExpect } from './lib/device-execution.js'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

import { Bridge, runProcess, sleep } from './lib/bridge-client.js'
import { VrpSession, probePort } from './lib/cli.js'
import { prepareCliEntries } from './lib/cli-plan.js'
import { readRecoveryPlan, listChangeJournals } from './lib/change-journal.js'
import { createRedactor, credentialValues, redactValue } from './lib/redaction.js'
import { waitDevicesReady } from './lib/device-ready.js'
import { validateLabPlan, runLabTest, renderLabReports } from './lib/lab-test.js'
import {
  describeDevices, parseTopo, readTopo, renameDevice, renumberComPorts,
  setComPort, setDeviceIpv4, suggestNames, writeTopo, validateTopoConsolePorts, validateNativeEndpointSettings,
} from './lib/topo.js'

export const name = 'ensp-automation'
export const inject = ['tools', 'skills', 'systemPrompt']

export const Config = Schema.object({
  pythonExecutable: Schema.string().default(''),
  pythonCandidates: Schema.array(Schema.string()).default([]),
  docsPythonExecutable: Schema.string().default(''),
  mode: Schema.string().default('job'),
  timeoutMs: Schema.number().default(180000),
  restrictToWorkspace: Schema.boolean().default(true),
  textTakeoverNotice: Schema.boolean().default(true),
  registerSkill: Schema.boolean().default(true),
  injectPrompt: Schema.boolean().default(true),
  enspExecutable: Schema.string().default('C:/Program Files/Huawei/eNSP/eNSP_Client.exe'),
  toolbarStart: Schema.array(Schema.number()).default([659, 56]),
  toolbarStop: Schema.array(Schema.number()).default([698, 56]),
  toolbarOneToOne: Schema.array(Schema.number()).default([624, 56]),
  iconHalfSize: Schema.array(Schema.number()).default([32, 28]),
})

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))
const LIB_ROOT = join(PACKAGE_ROOT, 'lib')
const BRIDGE_PATH = join(LIB_ROOT, 'bridge.py')
const LAUNCH_PATH = join(LIB_ROOT, 'launch.py')
const DOCS_SCRIPT = join(LIB_ROOT, 'make_docs.py')
const REF_SCRIPT = fileURLToPath(new URL('./lib/ref_dump.py', import.meta.url))
const SKILL_ROOT = join(PACKAGE_ROOT, 'skills', 'ensp-automation')
const SKILL_PATH = join(SKILL_ROOT, 'SKILL.md')

const PROMPT_SECTION = `## eNSP 实验自动化（dsh-ensp）

ENSPLB 增强：ensp_cli 批次整体预校验后顺序执行，失败默认跳过后续设备；continue_on_error:true 可继续其他设备。检查整体 ok、failure、skipped、saved.ok；失败不会回滚已生效的配置。重复验收用 ensp_labtest 的 JSON 计划和 report_prefix 生成 Markdown/CSV/JSON，状态区分 PASS/FAIL/ERROR/SKIPPED。echo_to_window 仅接受 display/ping/tracert，配置不重复执行。

操作华为 eNSP 网络实验时按下面的顺序执行，不要凭记忆猜坐标或命令。

通道优先级（从快到慢，能上位就不用下位）：
1. \`ensp_topo\` 直接读/改 .topo 文件——拓扑结构、设备名、com_port、PC 的 IP 都能离线改写，不需要点鼠标。
2. \`ensp_cli\` 走 telnet（127.0.0.1:<com_port>）下发命令——比点 GUI 快两个数量级，命令和回显都在返回值里。
3. \`ensp_gui\` 批量步骤——只用于必须点界面的动作（启动/停止设备、打开设备窗口、切换面板）。
4. 真实鼠标点击（\`click\` 带 \`restore:true\`）是最后手段，用完必须把鼠标还原。

**少回合**：工具本身只花几百毫秒，真正的成本是回合数（每步都要重新想一遍）。一步之内把互不依赖的调用并行发出去——多台设备用 \`ensp_cli {devices:[…]}\`，多张截图用 \`ensp_shot {shots:[…]}\`，或用 ensp_capture 一条调用完成「开窗→打字→截图→关窗」；验证用 ensp_cli 的 expect 断言拿 ok，不要把整段回显读回来自己看。步数减半，总时长就减半。

硬性工作规范：
- 截图前先问用户：是否关闭显示调试信息（\`undo debugging all\`、\`undo terminal monitor\`），避免回显里出现调试日志。
- 用户提供实训文档时，交付两份文档：一份截图下配一句话说明；一份只在对应题目下贴截图、不写任何说明文字（纯截图版用 \`ensp_doc\` 的 \`template_path\` 以原题目文档为底，**第一个 section 必须是实际拓扑图，插在题目参考拓扑图正下方**，同样不加文字）。
- 设备需要改名时先问用户；要改名则按重要程度编号（SW1/SW2、AR1/AR2、FW1）；用户给了命名规则就以用户为准。
- 优先接管已经打开的 eNSP；没有已打开的实例再找本机可用的 eNSP（任意版本）；发现多个版本时问用户用哪一个——不要自己挑。
- 命令不确定就上网搜或先用 \`ensp_cli\` 试一条，再进配置；不要编造命令。
- **参考文档（题目 docx / 课件 pptx）只当线索**：小错（命令语法、视图、显示命令名）用设备接受的写法继续做，并在交付里注明；大错（拓扑或地址规划矛盾、关键步骤缺失、策略方向相反）停下来告诉用户，不要臆造方案。
- 防火墙（USG6000V）可能起不来或控制台无回显；遇到就告知用户并继续其余部分，不要卡住。
- 将要接管鼠标（真实点击/拖拽）前必须提醒用户，并说明会还原鼠标位置。
- 交付时列出本次实验改动过的所有密码，以及当前生效的账号/密码对照表（明文写在文档末尾和回复里）。
- **配置要落盘**：实验结束时每台被配置过的设备都必须 \`save\`（\`ensp_cli\` 在改配置时会自动保存，返回值里的 \`saved\` 字段会说明是否成功）。只有用户明确提出"不用保存/临时实验"时才传 \`save:false\`。收尾时逐台核对 \`saved.ok\`，别把"没存盘"的实验交给用户。
- **保存拓扑**：设备 \`save\` 只写进设备 flash，配置能不能跟着 \`.topo\` 走取决于 eNSP 有没有保存拓扑。实验结束时用 \`ensp_gui\` 给主窗口发一次 Ctrl+S，再用拓扑目录里 \`vrpcfg.cfg\`/\`flash.efz\` 的大小和时间戳确认回写；不按的话重开拓扑会回到初始配置（实测）。
- **少抢前台、少弹窗口**：telnet 和主窗口截图都不需要 eNSP 在前台，默认就别激活、别前置。只有两种情况需要把窗口拿到前台：截设备命令行窗口（必须先双击图标打开并抢到前台）和点非客户区（工具栏/菜单）。用完可以用 \`{op:"close_console",device:"SWX"}\` 收掉设备窗口，保持用户桌面干净。

行为要点（已实测，别再踩）：
- eNSP 每个拓扑一个进程，窗口句柄每次都会变：一律按标题/类名重新查找，不要复用旧 hwnd。
- eNSP 是提权进程：普通权限进程的 PostMessage/SetWindowPos 会返回"拒绝访问"。本项目自带的 shell 提权桥（bridge.py）负责点击，别用别的方式模拟输入。
- 提权桥靠 \`ShellExecuteW("runas")\` 启动。授权行为取决于系统策略；**换到 UAC 默认设置的机器，第一次（或每个 job，取决于 mode）会弹出一次 UAC 授权框**，需要用户点一次"是"。遇到桥不可用又看不出别的原因，先问用户是不是把授权框点了拒绝（返回码 1223 = 用户取消）。
- 永远不要给 eNSP 的自绘状态栏发 SB_GETPARTS 之类的 WM_USER 消息——会直接让客户端崩溃。要判断选中数量就看截图。
- 设备图标要先选中（点空白处 + Ctrl+A）再点工具栏"启动"；工具栏在非客户区，只能真实点击。
- 真实点击一定要带 \`expect\`（"ensp" / 窗口标题 / hwnd）：用户很可能开着别的全屏窗口盖住 eNSP，裸点击会打到人家窗口里。带 \`expect\` 时桥会先把 eNSP 抬到最上层再确认坐标归属，否则拒绝点击。
- 发按键（Ctrl+A、打字）前必须先 \`activate\`；\`safetype\` 在窗口没拿到前台时会直接拒绝，别绕过它。
- 设备窗口不能用 ShowWindow 显示（eNSP 会立刻再隐藏），只能双击画布图标打开；**隐藏窗口截图拿到的是旧画面**，所以 \`ensp_shot target=device\` 必须先确保窗口可见（需要 \`topology_path\`）。
- 事件与遮挡的关系：窗口被别的程序**盖住**时，窗口 DC 截图照样正确（不需要置顶）；但真实点击会被前台窗口吃掉（所以有 \`expect\` 守卫），真实键盘输入必须窗口在前台。窗口被**最小化/隐藏**时截图会拿到旧画面或黑图。\`postclick\`（消息投递）不受遮挡影响，但只对客户区控件有效，工具栏/非客户区仍然必须真实点击。
- 截图用 \`ensp_shot\`（窗口 DC 位图，主窗口被别的窗口遮住也能截，约 30–90 ms），不要全屏截图。
- 配置下发/验证用 \`ensp_cli\`；一次不要开太多设备窗口，用完即关。`

/**
 * Commands that only read state (or only move around the CLI). A batch built
 * from these never needs ``save``; anything else is treated as a configuration
 * change and saved automatically, because lab work must survive a restart.
 */


function readSkillDefinition(path) {
  const raw = readFileSync(path, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(raw)
  if (match === null) throw new Error(`dsh-ensp: invalid skill frontmatter at ${path}`)
  const nameMatch = /^name:\s*(.+)$/mu.exec(match[1])
  const descriptionMatch = /^description:\s*(.+)$/mu.exec(match[1])
  if (nameMatch === null || descriptionMatch === null) {
    throw new Error(`dsh-ensp: skill requires name and description at ${path}`)
  }
  return { name: nameMatch[1].trim(), description: descriptionMatch[1].trim(), content: match[2].trim() }
}

function sessionWorkspace(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return resolve(typeof cwd === 'string' && cwd.trim() !== '' ? cwd : process.cwd())
}

function isWithin(root, target) {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel))
}

async function resolveWorkspacePath(rawPath, exec, config, { mustExist = false, kind = 'path' } = {}) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') throw new Error(`${kind} must be a non-empty string`)
  const workspace = sessionWorkspace(exec)
  const target = resolve(isAbsolute(rawPath) ? rawPath : join(workspace, rawPath))
  if (!config.restrictToWorkspace) return target
  if (!isWithin(workspace, target)) {
    throw new Error(`${kind} must stay inside the dsh session workspace: ${workspace}`)
  }
  const workspaceReal = await realpath(workspace)
  if (mustExist) {
    const targetReal = await realpath(target).catch((error) => {
      if (error?.code === 'ENOENT') throw new Error(`${kind} does not exist: ${target}`)
      throw error
    })
    if (!isWithin(workspaceReal, targetReal)) throw new Error(`${kind} resolves outside the dsh session workspace`)
    return target
  }
  // Existing output files and parent junctions must obey the same boundary as
  // reads; a lexical path check alone allows writes through a workspace link.
  let ancestor = target
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  if (!isWithin(workspaceReal, await realpath(ancestor))) {
    throw new Error(`${kind} resolves outside the dsh session workspace`)
  }
  return target
}

async function assertRegularFile(path, label) {
  const info = await stat(path).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`${label} does not exist: ${path}`)
    throw error
  })
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${path}`)
  return info
}

async function prepareOutput(path, allowOverwrite, label) {
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`${label} exists and is not a regular file: ${path}`)
    if (!allowOverwrite) throw new Error(`${label} already exists; choose a versioned path or set allow_overwrite=true`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await mkdir(dirname(path), { recursive: true })
  return path
}

function renderJson(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * DSH rejects tool results that cannot round-trip through JSON, so `undefined`
 * fields must disappear (not become the string "undefined") and non-finite
 * numbers must become null. Every tool return value goes through this.
 */
function lossless(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((item) => lossless(item))
  if (typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) {
      const item = value[key]
      if (item === undefined) continue
      out[key] = lossless(item)
    }
    return out
  }
  return String(value)
}

// --------------------------------------------------------------- device mapping

/**
 * Match topology labels (canvas coordinates) to the live ``Edit`` controls that
 * eNSP places over every device name, yielding the canvas -> screen offset.
 */
function labelOffset(devices, rects, scale = 1) {
  if (rects.length === 0) return null
  let best = null
  for (const device of devices) {
    for (const rect of rects) {
      const dx = rect[0] - device.editLeft * scale
      const dy = rect[1] - device.editTop * scale
      let score = 0
      for (const other of devices) {
        const hit = rects.some((candidate) => Math.abs(candidate[0] - (other.editLeft * scale + dx)) <= 3 * scale
          && Math.abs(candidate[1] - (other.editTop * scale + dy)) <= 3 * scale)
        if (hit) score += 1
      }
      if (best === null || score > best.score) best = { dx, dy, score }
    }
  }
  return best
}

async function deviceScreenPoint(bridge, config, devices, deviceName) {
  const device = devices.find((item) => item.name.toLowerCase() === deviceName.toLowerCase())
  if (!device) throw new Error(`device "${deviceName}" is not in the topology (have: ${devices.map((d) => d.name).join(', ')})`)
  let result = await bridge.steps([{ op: 'ensp' }])
  let payload = result.steps[0] ?? {}
  if (payload.ok === false) throw new Error(payload.error ?? 'eNSP discovery failed')
  let windows = payload.windows ?? []
  if (windows.length === 0) throw new Error('no eNSP window is open')
  let main = windows.find((item) => !item.minimized) ?? windows[0]
  let restored = false
  if (main.minimized) {
    // A minimized window reports a 0×0 client at -32000, so every derived click
    // point would land off screen. Restore it first, then re-read the anchors.
    result = await bridge.steps([
      { op: 'activate', hwnd: main.hwnd },
      { op: 'sleep', t: 0.5 },
      { op: 'ensp' },
    ])
    payload = result.steps[2] ?? {}
    windows = payload.windows ?? []
    main = windows.find((item) => item.hwnd === main.hwnd) ?? windows[0]
    restored = true
    if (!main || main.minimized || (main.client_size?.[0] ?? 0) <= 0) {
      throw new Error('eNSP 主窗口处于最小化状态且自动还原失败，请先手动还原 eNSP 窗口')
    }
  }
  const group = (payload.anchors ?? []).find((entry) => entry.main === main.hwnd)
  const rects = (group?.items ?? []).map((item) => item.rect)
  const scale = main.dpi_scale ?? 1
  const view = (payload.canvases ?? []).find((entry) => entry.main === main.hwnd)?.view
  // Invisible edit controls can remain below the icon after a label is moved.
  // Use the actual canvas viewport, not a moved label's serialized position.
  const offset = view ? { dx: view.origin[0] - view.scroll[0] * scale,
    dy: view.origin[1] - view.scroll[1] * scale } : labelOffset(devices, rects, scale)
  if (!offset) {
    throw new Error('could not read the canvas label anchors; pass explicit x/y with {op:"click"} instead')
  }
  const [halfW, halfH] = config.iconHalfSize
  return {
    main,
    offset,
    restored,
    point: [Math.round((device.cx + halfW) * scale + offset.dx), Math.round((device.cy + halfH) * scale + offset.dy)],
    device,
  }
}

/** Visible, non-minimized top-level windows whose title is exactly ``title``. */
async function visibleWindows(bridge, title) {
  const windows = await consoleWindows(bridge, title)
  return windows.filter((item) => (item.title ?? '').toLowerCase() === title.toLowerCase()
    && !item.minimized
    && (item.client_size?.[0] ?? 0) > 0)
}

async function consoleWindows(bridge, title) {
  const result = await bridge.steps([{ op: 'ensp' }])
  const payload = result.steps[0] ?? {}
  if (payload.ok === false) throw new Error(payload.error ?? 'eNSP discovery failed')
  const mains = payload.windows ?? []
  if (mains.length > 1) throw new Error('multiple eNSP instances; close unrelated instances or use an explicit hwnd')
  return (payload.devices ?? []).filter(w => mains.some(main => main.pid === (w.ensp_pid ?? w.pid))
    && (w.title ?? '').toLowerCase() === title.toLowerCase())
}

/**
 * A user-minimized console is not the same trap as a hidden one: ``SW_RESTORE``
 * works on it, while a ShowWindow call on a hidden console is undone by eNSP.
 * Also, BitBlt of a minimized window yields a stale frame, so treat it as closed.
 */
async function restoreMinimizedWindow(bridge, title) {
  const windows = await consoleWindows(bridge, title)
  const minimized = windows.find((item) => item.minimized)
  if (!minimized) return { hwnd: 0 }
  await bridge.steps([{ op: 'activate', hwnd: minimized.hwnd }, { op: 'sleep', t: 0.45 }])
  const after = await visibleWindows(bridge, title)
  return { hwnd: after[0]?.hwnd ?? 0, restored: after.length > 0 }
}

/**
 * Make a device window visible.
 *
 * eNSP re-hides a device window that is shown with ShowWindow from outside, and
 * a hidden window only yields a stale BitBlt image, so the only reliable way to
 * reveal one is the same double-click a human uses on the device icon.
 */
async function ensureDeviceWindow(bridge, config, devices, title, { offset, settle = 1.1 } = {}) {
  const existing = await visibleWindows(bridge, title)
  if (existing.length > 0) return { open: true, method: 'already-visible', hwnd: existing[0].hwnd }
  const revived = await restoreMinimizedWindow(bridge, title)
  if (revived.hwnd) return { open: true, method: 'restored', hwnd: revived.hwnd }
  if (!devices || devices.length === 0) {
    return { open: false, method: 'none', needsTopology: true }
  }
  const normalized = await bridge.steps([{ op: 'normalize_canvas', ensp: true, toolbar: config.toolbarOneToOne }], { stopOnError: true })
  if (normalized.steps.some(s => s.ok === false)) throw new Error(normalized.steps.find(s => s.ok === false).error)
  const mapped = await deviceScreenPoint(bridge, config, devices, title)
  const [bx, by] = mapped.point
  const offsets = offset
    ? [offset]
    : [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8], [12, 12], [-12, -12]]
  for (const [ox, oy] of offsets) {
    await bridge.steps([
      { op: 'device_click', hwnd: mapped.main.hwnd, cx: mapped.device.cx + ox / (mapped.main.dpi_scale ?? 1),
        cy: mapped.device.cy + oy / (mapped.main.dpi_scale ?? 1), half_width: config.iconHalfSize[0], half_height: config.iconHalfSize[1] },
      { op: 'sleep', t: settle },
    ], { stopOnError: true })
    const now = await visibleWindows(bridge, title)
    if (now.length > 0) return { open: true, method: 'icon-click', hwnd: now[0].hwnd, point: [bx + ox, by + oy] }
  }
  return { open: false, method: 'icon-click', tried: offsets.length, point: [bx, by] }
}

// --------------------------------------------------------------- tool factory

/**
 * Capture one window into a PNG. Shared by the single-shot and batch forms of
 * ensp_shot so a whole set of screenshots costs one tool call.
 */
async function captureWindow(spec, { devices, bridge, config, exec }) {
  const out = await resolveWorkspacePath(spec.out, exec, config, { kind: 'out' })
  await prepareOutput(out, spec.allow_overwrite === true, 'out')
  const target = spec.target ?? 'main'
  const notes = []
  const steps = []
  if (target === 'screen') {
    steps.push({ op: 'screen', out, crop: spec.crop })
  } else if (target === 'device' && spec.hwnd) {
    const info = await bridge.steps([{ op: 'info', hwnd: spec.hwnd }])
    const window = info.steps.find(step => step.ok && step.window)?.window
    if (!window) throw new Error('device hwnd is invalid or unavailable')
    if (!window.visible || window.minimized) {
      throw new Error('device hwnd must identify a visible, non-minimized window; open the console first or use device with topology_path')
    }
    steps.push({ op: 'shot', hwnd: spec.hwnd, out, crop: spec.crop })
  } else if (target === 'device') {
    const title = spec.device ?? ''
    if (!title) throw new Error('target=device needs device (window title) or hwnd')
    // A hidden device window only yields a stale bitmap, so make it visible first.
    const outcome = await ensureDeviceWindow(bridge, config, devices, title, { settle: 1.1 })
    if (!outcome.open) {
      if (outcome.needsTopology) {
        throw new Error(`设备窗口「${title}」当前没有显示，用 ShowWindow 打开会被 eNSP 立刻隐藏。请传 topology_path 让工具走双击图标的路径，或先用 ensp_gui 的 open_console。`)
      }
      throw new Error(`设备窗口「${title}」打不开：面板可能不在可见画布内（试过 ${outcome.tried} 个图标位置）。`)
    }
    steps.push({ op: 'shot', title, out, crop: spec.crop })
    notes.push(`设备窗口来源：${outcome.method}。`)
  } else {
    steps.push(spec.hwnd
      ? { op: 'shot', hwnd: spec.hwnd, out, crop: spec.crop }
      : { op: 'shot', ensp: true, out, crop: spec.crop })
  }
  const result = await bridge.steps(steps)
  const shot = result.steps.filter((step) => step.ok && step.width).pop()
  if (!shot) {
    const failure = result.steps.find((step) => !step.ok)
    throw new Error(`screenshot failed: ${failure?.error ?? 'unknown error'}`)
  }
  return { path: out, width: shot.width, height: shot.height, window: shot.window, notes }
}

/**
 * Evaluate one `expect` pattern against a command's output. A pattern wrapped in
 * slashes is a regular expression; anything else is a case-insensitive substring,
 * which is what lab verification actually needs ("2.2.10.10/32", "destination-nat").
 */

/**
 * Resolve the teacher's .docx. Chinese file names drift by a space or a full-width
 * bracket all the time, and a hard "missing template" error costs a whole retry
 * round trip, so fall back to the closest name in the same folder.
 */
async function resolveTemplatePath(rawPath, exec, config, notes) {
  try {
    return await resolveWorkspacePath(rawPath, exec, config, { mustExist: true, kind: 'template_path' })
  } catch (error) {
    let full
    try {
      full = await resolveWorkspacePath(rawPath, exec, config, { kind: 'template_path' })
    } catch (inner) {
      throw error
    }
    const normalize = (value) => value.replace(/[\s\u3000_\-()（）·]/gu, '').toLowerCase()
    const folder = dirname(full)
    const target = normalize(basename(full).replace(/\.docx$/iu, ''))
    let entries = []
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch (inner) {
      throw error
    }
    const scored = []
    for (const entry of entries) {
      if (!entry.isFile() || !/\.docx$/iu.test(entry.name)) continue
      const name = normalize(entry.name.replace(/\.docx$/iu, ''))
      let score = 0
      const limit = Math.min(name.length, target.length)
      while (score < limit && name[score] === target[score]) score += 1
      scored.push({ path: join(folder, entry.name), score, length: name.length })
    }
    scored.sort((a, b) => (b.score - a.score)
      || (Math.abs(a.length - target.length) - Math.abs(b.length - target.length)))
    const best = scored[0]
    if (best && best.score >= Math.max(6, Math.floor(target.length * 0.8))) {
      notes.push(`template_path 没找到，按名字近似匹配到「${basename(best.path)}」。`)
      return best.path
    }
    throw error
  }
}

/** md5 of a produced PNG, used to spot "the window never repainted" duplicates. */
async function fileDigest(path) {
  try {
    const data = await readFile(path)
    return createHash('md5').update(data).digest('hex')
  } catch (error) {
    return null
  }
}

/**
 * Run one command batch against one device. Used by both the single-device and
 * the devices:[...] form of ensp_cli, so several devices cost one tool call.
 */
const runOnDevice = createDeviceRunner({ resolveWorkspacePath, prepareOutput, ensureDeviceWindow })

function statSyncSafe(path) {
  try {
    return statSync(path).mtimeMs
  } catch (error) {
    return 0
  }
}

function createTools(config, bridge) {
  const tools = []

  tools.push(defineTool({
    name: 'ensp_status',
    description: 'Report the eNSP situation before doing anything else: running client windows (pid/rect/topology path when detectable), installed eNSP versions, GUI-bridge health and privilege, and the device inventory of a topology file.',
    parameters: {
      topology_path: { type: 'string', description: 'Optional .topo path; when given its devices, models and telnet ports are returned.' },
      include_telnet: { type: 'boolean', description: 'Probe the telnet console ports of the topology; defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspaceRoot: { type: 'string', required: true },
          bridge: { type: 'object', additionalProperties: true, required: true },
          instances: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          installed: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          deviceWindows: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          topology: { type: 'object', additionalProperties: true },
          telnet: { type: 'array', items: { type: 'object', additionalProperties: true } },
          notes: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const notes = []
      const installed = await listInstalledEnsp(config)
      const steps = [{ op: 'ping' }, { op: 'ensp' }, ...installed.map((entry) => ({ op: 'exeinfo', path: entry.path }))]
      let bridgeInfo = { available: false, error: 'bridge not started' }
      let instances = []
      let deviceWindows = []
      try {
        const probeStarted = Date.now()
        const batch = await bridge.steps(steps)
        const ping = batch.steps[0] ?? {}
        bridgeInfo = {
          available: ping.pong === true,
          elevated: ping.elevated,
          dpiAware: ping.dpi_aware,
          screen: ping.screen,
          transport: batch.transport ?? 'job',
          elapsedMs: Date.now() - probeStarted,
        }
        const payload = batch.steps[1] ?? {}
        instances = (payload.windows ?? []).map((w) => ({
          hwnd: w.hwnd, pid: w.pid, rect: w.rect, minimized: w.minimized,
          title: w.title, cls: w.cls,
        }))
        deviceWindows = (payload.devices ?? []).map((w) => ({ hwnd: w.hwnd, title: w.title, rect: w.rect }))
        for (const [index, entry] of installed.entries()) {
          const info = batch.steps[2 + index]
          if (info?.exe?.version) entry.version = info.exe.version
          if (info?.exe?.modified) entry.modified = info.exe.modified
        }
        if (instances.length === 0) {
          notes.push('没有发现已打开的 eNSP 窗口：可以用 ensp_gui 的 {op:"explore",path:"…eNSP_Client.exe"} 拉起，或先问用户想用哪个版本。')
        }
        if (instances.some((item) => item.minimized)) {
          notes.push('eNSP 主窗口当前是最小化的：截图（窗口 DC）不受影响，但真实点击/双击图标前工具会自动把它还原到前台（最小化窗口的坐标是 -32000，全是废值）。')
        }
        if (bridgeInfo.available && bridgeInfo.elevated === false) {
          notes.push('提权桥当前没有管理员权限：对提权运行的 eNSP 发窗口消息会被拒绝（UIPI）。请以管理员身份运行 DSH；或在 UAC 未放行的机器上用 mode "serve"，让提权进程只启动一次（每次启动都可能弹一次 UAC 授权框）。')
        }
      } catch (error) {
        bridgeInfo = { available: false, error: error instanceof Error ? error.message : String(error) }
        notes.push(`GUI 桥不可用：${bridgeInfo.error}。telnet 通道和 .topo 文件通道不受影响。`)
        notes.push('常见原因：没装 pywin32/Pillow、pythonExecutable 指错、或 UAC 授权框被拒绝（返回码 1223 = 用户取消）。')
      }
      if (installed.length > 1) notes.push('本机存在多个 eNSP 版本，请先问用户使用哪一个。')

      let topology
      let telnet = []
      if (args.topology_path) {
        const path = await resolveWorkspacePath(args.topology_path, exec, config, { mustExist: true, kind: 'topology_path' })
        const parsed = await readTopo(path)
        topology = {
          path,
          version: parsed.version,
          devices: describeDevices(parsed),
          annotations: parsed.annotations,
        }
        if (args.include_telnet) {
          telnet = await Promise.all(parsed.devices
            .filter((device) => device.comPort > 0)
            .map((device) => probePort(device.comPort)))
          const down = telnet.filter((entry) => !entry.open)
          if (down.length > 0) notes.push(`以下控制台端口未开放（设备未启动或起不来）：${down.map((entry) => entry.port).join(', ')}`)
        }
      }

      return lossless({
        workspaceRoot: sessionWorkspace(exec),
        bridge: bridgeInfo,
        instances,
        installed,
        deviceWindows,
        topology,
        telnet: args.include_telnet ? telnet : undefined,
        notes,
      })
    },
  }))

  tools.push(defineTool({
    name: 'ensp_gui',
    description: 'Drive the eNSP window in one batched call. Steps share one elevated process. Convenience ops: start_all, stop_all, open_console, device_window, close_console. Raw ops: click, postclick, select_tab (standard SysTabControl32 hwnd, zero-based index; queries geometry and confirms selection), drag, wheel, type, posttext, key, paste, settext, bmclick, show, focus, close, resize, wait, texts, children, wndat, info, shot, screen, open, explore, kill, sleep, ensp.',
    parameters: {
      steps: {
        type: 'array',
        required: true,
        description: 'Ordered steps. Raw steps use bridge op names and arguments (e.g. {"op":"postclick","hwnd":123,"x":10,"y":20}). Convenience steps take {op:"open_console", device:"SW1"} (needs topology_path), {op:"close_console", device:"SW1"}, {op:"start_all"}, {op:"stop_all"}.',
        items: { type: 'object', additionalProperties: true },
      },
      topology_path: { type: 'string', description: 'Needed by open_console / device_window / start_all to map device names to canvas coordinates.' },
      icon_offset: { type: 'array', items: { type: 'integer' }, description: 'Force one icon hit offset [dx, dy] for open_console instead of the built-in retry spiral.' },
      timeout_ms: { type: 'integer', description: 'Batch timeout; defaults to the configured value.' },
      allow_cursor_takeover: { type: 'boolean', description: 'Acknowledge that a real click will move the user pointer (it is restored afterwards). Defaults to false.' },
      start_wait_ms: { type: 'integer', description: 'How long start_all waits for console ports to come up; defaults to 25000.' },
      stop_wait_ms: { type: 'integer', description: 'How long stop_all waits for console ports to close; defaults to 12000.' },
      ready_wait_ms: { type: 'integer', description: 'Budget for prompt plus display version readiness after start_all; defaults to 240000 for USG topologies, otherwise 120000. A timeout is not device readiness.' },
      ready_devices: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Optional [{device,username?,password?}] for readiness probes. No password changes are performed.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          transport: { type: 'string' },
          ok: { type: 'boolean', required: true },
          steps: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          elapsedMs: { type: 'integer', required: true },
          requiresCursorTakeover: { type: 'boolean', required: true },
          notes: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      if (!Array.isArray(args.steps) || args.steps.length === 0) throw new Error('steps must be a non-empty array')
      for (const step of args.steps) {
        if (!step || typeof step !== 'object' || typeof step.op !== 'string') throw new Error('each GUI step requires op')
        if (step.op === 'select_tab' && (!Number.isInteger(step.index) || step.index < 0)) throw new Error('select_tab index must be a nonnegative integer')
        if (step.op === 'select_list') {
          if ((step.index !== undefined) === (step.text !== undefined)) throw new Error('select_list requires exactly one index or text')
          if (step.index !== undefined && (!Number.isInteger(step.index) || step.index < 0)) throw new Error('select_list index must be a nonnegative integer')
          if (step.text !== undefined && (typeof step.text !== 'string' || !step.text.trim() || /[\p{Cc}]/u.test(step.text))) throw new Error('select_list text must be a nonempty label')
          if (step.expected_count !== undefined && (!Number.isSafeInteger(step.expected_count) || step.expected_count < 1)) throw new Error('select_list expected_count must be a positive integer')
        }
        if (step.op === 'start_all' && step.method !== undefined && !['keyboard','toolbar'].includes(step.method)) throw new Error('start_all method must be keyboard or toolbar')
        if (['start_all','stop_all'].includes(step.op) && step.hwnd !== undefined && (!Number.isSafeInteger(step.hwnd)||step.hwnd<1)) throw new Error('start_all/stop_all hwnd must be a positive integer')
        if (step.op === 'close_project' && step.save !== undefined && !['ask', 'save', 'discard', 'cancel'].includes(step.save)) {
          throw new Error('invalid close_project save policy')
        }
        if (step.op === 'wait_ports') {
          if ((!Array.isArray(step.ports) || step.ports.length === 0) && !args.topology_path) throw new Error('wait_ports requires ports or topology_path')
          if (step.ports !== undefined && (!Array.isArray(step.ports) || step.ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535))) throw new Error('invalid wait_ports ports')
          if (step.timeout_ms !== undefined && (!Number.isSafeInteger(step.timeout_ms) || step.timeout_ms < 0)) throw new Error('invalid wait_ports timeout')
          if (step.want !== undefined && !['open', 'closed'].includes(step.want)) throw new Error('invalid wait_ports state')
        }
      }
      for (const key of ['start_wait_ms', 'stop_wait_ms', 'ready_wait_ms']) {
        if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || args[key] <= 0)) throw new Error(`${key} must be a positive integer`)
      }
      const readyCredentials = new Map()
      if (args.ready_devices !== undefined && !Array.isArray(args.ready_devices)) throw new Error('ready_devices must be an array')
      for (const entry of args.ready_devices ?? []) {
        if (!entry || typeof entry.device !== 'string' || !entry.device.trim()
          || Object.keys(entry).some(key => !['device', 'username', 'password'].includes(key))
          || ['username', 'password'].some(key => entry[key] !== undefined && typeof entry[key] !== 'string')) throw new Error('invalid readiness credentials')
        const key = entry.device.toLowerCase()
        if (readyCredentials.has(key)) throw new Error('duplicate readiness device')
        readyCredentials.set(key, { username: entry.username, password: entry.password })
      }
      // Validate the whole batch before any GUI action, including raw open.
      for (const step of args.steps) {
        if (step.op === 'open' && typeof step.path === 'string' && extname(step.path).toLowerCase() === '.topo') {
          const path = await resolveWorkspacePath(step.path, exec, config, { mustExist: true, kind: 'topology_path' })
          const topology = await readTopo(path)
          validateTopoConsolePorts(topology.text)
          validateNativeEndpointSettings(topology.text)
          step.path = path
        }
      }
      const started = Date.now()
      const notes = []
      let devices = null
      if (args.topology_path) {
        const path = await resolveWorkspacePath(args.topology_path, exec, config, { mustExist: true, kind: 'topology_path' })
        const topology = await readTopo(path)
        validateTopoConsolePorts(topology.text)
        // A damaged endpoint must not prevent stopping an existing session or
        // collecting evidence. Guard only operations that may launch it.
        if(args.steps.some(s=>['start_all','open_console','device_window','device_click'].includes(s.op)))validateNativeEndpointSettings(topology.text)
        devices = topology.devices
      }
      if (args.steps.some(step => ['start_all', 'stop_all'].includes(step.op)) && !devices?.some(device => device.comPort > 0)) {
        throw new Error('start_all/stop_all require topology_path with assigned console ports for verified operation')
      }
      for (const key of readyCredentials.keys()) {
        if (!devices?.some(device => device.name.toLowerCase() === key && device.comPort > 0)) throw new Error('readiness device not found in topology')
      }

      const results = []
      let pending = []
      let needsCursor = false
      let halted = false
      const run = async (steps) => {
        let batchResult
        try {
          batchResult = await bridge.steps(steps, { timeoutMs: args.timeout_ms, stopOnError: true })
        } catch (error) {
          batchResult = { steps: [{ op: 'bridge_transport', ok: false, error: error.message,
            uncertain: true, message: 'Do not replay; inspect actual device and window state.' }] }
        }
        for (const step of batchResult.steps) results.push({ ...step, index: results.length })
        if (batchResult.steps.some(step => step.ok === false)) halted = true
        if (batchResult.steps.length < steps.length) results.push({ index: results.length, op: 'skipped',
          ok: false, skipped: steps.slice(batchResult.steps.length).map(s => s.op), error: 'preceding GUI step failed' })
        return batchResult
      }
      const flush = async () => {
        if (pending.length === 0) return
        const batch = pending
        pending = []
        if (!halted) await run(batch)
      }

      for (const step of args.steps) {
        const op = String(step.op ?? '')
        if (halted) {
          results.push({ index: results.length, op, ok: false, skipped: true, error: 'preceding GUI step failed' })
          continue
        }
        if (op === 'start_all' || op === 'stop_all') {
          await flush()
          if (halted) continue
          const keyboard = op === 'start_all' && step.method !== 'toolbar'
          needsCursor ||= !keyboard
          const ports = devices.filter(device => device.comPort > 0).map(device => device.comPort)
          let open = []
          let attempts = 0
          let portStateVerified = false
          for (; attempts < 2; attempts++) {
            const selector=step.hwnd===undefined?{ensp:true}:{hwnd:step.hwnd}
            await run(keyboard ? [{ op: 'start_devices', ...selector }] : [{ op: 'device_control', ...selector,
              toolbar: op === 'start_all' ? config.toolbarStart : config.toolbarStop }])
            if (halted) break
            open = await watchPorts(ports, op === 'start_all' ? 'open' : 'closed',
              op === 'start_all' ? args.start_wait_ms ?? 25000 : args.stop_wait_ms ?? 12000)
            portStateVerified = true
            if (op === 'start_all' ? open.length === ports.length : open.length === 0) break
          }
          const transportReady = !halted && (op === 'start_all' ? open.length === ports.length : open.length === 0)
          let readiness
          if (!halted && transportReady && op === 'start_all') {
            readiness = await waitDevicesReady(devices.filter(device => device.comPort > 0).map(device => ({ ...device,
              ...readyCredentials.get(device.name.toLowerCase()) })), { timeoutMs: args.ready_wait_ms ?? (devices.some(d => /^USG/iu.test(d.model ?? '')) ? 240000 : 120000) })
          }
          const ok = !halted && transportReady && (!readiness || readiness.ok)
          results.push({ index: results.length, op, ok, attempts: Math.min(attempts + 1, 2),
            portStateVerified, open: portStateVerified ? open : null,
            missing: portStateVerified ? (op === 'start_all' ? ports.filter(port => !open.includes(port)) : open) : null,
            transportReady, ...(readiness ? { readiness } : {}),
            ...(ok ? {} : { error: halted ? 'GUI control failed; device state is unconfirmed; inspect preceding steps' : transportReady ? 'device prompt and VRP readiness not confirmed' : 'console ports did not reach requested state' }) })
          halted ||= !ok
          continue
        }
        if (op === 'wait_ports') {
          // Poll console ports instead of making the caller sleep blindly. The USG
          // boots a full VM and can take minutes, so waiting happens here, once.
          await flush()
          if (halted) continue
          const wanted = Array.isArray(step.ports) && step.ports.length > 0
            ? [...new Set(step.ports)]
            : (devices ?? []).filter((device) => device.comPort > 0).map((device) => device.comPort)
          if (wanted.length === 0) throw new Error('wait_ports needs ports[] or a topology_path with console ports')
          if (wanted.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('wait_ports ports must be integers in 1..65535')
          if (step.timeout_ms !== undefined && (!Number.isSafeInteger(step.timeout_ms) || step.timeout_ms < 0)) throw new Error('wait_ports timeout_ms must be nonnegative')
          const want = step.want === 'closed' ? 'closed' : 'open'
          const started = Date.now()
          const open = await watchPorts(wanted, want, Number(step.timeout_ms ?? 180000))
          const elapsed = ((Date.now() - started) / 1000).toFixed(1)
          const missing = wanted.filter((port) => !open.includes(port))
          const settled = want === 'open' ? missing.length === 0 : open.length === 0
          results.push({ index: results.length, op: 'wait_ports', ok: settled, want, ports: wanted, open, missing: want === 'open' ? missing : open,
            elapsedMs: Date.now() - started, ...(settled ? {} : { error: 'console ports did not reach the requested state before timeout' }) })
          halted ||= !settled
          if (want === 'open') {
            notes.push(missing.length === 0
              ? `等待 ${elapsed} s 后端口全部开放（${open.join(', ')}）。`
              : `等待 ${elapsed} s，仍未开放的端口：${missing.join(', ')}（已开放 ${open.join(', ') || '无'}）。防火墙/虚拟机启动慢是常态，可加大 timeout_ms 或先做别的。`)
          } else {
            notes.push(settled ? `等待 ${elapsed} s 后端口全部关闭。` : `等待 ${elapsed} s 后仍有端口开放：${open.join(', ')}。`)
          }
          continue
        }
        if (op === 'open_console' || op === 'device_window') {
          if (!devices) throw new Error(`${op} needs topology_path`)
          const target = String(step.device)
          await flush()
          if (halted) continue
          needsCursor = true
          let outcome
          try {
            outcome = await ensureDeviceWindow(bridge, config, devices, target, {
              offset: step.icon_offset ?? args.icon_offset, settle: step.settle ?? 1.1,
            })
          } catch (error) { outcome = { open: false, method: 'failed', error: error.message } }
          results.push({ index: results.length, op: 'open_console', device: target, ok: outcome.open, ...outcome,
            ...(outcome.open ? {} : { error: outcome.error ?? 'device console window did not open' }) })
          halted ||= !outcome.open
          if (outcome.open && outcome.method === 'already-visible') {
            notes.push(`${target} 窗口本来就开着，直接用就行。`)
          } else if (outcome.open) {
            notes.push(`${target} 窗口已打开（图标点击 ${outcome.point?.join(',')}）。`)
          } else {
            notes.push(outcome.error ? `没打开 ${target} 的窗口：${outcome.error}` : `没打开 ${target} 的窗口：试过 ${outcome.tried ?? 0} 个图标位置。请先保存当前画布位置并传入对应 topology_path，确认设备在可见画布内。`)
          }
          continue
        }
        if (op === 'close_console') {
          await flush()
          if (halted) continue
          const windows = await visibleWindows(bridge, String(step.device))
          if (windows.length) await run(windows.map((w) => ({ op: 'close', hwnd: w.hwnd })))
          else results.push({ index: results.length, op: 'close_console', ok: true, alreadyClosed: true })
          continue
        }
        if (['click', 'ncclick', 'drag', 'device_control', 'device_click', 'normalize_canvas', 'close_project'].includes(op)) needsCursor = true
        // Raw file-writing ops must land in the session workspace, not in the
        // bridge's own working directory (which is the plugin's lib folder).
        if (typeof step.out === 'string' && step.out !== '') {
          const out = await resolveWorkspacePath(step.out, exec, config, { kind: 'out' })
          await prepareOutput(out, true, 'out')
          pending.push({ ...step, out })
          continue
        }
        pending.push(step)
      }
      await flush()

      // Device consoles need several seconds to come up (or go down); poll the
      // console ports so the caller does not have to guess or sleep blindly.
      // Function declaration (not a const arrow) so wait_ports can call it from
      // inside the step loop, which runs before this point in the source.
      async function watchPorts(ports, want, timeoutMs) {
        const deadline = Date.now() + timeoutMs
        let open = []
        for (;;) {
          const probes = await Promise.all(ports.map((port) => probePort(port, { timeoutMs: 700 })))
          open = probes.filter((probe) => probe.open).map((probe) => probe.port)
          const settled = want === 'open' ? open.length === ports.length : open.length === 0
          if (settled || Date.now() > deadline) return open
          await new Promise((resolve) => { setTimeout(resolve, 800) })
        }
      }
      if (needsCursor && !args.allow_cursor_takeover) {
        notes.push('本批包含真实鼠标点击（会短暂接管指针，结束后还原）。如用户尚未知晓，请在回复里说明。')
      }
      const failures = results.filter((step) => step.ok === false)
      if (failures.length > 0) {
        notes.push(`${failures.length} 个步骤失败：${failures.map((step) => `#${step.index} ${step.op} ${step.error}`).join(' | ')}`)
      }
      return lossless({
        transport: bridge.serving?.healthy ? 'serve' : 'job',
        ok: failures.length === 0,
        steps: results,
        elapsedMs: Date.now() - started,
        requiresCursorTakeover: needsCursor,
        notes,
      })
    },
  }))

  tools.push(defineTool({
    name: 'ensp_shot',
    description: 'Screenshot the eNSP main window, a device window, or the whole screen into PNG. Captures through the window DC, so the window may stay behind other windows and unfocused (~15 ms).',
    parameters: {
      out: { type: 'string', description: 'Output .png path inside the workspace. May be omitted when shots[] is used.' },
      target: { type: 'string', description: 'main | device | screen; defaults to main.' },
      device: { type: 'string', description: 'Device window title when target=device (e.g. SW1).' },
      hwnd: { type: 'integer', description: 'Explicit window handle instead of a name.' },
      crop: { type: 'array', items: { type: 'integer' }, description: 'Optional [x, y, width, height] crop in image pixels.' },
      topology_path: { type: 'string', description: 'Needed when target=device and that window is not visible yet (it is then opened by double-clicking the device icon).' },
      allow_overwrite: { type: 'boolean', description: 'Replace an existing file; defaults to false.' },
      shots: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'Capture several windows in ONE call: [{out, target?, device?, hwnd?, crop?}]. Each entry behaves like a single-shot call; the reply lists every file. Use this instead of calling ensp_shot once per screenshot.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          window: { type: 'object', additionalProperties: true },
          shots: { type: 'array', items: { type: 'object', additionalProperties: true } },
          notes: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const specs = Array.isArray(args.shots) && args.shots.length > 0
        ? args.shots
        : [{
            out: args.out,
            // A bare device name means "shoot that window"; agents write it that way
            // instead of target:"device" all the time.
            target: args.target ?? (args.device ? 'device' : undefined),
            device: args.device,
            hwnd: args.hwnd,
            crop: args.crop,
          }]
      let devices = null
      if (args.topology_path || specs.some((spec) => spec?.topology_path)) {
        const raw = args.topology_path ?? specs.find((spec) => spec?.topology_path)?.topology_path
        const path = await resolveWorkspacePath(raw, exec, config, { mustExist: true, kind: 'topology_path' })
        devices = (await readTopo(path)).devices
      }
      const captured = []
      const seen = new Map()
      for (const spec of specs) {
        const item = await captureWindow(spec, { devices, bridge, config, exec })
        const key = spec.device ?? spec.hwnd ?? spec.target ?? 'main'
        const digest = await fileDigest(item.path)
        const previous = seen.get(key)
        if (digest && previous && previous.digest === digest) {
          item.notes.push(`${key}: 这张与前一张「${previous.path}」完全相同，窗口可能没刷新。`)
          item.duplicateOf = previous.path
        } else if (digest) {
          seen.set(key, { digest, path: item.path })
        }
        captured.push(item)
      }
      const notes = captured.flatMap((item) => item.notes)
      const first = captured[0]
      const payload = { path: first.path, width: first.width, height: first.height, window: first.window, notes }
      if (captured.length > 1) {
        payload.shots = captured.map((item) => ({ path: item.path, width: item.width, height: item.height }))
      }
      return lossless(payload)
    },
  }))

  tools.push(defineTool({
    name: 'ensp_capture',
    description: 'Capture report screenshots without driving the GUI yourself: for each entry open that device\'s console window, type the commands with real keystrokes (so the transcript is the student-visible one), wait for the output, screenshot the window, then close it. One call replaces the whole open/type/wait/shoot/close dance, which is where most lab time goes.',
    parameters: {
      topology_path: { type: 'string', required: true, description: '.topo path used to locate device icons and console ports.' },
      shots: {
        type: 'array',
        required: true,
        items: { type: 'object', additionalProperties: true },
        description: '[{device, commands:["display …"], out, expect?, settle_ms?, gap_ms?, keep_open?, force?}]. Commands are typed into the window so they run again; keep each entry to 1–4 short display commands so the screenshot fits. When expect is given (index-aligned with commands, same syntax as ensp_cli), the commands are first checked over telnet and the screenshot is skipped unless they pass — that is what keeps you from shooting a screen you would then have to read.',
      },
      allow_overwrite: { type: 'boolean', description: 'Replace existing PNGs; defaults to true here.' },
      allow_cursor_takeover: { type: 'boolean', description: 'Acknowledge that opening windows uses real clicks; the pointer is restored afterwards.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          shots: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          notes: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const notes = []
      const path = await resolveWorkspacePath(args.topology_path, exec, config, { mustExist: true, kind: 'topology_path' })
      const devices = (await readTopo(path)).devices
      const list = Array.isArray(args.shots) ? args.shots : []
      if (list.length === 0) throw new Error('shots must contain at least one entry')
      const done = []
      const seen = new Map()
      for (let index = 0; index < list.length; index += 1) {
        let duplicateOf = null
        const spec = list[index]
        const device = spec?.device
        if (!device) throw new Error('every shots[] entry needs device')
        const out = await resolveWorkspacePath(spec.out, exec, config, { kind: 'out' })
        await prepareOutput(out, args.allow_overwrite !== false, 'out')
        const opened = await ensureDeviceWindow(bridge, config, devices, device, { settle: 1.2 })
        if (!opened.open) {
          notes.push(`${device}: 窗口打不开（${opened.needsTopology ? '需要 topology_path' : '图标不在可见画布内'}）`)
          done.push({ device, out, ok: false })
          continue
        }
        const commands = (Array.isArray(spec.commands) ? spec.commands : []).map(String)
        const expectList = Array.isArray(spec.expect) ? spec.expect : []
        if (expectList.length > 0 && spec.force !== true) {
          const target = devices.find((item) => item.name.toLowerCase() === String(device).toLowerCase())
          if (!target?.comPort) {
            notes.push(`${device}: 没有控制台端口，无法完成 expect 断言，跳过截图。`)
            done.push({ device, out, ok: false, skipped: true, checks: [] })
            continue
          } else {
            const session = new VrpSession({
              port: target.comPort,
              username: spec.username,
              password: spec.password,
              passwords: spec.passwords,
              commandTimeoutMs: spec.command_timeout_ms ?? 30000,
            })
            let checks = []
            try {
              await session.open()
              const ran = await session.run(commands)
              checks = commands.map((command, i) => {
                const pattern = expectList[i]
                if (!pattern) return null
                const output = ran.results[i]?.output ?? ''
                const patterns = Array.isArray(pattern) ? pattern : [pattern]
                return { command, pass: ran.results[i]?.ok === true && patterns.every((p) => matchExpect(output, String(p))), pattern }
              }).filter(Boolean)
              if (!ran.ok) checks.push({ command: ran.failure?.command ?? '', pass: false, pattern: 'CLI execution must succeed' })
            } catch (error) {
              notes.push(`${device}: expect 断言阶段登录/下发失败（${error.message}）。`)
              checks.push({ command: '', pass: false, pattern: 'CLI connection must succeed' })
            } finally {
              session.close()
            }
            const failed = checks.filter((check) => !check.pass)
            if (failed.length > 0) {
              notes.push(`${device}: 断言未通过（缺 ${failed.map((item) => item.pattern).join(' / ')}），没有截图。`)
              done.push({ device, out, ok: false, skipped: true, checks })
              continue
            }
            if (checks.length > 0) notes.push(`${device}: ${checks.length} 条断言全部通过。`)
          }
        }
        const gap = Number(spec.gap_ms ?? 900) / 1000
        const settle = Number(spec.settle_ms ?? 1600) / 1000
        // Activate + a bare Enter first: an idle console has logged out and the
        // first keystroke only wakes it.
        const steps = [
          { op: 'activate', title: device },
          { op: 'safetype', title: device, text: '\n', per_char: 0.02 },
          { op: 'sleep', t: 0.5 },
        ]
        for (const command of commands) {
          steps.push({ op: 'safetype', title: device, text: `${command}\n`, per_char: 0.05 })
          steps.push({ op: 'sleep', t: gap })
        }
        steps.push({ op: 'sleep', t: settle })
        // Re-activate right before the shot: an occluded console keeps a stale DC.
        steps.push({ op: 'activate', title: device })
        steps.push({ op: 'sleep', t: 0.2 })
        steps.push({ op: 'shot', title: device, out })
        // Keep the window when the same device shows up again later in the list
        // (otherwise the user sees the same window pop open several times).
        const reused = list.slice(index + 1).some((rest) => rest?.device === device)
        if (spec.keep_open !== true && !reused) steps.push({ op: 'close', title: device })
        const result = await bridge.steps(steps)
        const failed = result.steps.filter((step) => !step.ok)
        const shot = result.steps.filter((step) => step.op === 'shot' && step.ok).pop()
        if (failed.length > 0) notes.push(`${device}: ${failed.length} 步失败（${failed[0].error}）`)
        // A window that did not repaint yields a byte-identical PNG. Say so
        // instead of letting the caller keep shooting the same frozen frame.
        const fingerprint = await fileDigest(out)
        const previous = seen.get(device)
        if (fingerprint && previous && previous.digest === fingerprint) {
          notes.push(`${device}: 这张截图与上一张「${previous.path}」完全相同——窗口可能没刷新（重开窗口或重新点击再截）。`)
          duplicateOf = previous.path
        } else if (fingerprint) {
          seen.set(device, { digest: fingerprint, path: out })
        }
        done.push({
          device,
          out,
          ok: Boolean(shot),
          width: shot?.width,
          height: shot?.height,
          commands: commands.length,
          typed: result.steps.filter((step) => step.op === 'safetype' && step.ok).length,
          duplicateOf: duplicateOf ?? undefined,
        })
      }
      return lossless({ shots: done, notes })
    },
  }))

  tools.push(defineTool({
    name: 'ensp_cli',
    description: 'Send commands to a started eNSP device over its console telnet port (com_port from the .topo) and return the cleaned transcript. Optionally echo the same commands into the device CLI window and screenshot it, which is what lab reports need.',
    parameters: {
      commands: { type: 'array', items: { type: 'string' }, description: 'VRP commands in order, without the trailing newline. Required unless devices[] is used.' },
      expect: {
        type: 'array',
        description: 'Optional assertions, index-aligned with commands: expect[i] must appear in commands[i]\'s output (a value may be one pattern or an array of patterns that must all match; case-insensitive substring, write /regex/ for a pattern). The reply carries checks[] per asserted command plus one ok flag, so you do not have to eyeball the transcript.',
      },
      devices: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'Configure several devices in ONE call: [{device, port?, commands, expect?, system_view?, username?, password?, save?, output_file?}]. Validate the whole batch first, then run in order and stop subsequent devices on failure.',
      },
      continue_on_error: { type: 'boolean', description: 'Continue with remaining devices after a failed device; defaults to false. Commands on a failed device always stop.' },
      device: { type: 'string', description: 'Device name from the topology (resolves the port).' },
      port: { type: 'integer', description: 'Explicit console port; overrides device lookup.' },
      topology_path: { type: 'string', description: '.topo path used to resolve device -> port.' },
      system_view: { type: 'boolean', description: 'Enter system-view first; defaults to false.' },
      confirm_lldp_disable: { type: 'boolean', description: 'Explicitly confirm only the known undo lldp enable warning deleting all interface LLDP settings. Defaults to false (declines). Also available per devices[] entry.' },
      change_dir: { type: 'string', description: 'Opt in to durable change records and redacted before/after snapshots under this workspace directory. Snapshot failure prevents planned commands. Applies to all devices.' },
      recovery_commands: { type: 'array', items: { type: 'string' }, description: 'Explicit reviewed recovery commands to store with change_dir; also accepted per device. Never executed automatically.' },
      recover_from: { type: 'string', description: 'Execute the explicit recovery plan from a change manifest.json on its recorded console port. Supply credentials again; save defaults to false. Cannot combine with commands/devices/port/device.' },
      dry_run: { type: 'boolean', description: 'Validate and preview the entire command/recovery plan without opening consoles or writing journals.' },
      list_changes: { type: 'string', description: 'Read-only listing of change_dir: completed, failed, interrupted or active-or-unfinished. Cannot combine with commands/devices/recover_from.' },
      username: { type: 'string', description: 'Username when the console asks for AAA login.' },
      password: { type: 'string', description: 'Password when the console asks for AAA login.' },
      passwords: {
        type: 'array',
        items: { type: 'string' },
        description: 'Candidates tried in order when password is unknown or was changed before (e.g. ["Admin@123","Huawei@123"]). Only use passwords the user or the task actually gave — never invent variants.',
      },
      new_password: { type: 'string', description: 'New password to set when the device forces a password change on first login (a USG that still has the factory password asks this). Omit to decline the change.' },
      command_timeout_ms: { type: 'integer', description: 'Per-command timeout; defaults to 20000.' },
      echo_to_window: { type: 'boolean', description: 'Open the device console window and type the same commands there with real keystrokes (they execute a second time) so the window can be screenshotted the way a student would see it.' },
      save: { type: 'boolean', description: 'Write the running configuration to flash after the commands. Leave empty to save automatically whenever this batch changes the configuration (lab work must survive a device restart); pass false only when the user explicitly wants a throw-away configuration.' },
      screenshot_out: { type: 'string', description: '.png path for the echoed window screenshot (requires echo_to_window).' },
      echo_settle_ms: { type: 'integer', description: 'Wait after typing before the screenshot; defaults to 1200.' },
      echo_gap_ms: { type: 'integer', description: 'Pause between echoed commands; defaults to 600.' },
      allow_cursor_takeover: { type: 'boolean', description: 'Acknowledge a real click may be used to open the device window.' },
      output_file: { type: 'string', description: 'Also write the full transcript to this .txt path. Long tool results may be compressed in transit (e.g. to a <<ccr:...>> marker); writing them to a file lets you grep or page them afterwards.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: { type: 'string' },
          port: { type: 'integer', required: true },
          prompt: { type: 'string', required: true },
          results: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          echo: { type: 'object', additionalProperties: true },
          screenshot: { type: 'string' },
          transcript: { type: 'string' },
          saved: { type: 'object', additionalProperties: true },
          checks: { type: 'array', items: { type: 'object', additionalProperties: true } },
          setupResults: { type: 'array', items: { type: 'object', additionalProperties: true } },
          failure: { type: 'object', additionalProperties: true },
          artifactError: { type: 'object', additionalProperties: true },
          change_journal: { type: 'string' },
          preview: { type: 'array', items: { type: 'object', additionalProperties: true } },
          changes: { type: 'array', items: { type: 'object', additionalProperties: true } },
          skipped: { type: 'array', items: { type: 'string' } },
          ok: { type: 'boolean' },
          devices: { type: 'array', items: { type: 'object', additionalProperties: true } },
          notes: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const notes = []
      if (args.dry_run !== undefined && typeof args.dry_run !== 'boolean') throw new Error('dry_run must be boolean')
      if (args.list_changes !== undefined) {
        if (['commands', 'devices', 'recover_from'].some(key => args[key] !== undefined)) throw new Error('list_changes cannot combine with execution arguments')
        const root = await resolveWorkspacePath(args.list_changes, exec, config, { mustExist: true, kind: 'list_changes' })
        return { port: 0, prompt: '', results: [], notes: ['Journal inventory only; no console connection.'], ok: true, changes: listChangeJournals(root) }
      }
      if (args.recover_from !== undefined) {
        if (['commands', 'devices', 'port', 'device', 'recovery_commands'].some(key => args[key] !== undefined)) throw new Error('recover_from cannot override the recorded target or commands')
        const source = await resolveWorkspacePath(args.recover_from, exec, config, { mustExist: true, kind: 'recover_from' })
        const plan = readRecoveryPlan(source)
        args = { ...args, ...plan, save: args.save ?? false, change_dir: args.change_dir ?? dirname(dirname(source)) }
      }
      const topologyDevices = args.topology_path
        ? (await readTopo(await resolveWorkspacePath(args.topology_path, exec, config, { mustExist: true, kind: 'topology_path' }))).devices
        : null
      const entries = prepareCliEntries(args, topologyDevices)
      if (entries.some(entry => entry.recovery_commands) && !args.change_dir) throw new Error('recovery_commands requires change_dir')
      const changeRoot = args.change_dir === undefined ? null : await resolveWorkspacePath(args.change_dir, exec, config, { kind: 'change_dir' })
      if (args.dry_run === true) return lossless(redactValue({ port: entries[0].port, prompt: '', results: [], notes: ['Validated preview; no device connection or journal write.'], ok: true,
        preview: entries.map(entry => ({ device: entry.device, port: entry.port, commands: entry.commands, system_view: entry.system_view === true,
          save: entry.save ?? entry.commands.some(line => !isReadOnlyCommand(line)), recovery_commands: entry.recovery_commands ?? [], change_dir: changeRoot, recovery_of: entry.recovery_of })) }, createRedactor(credentialValues(args))))
      if (changeRoot) await mkdir(changeRoot, { recursive: true })
      const outputPaths = new Set()
      for (const entry of entries) {
        if (entry.output_file) {
          const out = await resolveWorkspacePath(entry.output_file, exec, config, { kind: 'output_file' })
          const key = process.platform === 'win32' ? out.toLowerCase() : out
          if (outputPaths.has(key)) throw new Error('output_file must be different for each device')
          outputPaths.add(key)
          await prepareOutput(out, true, 'output_file')
        }
      }
      const solo = entries.length === 1
      if (args.echo_to_window) {
        if (!solo || !entries[0].device) throw new Error('echo_to_window requires one named device')
        if (entries[0].commands.some((line) => !/^(display|ping|tracert)\b/iu.test(line))) {
          throw new Error('echo_to_window only accepts display/ping/tracert commands; configuration must not execute twice')
        }
      }
      if (args.screenshot_out) {
        const out = await resolveWorkspacePath(args.screenshot_out, exec, config, { kind: 'screenshot_out' })
        await prepareOutput(out, true, 'screenshot_out')
      }
      const runs = []
      let stopped = false
      for (const entry of entries) {
        if (stopped) {
          runs.push({ device: entry.device, port: entry.port, prompt: '', results: [], checks: [], ok: false,
            skipped: entry.commands, saved: { performed: false, reason: 'previous-device-failed' }, notes: ['Skipped after previous device failure.'] })
          continue
        }
        try {
          const run = await runOnDevice(entry, {
            devices: topologyDevices,
            exec,
            config,
            bridge,
            echoArgs: solo ? args : null,
            changeRoot,
          })
          runs.push(run)
          if (!run.ok && args.continue_on_error !== true) stopped = true
        } catch (error) {
          runs.push({
            device: entry.device,
            port: entry.port,
            prompt: '',
            results: [],
            ok: false,
            skipped: entry.commands,
            saved: { performed: false, reason: 'failed' },
            notes: [`${entry.device}: ${error.message}`],
            error: error.message,
          })
          if (args.continue_on_error !== true) stopped = true
        }
      }
      if (solo) {
        return lossless({ ...runs[0], notes: [...runs[0].notes, ...notes] })
      }
      const allNotes = [...notes, ...runs.flatMap((run) => run.notes)]
      return lossless({
        device: runs.map((run) => run.device).join(','),
        port: runs[0].port,
        prompt: runs[0].prompt,
        results: runs.flatMap((run) => (run.results ?? []).map((row) => ({ ...row, device: run.device }))),
        devices: runs,
        ok: runs.every((run) => run.ok === true),
        notes: allNotes,
      })
    },
  }))

  tools.push(defineTool({
    name: 'ensp_labtest',
    description: 'Run a JSON acceptance plan using read-only display/ping/tracert commands and explicit assertions; write Markdown, CSV and JSON evidence reports. Every device is checked, including after failures.',
    parameters: {
      plan_path: { type: 'string', required: true, description: 'JSON plan inside workspace: {title?, topology_path?, devices:[{device?,port?,commands:[{cmd,expect,layer?}]}]}.' },
      report_prefix: { type: 'string', required: true, description: 'Workspace-relative filename prefix; produces .md, .csv and .json.' },
      allow_overwrite: { type: 'boolean', description: 'Overwrite existing report files; defaults to false.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => renderJson(value) },
    async execute(args, exec) {
      if (typeof args.report_prefix !== 'string' || !args.report_prefix.trim()) throw new Error('report_prefix must be a non-empty string')
      const planPath = await resolveWorkspacePath(args.plan_path, exec, config, { mustExist: true, kind: 'plan_path' })
      const plan = JSON.parse(await readFile(planPath, 'utf8'))
      validateLabPlan(plan)
      const devices = plan.topology_path
        ? (await readTopo(await resolveWorkspacePath(resolve(dirname(planPath), plan.topology_path), exec, config, { mustExist: true, kind: 'topology_path' }))).devices
        : null
      const prepared = prepareCliEntries({ devices: plan.devices }, devices)
      // Check every path before opening a console connection.
      const files = {}
      for (const [format, ext] of [['markdown', 'md'], ['csv', 'csv'], ['json', 'json']]) {
        const out = await resolveWorkspacePath(`${args.report_prefix}.${ext}`, exec, config, { kind: 'report_prefix' })
        await prepareOutput(out, args.allow_overwrite === true, 'report file')
        files[format] = out
      }
      let nextDevice = 0
      const report = await runLabTest(plan, {
        runDevice: async (entry) => {
          const target = prepared[nextDevice++]
          return runOnDevice({ ...entry, port: target.port }, { devices, exec, config, bridge, echoArgs: null })
        },
      })
      const rendered = renderLabReports(report)
      for (const format of Object.keys(files)) await writeFile(files[format], rendered[format], { encoding: 'utf8', flag: args.allow_overwrite === true ? 'w' : 'wx' })
      return lossless({ ...report, files })
    },
  }))

  tools.push(defineTool({
    name: 'ensp_topo',
    description: 'Read or rewrite an eNSP .topo file without touching the GUI: list devices with models and console ports, rename devices, set PC/server IPv4, renumber console ports, or propose SW1/SW2/AR1 names.',
    parameters: {
      topology_path: { type: 'string', required: true, description: 'Existing .topo file inside the workspace.' },
      action: { type: 'string', required: true, description: 'list | suggest-names | rename | set-ip | set-ports.' },
      renames: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'For rename: [{from, to}].' },
      device: { type: 'string', description: 'For set-ip: device name.' },
      ip: { type: 'string' },
      mask: { type: 'string' },
      gateway: { type: 'string' },
      port: { type: 'integer', description: 'For set-ports: starting console port; defaults to 2000.' },
      out_path: { type: 'string', description: 'Write the result to this path (never edits the source in place).' },
      allow_overwrite: { type: 'boolean' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          topologyPath: { type: 'string', required: true },
          action: { type: 'string', required: true },
          version: { type: 'string', required: true },
          devices: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          suggestions: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          written: { type: 'string' },
          notes: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const path = await resolveWorkspacePath(args.topology_path, exec, config, { mustExist: true, kind: 'topology_path' })
      await assertRegularFile(path, 'topology_path')
      if (extname(path).toLowerCase() !== '.topo') throw new Error('topology_path must end in .topo')
      const parsed = await readTopo(path)
      const action = String(args.action)
      const notes = []
      let text = parsed.text
      let written

      if (action === 'rename') {
        const renames = Array.isArray(args.renames) ? args.renames : []
        if (renames.length === 0) throw new Error('rename needs renames: [{from, to}]')
        for (const item of renames) text = renameDevice(text, String(item.from), String(item.to))
      } else if (action === 'set-ip') {
        if (!args.device) throw new Error('set-ip needs device')
        text = setDeviceIpv4(text, String(args.device), { ip: args.ip, mask: args.mask, gateway: args.gateway })
      } else if (action === 'set-ports') {
        const renumbered = renumberComPorts(text, { start: args.port ?? 2000 })
        text = renumbered.text
        notes.push(`已分配/保留控制台端口：${renumbered.assigned.map((entry) => `${entry.name}=${entry.comPort}`).join(', ')}`)
      } else if (action !== 'list' && action !== 'suggest-names') {
        throw new Error(`unknown action ${action}`)
      }

      if (action === 'rename' || action === 'set-ip' || action === 'set-ports') {
        const out = args.out_path
          ? await resolveWorkspacePath(args.out_path, exec, config, { kind: 'out_path' })
          : join(dirname(path), `${basename(path, '.topo')}.edited.topo`)
        await prepareOutput(out, args.allow_overwrite === true, 'out_path')
        await writeTopo(out, text, { encoding: parsed.encoding })
        written = out
        notes.push('eNSP 需要在关闭该拓扑后重新打开，改动才会显示。')
      }

      const after = parseTopo(text)
      return lossless({
        topologyPath: path,
        action,
        version: after.version ?? '',
        devices: describeDevices(after),
        suggestions: action === 'suggest-names' ? suggestNames(after.devices) : [],
        written,
        notes,
      })
    },
  }))

  tools.push(defineTool({
    name: 'ensp_ref',
    description: 'Convert a reference document (.docx / .pptx / .txt) into plain text in one call. Read that .txt afterwards instead of parsing the Office file again and again — long binary reads get compressed in transit and cost a round trip each time.',
    parameters: {
      path: { type: 'string', required: true, description: 'Reference file inside the workspace: .docx / .pptx / .txt / .md.' },
      out: { type: 'string', description: 'Where to write the text; defaults to 工作区/笔记/<file name>.txt.' },
      preview_chars: { type: 'integer', description: 'How many characters of the dump to return inline; defaults to 1200.' },
      allow_overwrite: { type: 'boolean', description: 'Re-dump even if the .txt already exists and is newer; defaults to false (cache hit).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          out: { type: 'string', required: true },
          kind: { type: 'string' },
          chars: { type: 'integer' },
          lines: { type: 'integer' },
          cached: { type: 'boolean' },
          preview: { type: 'string' },
          notes: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const notes = []
      const source = await resolveWorkspacePath(args.path, exec, config, { mustExist: true, kind: 'reference file' })
      const base = basename(source).replace(/\.[^.]+$/u, '')
      const out = args.out
        ? await resolveWorkspacePath(args.out, exec, config, { kind: 'out' })
        : join(dirname(source), `${base}.txt`)
      const cached = existsSync(out) && statSyncSafe(out) >= statSyncSafe(source)
      if (cached && args.allow_overwrite !== true) {
        const text = readFileSync(out, 'utf8')
        notes.push('已有更新的文本版本，直接复用（要强制重转传 allow_overwrite:true）。')
        return lossless({
          out, kind: extname(source).replace('.', ''), chars: text.length,
          lines: text.split('\n').length, cached: true,
          preview: text.slice(0, Number(args.preview_chars ?? 1200)), notes,
        })
      }
      const python = await resolveDocsPython(config, notes)
      const run = await runProcess(python, [REF_SCRIPT, source, out], { timeoutMs: 120000 })
      if (run.code !== 0) {
        throw new Error(`reference dump failed: ${run.stderr.trim() || run.stdout.trim()}`)
      }
      let parsed = {}
      try {
        parsed = JSON.parse(String(run.stdout ?? '').trim().split('\n').pop() ?? '{}')
      } catch (error) {
        parsed = {}
      }
      const text = readFileSync(out, 'utf8')
      notes.push('后续直接读这个 .txt，不要再来回转 docx/pptx。')
      return lossless({
        out,
        kind: parsed.kind ?? extname(source).replace('.', ''),
        chars: parsed.chars ?? text.length,
        lines: parsed.lines ?? text.split('\n').length,
        cached: false,
        preview: text.slice(0, Number(args.preview_chars ?? 1200)),
        notes,
      })
    },
  }))

  tools.push(defineTool({
    name: 'ensp_doc',
    description: 'Build the two lab deliverables from a screenshot manifest: a captioned report (one short sentence under each screenshot) and a bare copy (screenshots only, no prose), plus the plaintext credential table. Pass template_path to make the bare copy out of the teacher\'s original .docx: its text, numbering and layout stay untouched and each section\'s screenshots go into the blank paragraphs after that step.',
    parameters: {
      title: { type: 'string', required: true, description: 'Report title, usually the lab task name.' },
      output_dir: { type: 'string', required: true, description: 'Directory inside the workspace for the .docx files.' },
      sections: {
        type: 'array',
        required: true,
        description: 'Ordered sections: {heading, paragraphs?, commands?, images:[{path, caption?, width_cm?}], anchor?}. In the bare copy only heading + images survive. With template_path the heading (or anchor) must start with the template line it belongs under, e.g. "步骤3".',
        items: { type: 'object', additionalProperties: true },
      },
      template_path: { type: 'string', description: 'Original task .docx for the bare copy. Its paragraphs are preserved byte for byte; screenshots fill the blank lines under each 步骤N.' },
      subtitle: { type: 'string', description: 'Line under the title (name / class / date).' },
      credentials: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Password table rows: {item, value}.' },
      notes: { type: 'array', items: { type: 'string' }, description: 'Closing notes (captioned copy only).' },
      file_stem: { type: 'string', description: 'Base file name; defaults to the sanitized title.' },
      verify: { type: 'boolean', description: 'Compare the bare copy against template_path (paragraphs / non-empty text / pictures) and return verification; defaults to true when template_path is given.' },
      clean_probe: { type: 'boolean', description: 'Delete leftover _*.png probe screenshots next to the images used (they are never referenced); defaults to true.' },
      allow_overwrite: { type: 'boolean' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          captioned: { type: 'string' },
          bare: { type: 'string' },
          images: { type: 'integer', required: true },
          verification: { type: 'object', additionalProperties: true },
          cleaned: { type: 'array', items: { type: 'string' } },
          notes: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const notes = []
      const dir = await resolveWorkspacePath(args.output_dir, exec, config, { kind: 'output_dir' })
      await mkdir(dir, { recursive: true })
      const stem = (args.file_stem ?? args.title ?? '实验报告').replace(/[\\/:*?"<>|]/gu, '_')
      const captionedOut = join(dir, `${stem}-说明版.docx`)
      const bareOut = join(dir, `${stem}-纯截图版.docx`)
      if (args.allow_overwrite !== true) {
        if (existsSync(captionedOut)) throw new Error(`captioned report already exists: ${captionedOut}`)
        if (existsSync(bareOut)) throw new Error(`bare report already exists: ${bareOut}`)
      }
      const sections = []
      for (const section of Array.isArray(args.sections) ? args.sections : []) {
        const images = []
        for (const image of Array.isArray(section.images) ? section.images : []) {
          if (!image || typeof image.path !== 'string' || !image.path.trim()) continue
          // Relative paths are relative to the workspace, not to the python cwd.
          const resolved = await resolveWorkspacePath(image.path, exec, config, { mustExist: true, kind: 'image path' })
          images.push({ ...image, path: resolved })
        }
        sections.push({ ...section, images })
      }
      let template = ''
      if (args.template_path) {
        template = await resolveTemplatePath(args.template_path, exec, config, notes)
      }
      const manifestBase = {
        title: args.title,
        subtitle: args.subtitle,
        credentials: args.credentials,
        notes: args.notes,
        sections,
      }
      const python = await resolveDocsPython(config, notes)
      const dirWork = await mkdtemp(join(tmpdir(), 'dsh-ensp-doc-'))
      const built = []
      for (const [mode, out] of [['captioned', captionedOut], ['bare', bareOut]]) {
        const manifest = { ...manifestBase, mode, output: out }
        if (mode === 'bare' && template) {
          manifest.mode = 'template'
          manifest.template = template
        }
        const manifestPath = join(dirWork, `${mode}.json`)
        await writeFile(manifestPath, JSON.stringify(manifest, null, 1), 'utf8')
        const run = await runProcess(python, [DOCS_SCRIPT, manifestPath], { timeoutMs: 120000 })
        if (run.code !== 0) {
          throw new Error(`document build failed (${mode}): ${run.stderr.trim() || run.stdout.trim()}`)
        }
        let parsed = null
        try {
          parsed = JSON.parse(String(run.stdout ?? '').trim().split('\n').pop() ?? 'null')
        } catch (error) {
          parsed = null
        }
        built.push({ mode, out, result: parsed })
      }
      const images = sections.reduce((sum, section) => sum + (section.images?.length ?? 0), 0)
      const bareRun = built.find((item) => item.mode === 'bare')
      let verification
      if (bareRun?.result?.verification) {
        verification = bareRun.result.verification
        if (verification.ok === false) {
          notes.push(`纯截图版与模板不一致：模板 ${verification.template.textParagraphs} 个非空段 / ${verification.template.images} 张图，`
            + `产出 ${verification.output.textParagraphs} 个非空段 / ${verification.output.images} 张图——正文可能被改动。`)
        }
      } else if (template) {
        notes.push('模板模式没有返回结构校验结果（python-docx 版本可能过旧）。')
      }
      const cleaned = []
      if (args.clean_probe !== false) {
        const dirs = new Set(sections.flatMap((section) => (section.images ?? []).map((image) => dirname(image.path))))
        for (const folder of dirs) {
          let entries = []
          try {
            entries = await readdir(folder, { withFileTypes: true })
          } catch (error) {
            continue
          }
          for (const entry of entries) {
            if (!entry.isFile() || !entry.name.startsWith('_') || !/\.(png|jpe?g)$/iu.test(entry.name)) continue
            const full = join(folder, entry.name)
            try {
              await rm(full, { force: true })
              cleaned.push(full)
            } catch (error) {
              // best effort only
            }
          }
        }
        if (cleaned.length > 0) notes.push(`清理了 ${cleaned.length} 张 \`_\` 开头的过程截图。`)
      }
      return lossless({ captioned: captionedOut, bare: bareOut, images, verification, cleaned, notes })
    },
  }))

  return tools
}

// --------------------------------------------------------------- environment

async function listInstalledEnsp(config) {
  const roots = new Set()
  const candidates = [
    'C:/Program Files/Huawei',
    'C:/Program Files (x86)/Huawei',
    'D:/Program Files/Huawei',
    config.enspExecutable,
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    const path = candidate.replace(/\//gu, '\\')
    if (path.toLowerCase().endsWith('ensp_client.exe')) {
      if (existsSync(path)) roots.add(dirname(path))
      continue
    }
    try {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (!/^ensp/iu.test(entry.name)) continue
        const exe = join(path, entry.name, 'eNSP_Client.exe')
        if (existsSync(exe)) roots.add(join(path, entry.name))
      }
    } catch {
      // missing folder
    }
  }
  const rows = []
  for (const root of roots) {
    rows.push({ path: join(root, 'eNSP_Client.exe'), root })
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path))
}

async function resolveDocsPython(config, notes) {
  const explicit = (config.docsPythonExecutable ?? '').trim()
  if (explicit && existsSync(explicit)) return explicit
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const runtimeRoot = home ? join(home, '.dsh', 'dsh-runtimes') : ''
  if (runtimeRoot) {
    try {
      const entries = await readdir(runtimeRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const exe = join(runtimeRoot, entry.name, 'dependencies', 'python', 'python.exe')
        if (existsSync(exe)) {
          notes.push(`使用 DSH 自带 Python 生成文档：${exe}`)
          return exe
        }
      }
    } catch {
      // no runtimes folder
    }
  }
  notes.push('没有找到带 python-docx 的 Python，改用 PATH 上的 python；如果失败请设置 docsPythonExecutable。')
  return 'python'
}

// --------------------------------------------------------------- registration

export function apply(ctx, config) {
  const bridge = new Bridge(config, { bridge: BRIDGE_PATH, launch: LAUNCH_PATH })
  if (config.registerSkill) {
    const definition = readSkillDefinition(SKILL_PATH)
    ctx.skills.register({
      ...definition,
      source: 'bundled',
      provider: 'dsh-ensp',
      resourceBase: { kind: 'directory', path: SKILL_ROOT },
    })
  }
  if (config.injectPrompt && ctx.systemPrompt) {
    ctx.systemPrompt.section({
      name: 'ensp:automation',
      order: 130,
      text: PROMPT_SECTION,
    })
  }
  for (const tool of createTools(config, bridge)) ctx.tools.register(tool)
}

export { PROMPT_SECTION, BRIDGE_PATH, DOCS_SCRIPT }
