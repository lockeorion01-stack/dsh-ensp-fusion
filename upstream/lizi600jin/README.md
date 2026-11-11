<p align="center">
  <strong>中文</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-ensp"><img alt="npm" src="https://img.shields.io/npm/v/dsh-ensp?style=flat-square&color=6c5ce7"></a>
  <a href="https://www.npmjs.com/package/dsh-ensp"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-ensp?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/lizi600jin/dsh-ensp/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/lizi600jin/dsh-ensp?style=flat-square&color=eab308"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue?style=flat-square"></a>
</p>

# dsh-ensp

面向华为 eNSP 的自动化工具。生成拓扑、启动设备、按顺序下发配置，并在每条命令后核对结果。

提供三种调用方式，共用同一套核心：

- CLI：适合脚本化批量操作
- MCP Server：接入 Claude Desktop、Cursor 等客户端
- DeepSeek Harness 插件：以模型工具的形式在会话内使用

## 功能

### 生成拓扑

生成 eNSP 可直接打开并正常显示的 `.topo` 文件。支持内置场景，也可自定义设备与链路。

```js
import { twoPcLab, writeTopology } from 'dsh-ensp'

await writeTopology('lab.topo', twoPcLab({ vlan: 10 }))
```

```js
import { buildTopology, autoLayout } from 'dsh-ensp'

const topo = autoLayout(
  buildTopology()
    .add('R1', 'AR2220', { x: 180, y: 120 })
    .add('R2', 'AR2220', { x: 460, y: 260 })
    .link('R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0')
    .finish()
)
```

拓扑格式有几处约束来自 eNSP 本身：接口分组必须与机型一致，链路锚点必须落在图标包围盒内。写错任意一项，eNSP 会打开一个没有任何设备的空白画布，并且不报错。规则见 [`docs/ENSP-FORMAT.md`](docs/ENSP-FORMAT.md)。

### 启动与停止设备

自动定位工具栏按钮，无需手动点击。启动后按设备逐一确认就绪，窗口随即最小化，桌面可继续使用。

```bash
ensp probe          # 重新标定按钮位置
ensp up lab.topo    # 打开、启动、确认就绪、最小化
ensp stop           # 关闭全部设备
```

eNSP 只允许运行一个实例，异常退出时可能留下不占线程的僵尸进程，它会一直持有这个单实例锁，使下一次启动打开空白窗口。工具在启动前会识别并清理这种进程。

### 下发配置

逐条发送，每条命令确认提示符返回后才继续。任一命令出错即中断，并回报行号、命令与设备原始输出。

```js
import { pushConfig } from 'dsh-ensp'

const result = await pushConfig({
  device: 'SW1',
  port: 2000,
  script: `
    system-view
    vlan 10
     quit
    interface GigabitEthernet0/0/1
     port link-type access
     port default vlan 10
     quit
  `,
})

if (!result.ok) {
  console.log(result.failedAt.line, result.failedAt.command, result.failedAt.error)
}
```

### 等待协议收敛

路由协议是异步收敛的，配置下发完不代表邻居已经建立。这类断言一律走轮询，直到状态达成或超时。

```js
import { waitForOspfFull, waitForOspfRoute, waitForOutput } from 'dsh-ensp'

await waitForOspfFull({ port: 2000, neighbourId: '2.2.2.2' })
await waitForOspfRoute({ port: 2000, prefix: '2.2.2.2/32' })
await waitForOutput({ port: 2000, command: 'display ip routing-table', until: /2\.2\.2\.2/ })
```

三个函数都返回 `{ ok, converged, output, attempts, waitedMs }`。固定等待一段时间再查询，在慢机器上会误判为失败，在快机器上纯属浪费。

### 场景预设

内置 23 个场景，覆盖 VLAN、STP、静态路由、RIP、OSPF、BGP、NAT、DHCP、ACL、IPsec、IPv6、WLAN、IS-IS 等主题。

```bash
ensp preset                      # 按难度列出全部
ensp preset ospf-single          # 查看某个场景
ensp preset --search bgp         # 按关键词搜索
```

每个场景给出三项信息：需要创建的对象、配置顺序、用于确认结果的检查命令。具体命令由使用者按设备补全。

## 安装

### 作为 DSH 插件

在插件市场搜索 `dsh-ensp` 并安装，或：

```console
dsh plugin --profile desktop add dsh-ensp
```

### 作为 CLI 或库

```console
npm install -g dsh-ensp
ensp status
```

### 作为 MCP Server

```json
{
  "mcpServers": {
    "ensp": {
      "command": "npx",
      "args": ["-y", "dsh-ensp", "mcp"]
    }
  }
}
```

提供 12 个工具：`ensp_status`、`ensp_build_topology`、`ensp_open`、`ensp_start`、`ensp_stop`、`ensp_apply`、`ensp_apply_dir`、`ensp_query`、`ensp_probe`、`ensp_scenarios`、`ensp_scenario`、`ensp_preset_config`。

## 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | Windows。eNSP 仅有 Windows 版本 |
| eNSP | 已安装且可正常运行，需要管理员权限 |
| Node.js | 18 或更高版本 |
| 权限 | 插件与 eNSP 需处于相同权限级别 |

系统缩放设为 125% 或 150% 时，程序会自行完成坐标换算，不需要手动调分辨率。若 eNSP 升级后按钮位置改变，执行 `ensp probe` 重新标定。

## 快速开始

```bash
ensp preset vlan-access          # 查看场景方向

node -e "import('dsh-ensp').then(async m => {
  await m.writeTopology('lab.topo', m.twoPcLab())
})"

ensp up lab.topo                 # 启动设备
ensp status --topology lab.topo  # 查看控制台状态
ensp apply ./configs --topology lab.topo --save
```

性能取决于部署环境，本文不提供特定机器的计时基准。

## 致谢与许可

### 开源协议

采用 [GPL-3.0-or-later](LICENSE)。

基于本项目修改并对外分发时，需要：

1. 保留 `LICENSE` 中的版权声明；
2. 在源码及随附文档中注明原项目名称 `dsh-ensp` 与仓库地址 <https://github.com/lizi600jin/dsh-ensp>；
3. 使所分发的作品同样以 GPL-3.0-or-later 授权。

仅自行使用而不对外分发时，上述要求不适用。

未选用 MIT 或 Apache-2.0，是因为这两者允许二次修改后闭源，与"二次修改也须开源"的意愿冲突。

### 致谢

- Huawei eNSP：仿真器本体。
- 在 issue 中反馈问题的使用者。

## 免责声明

本项目是一个自动化外壳，不包含 eNSP，也不包含任何华为软件或镜像。使用前请自行安装，并遵守华为的软件许可。

自动化操作图形界面存在固有风险，例如窗口被遮挡、eNSP 版本升级、系统缩放变化。建议先在非关键环境中验证。

## 相关文档

| 文档 | 内容 |
|---|---|
| [`docs/ENSP-FORMAT.md`](docs/ENSP-FORMAT.md) | `.topo` 格式规则 |
| [`docs/UI-ANCHORS.md`](docs/UI-ANCHORS.md) | 界面坐标与启动流程 |
| [`docs/SCENARIOS.md`](docs/SCENARIOS.md) | 场景预设说明 |
