# dsh-ensp-fusion

**面向华为 eNSP 的网络实验自动化插件，统一提供 DSH、MCP 和命令行入口。**

本项目 **dsh-ensp-fusion** 基于开源项目进行二次开发与融合增强。其中，拓扑构建、解析与实验场景模块复用了 **lizi600jin** 的 [dsh-ensp](https://github.com/lizi600jin/dsh-ensp)；基础 GUI、控制台与文档流程经 ENSPLB 增强实现继承自 **YunoSeng** 的 [dsh-ensp](https://github.com/YunoSeng/dsh-ensp)。感谢原作者提供的基础实现。本项目整体采用 **GPL-3.0-or-later**，保留上游作者署名与许可声明，详见[来源与许可](#来源与许可)。

将拓扑构建、设备配置、协议检查、业务探测和报告取证连接成一套可重复执行的实验流程。适用于网络教学、协议实验、园区方案验证，以及需要通过 AI 客户端调用 eNSP 的开发者。

- **统一调用**：三个入口复用同一组 19 个工具，配套 23 个实验指导和 2 个 DSH 技能。
- **完整流程**：从生成拓扑、配置前探查、下发命令，到等待收敛、执行断言和整理证据。
- **可追溯结果**：支持变更预览、控制台锁、工程配置检查点、控制台诊断和脱敏日志导出；验收区分通过、失败、错误和未执行。

当前版本 **1.1.3**，支持 **DSH 0.2.2-rc.1 和 0.2.2-rc.3**。本版适配 rc.3 宿主，修复冻结参数、失败结果上报与工程配置资产检查，并完善 CLI 交互、控制台诊断和日志脱敏。详见 [1.1.3 更新说明](docs/releases/1.1.3.zh-CN.md)和[完整更新日志](CHANGELOG.md)。npm 尚未发布，请按下文使用源码或本地打包安装。

> 软件检查与设备业务分别验收：当前软件测试及目标 DSH 宿主服务验证通过，**园区现场业务总验收仍为 FAIL**。冷 ARP 丢包、端到端吞吐瓶颈及指定 S5700 固件的 TCP 隔离问题仍待解决。见[验收摘要](docs/TOTAL-ACCEPTANCE.zh-CN.md)和[已知问题](docs/KNOWN-ISSUES.zh-CN.md)。

## 能做什么

| 实验环节 | 提供的能力 |
| --- | --- |
| 准备环境 | 发现 eNSP 实例，检查解释器、桥接与控制台端口 |
| 构建实验 | 读取、修改或新建拓扑，搜索实验指导，生成配置计划和 Mermaid 源码 |
| 配置设备 | Telnet 登录、只读探查、配置预览与下发、回显断言、保存确认 |
| 检查网络 | OSPF 邻居与路由等待、LLDP 双向链路比对、HTTP/DNS/FTP/TCP 探测 |
| 执行验收 | 按计划执行、保留失败与未执行项、登记清理动作、检查中断状态 |
| 交付证据 | 截图、Markdown/CSV/JSON 验收结果、带图文的 Word 报告 |

典型顺序：**创建或读取拓扑 → 探查设备 → 预览并下发配置 → 等待收敛 → 执行业务断言 → 保存证据**。

## 环境与兼容性

| 项目 | 当前要求与已验证范围 |
| --- | --- |
| Node.js | 20 及以上；源码安装使用 npm 和锁文件 |
| DSH 插件 | DSH **0.2.2-rc.1、0.2.2-rc.3**；其他宿主版本需另行核验 |
| Node 依赖 | `@deepseek-ai/dsh-tools` 仅接受上述两个版本；锁文件使用 rc.3；`@deepseek-ai/schemastery@3.19.0` |
| MCP / CLI | 独立运行，无需启动 DSH；仍需安装本包的 Node 依赖 |
| GUI 自动化 | Windows 交互桌面、eNSP、Python、pywin32、Pillow，以及匹配的权限 |
| Word 报告 | 文档解释器安装 python-docx |
| 设备运行 | 自行准备匹配的虚拟化环境、设备镜像与实验工作区 |

仅使用离线拓扑和计划功能时无需 GUI 依赖。Python 已验证组合见 [requirements-windows.lock.txt](requirements-windows.lock.txt)；完整安装和排错见[部署手册](docs/DEPLOYMENT.zh-CN.md)。

## 快速开始

### 1. 获取并检查源码

```powershell
git clone https://github.com/lockeorion01-stack/dsh-ensp-fusion.git
Set-Location dsh-ensp-fusion
npm ci --ignore-scripts
node bin/dsh-ensp-mcp.mjs --version
node bin/ensp-fusion.mjs tools
```

当前版本应显示 `1.1.3`，`tools` 应列出 19 项及其参数 schema。这两条检查命令不会启动 eNSP。

### 2. 生成第一个拓扑

从源码根目录执行，将实验输出放在独立目录：

```powershell
$Workspace = Join-Path $env:TEMP ('ensp-fusion-lab-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Workspace | Out-Null
node bin/ensp-fusion.mjs scenarios ospf
node bin/ensp-fusion.mjs call ensp_build examples/build-router-pair.json $Workspace
```

输出为 `$Workspace/router-pair.topo`，包含两台相连的 AR2220。构建器拒绝覆盖已有输出；生成拓扑不会启动设备。运行时需要 eNSP 和配套镜像。已有工程迁移时，应同时保留 `.topo` 与配套设备目录。

### 3. 选择调用入口

**DSH 插件**：在源码根目录运行 `npm pack --ignore-scripts`，然后将生成的包安装到实际使用的 profile。以下以 `desktop` 为例：

```powershell
dsh plugin --profile desktop add "C:/tools/dsh-ensp-fusion/dsh-ensp-fusion-1.1.3.tgz"
```

替换为实际包路径。首次接入还需按[DSH 配置说明](docs/DEPLOYMENT.zh-CN.md#4-dsh接入)合并 bundle；升级后重新加载插件。DSH rc.3 会拒绝旧 1.1.2 的 rc.1 单版本声明；若仍显示旧版，检查实际加载路径和缓存，并通过 `ensp_status` 核对版本、构建指纹及加载时间。

**MCP 客户端**：按客户端要求合并配置，替换代码目录与实验目录：

```json
{
  "mcpServers": {
    "ensp-fusion": {
      "command": "node",
      "args": [
        "C:/tools/dsh-ensp-fusion/bin/dsh-ensp-mcp.mjs",
        "--workspace", "C:/labs/ensp"
      ]
    }
  }
}
```

MCP 使用 stdio。GUI 和 Word 功能的解释器可分别通过 `--python`、`--docs-python` 指定，配置后重新加载 MCP 服务。

**CLI**：直接调用 `node bin/ensp-fusion.mjs call <工具名> <参数.json> [工作区]`。五个命令行入口如下：

| 入口 | 源码入口 | 用途 |
| --- | --- | --- |
| `ensp-fusion` | `bin/ensp-fusion.mjs` | 列举工具、搜索场景、调用统一工具 |
| `ensp-fusion-mcp` | `bin/dsh-ensp-mcp.mjs` | MCP stdio 服务 |
| `ensp-fusion-lab` | `bin/dsh-ensp-lab.mjs` | 配置计划生成、Mermaid 源码导出、显式只读验收 |
| `ensp-fusion-accept` | `bin/ensp-fusion-accept.mjs` | 验收编排、状态检查、受保护恢复及业务证据评估 |
| `ensp-fusion-doctor` | `bin/ensp-fusion-doctor.mjs` | 只读环境诊断 |

这些命令映射到源码 `bin/` 中的对应入口；直接从源码运行时使用 `node bin/<入口文件>`。各入口支持 `--help`。

## 19 个统一工具

| 工具 | 作用 | 使用要点 |
| --- | --- | --- |
| `ensp_status` | 实例发现、桥接检查、拓扑和控制台探测 | 端口开放后仍需确认设备就绪 |
| `ensp_topo` | 离线读取或修改设备名、IPv4、控制台端口等 | 修改文件后，运行现场需另行载入 |
| `ensp_build` | 按设备和链路生成新拓扑 | 拒绝覆盖，不启动设备 |
| `ensp_scenarios` | 搜索和读取 23 个实验指导 | 指导需要结合设备和固件形成配置 |
| `ensp_inspect` | 采集版本、配置、接口、路由和 LLDP | 配置前只读探查，保留逐命令证据 |
| `ensp_cli` | 认证、预览、配置下发、断言、保存与显式恢复 | 失败时可能已有部分配置生效 |
| `ensp_wait` | 等待指定回显、OSPF Full 邻居或 OSPF 路由 | 使用明确条件和超时 |
| `ensp_labtest` | 执行只读验收计划，输出多格式结果 | 用 `expect` 定义通过条件 |
| `ensp_services` | HTTP 内容、DNS、匿名 FTP 下载校验和 TCP 探测 | 从宿主机发起，需另验 eNSP 终端路径 |
| `ensp_lldp` | 对比预期链路与双向 LLDP 证据 | 默认五分钟新鲜度；缺证据为 INCONCLUSIVE |
| `ensp_diagnose` | 离线错误分类、丢包分析和只读探测建议 | UNKNOWN 需要继续取证 |
| `ensp_gui` | 批量窗口操作、启动/停止与设备就绪检测 | 需要可交互桌面和正确权限 |
| `ensp_shot` | 截取主窗口、设备窗口或屏幕 | 截图作为证据，业务另行断言 |
| `ensp_capture` | 批量开窗、只读回显与截图取证 | 按只读命令计划执行 |
| `ensp_ref` | 提取参考文档信息 | 使用前核对来源和适用条件 |
| `ensp_doc` | 生成带图文或基于模板的 Word 报告 | 需要 Python 文档依赖 |
| `ensp_project` | 核对工程配置内容、创建检查点和对比磁盘资产 | 检查点不含 VM 磁盘；不证明重开加载 |
| `ensp_console_diagnose` | 单次控制台探测、按 UUID 关联串口与同步日志 | 只读诊断，不自动重启、不把 `#` 当 VRP |
| `ensp_logexport` | 从 JSONL/连续 Zstandard 会话生成脱敏副本 | 原日志不改写；Zstandard 需 Node 22.15+ |

通用构建器支持 **12 种型号**：S5700、S3700、AR2220、AR2240、AR1220、USG5500、USG6000V、AC6005、PC、Client、Server、Cloud。设备名使用 ASCII 标识符。Client/Server 支持原生 Ethernet 及 IPv4/DNS 启动参数；应用服务目录和启动状态需单独恢复、检查。

## 验证结果与已知限制

以下为 **2026-11-14、1.1.3** 的验证结果。软件检查、配置持久化和园区业务分别记录：

| 层次 | 结果 | 已覆盖范围 |
| --- | --- | --- |
| 软件回归 | PASS | 308 项 Node 测试、24 项 MCP 冒烟 |
| 分发检查 | PASS | 插件检查、离线干净安装、外部目录 CLI、MCP 初始化及发布前检查 |
| DSH 0.2.2-rc.3 宿主服务 | PASS | 隔离宿主中的兼容性判定、19 工具、2 技能、系统提示、原生执行器和卸载清理；另有 rc.1 SDK 回归 |
| 三台 USG 配置持久化 | PASS | 真实 VRP 控制台、版本及配置回读；设备保存、工程关闭并同路径重开后，选定关键项 39/39/23 全部匹配 |
| 桌面安装与运行会话同步 | PASS（本机） | GitHub 安装副本已通过宿主检查；运行中 `ensp_status` 的安装路径与构建指纹均已匹配，包含两项资产检查修复；见 [部署核验](docs/releases/1.1.3.zh-CN.md#后续部署核验) |
| 园区业务总验收 | **FAIL** | 冷 ARP、端到端吞吐及指定固件 TCP 隔离仍有失败 |

宿主验证在独立进程调用已安装 DSH 的真实服务，不修改用户 profile，也不覆盖完整桌面模型会话。三台 USG 的配置持久化通过不能证明数据面、HRP 接管时限、吞吐或长时间稳定性通过。

本轮财务墙从原生导出的 `fwcw.cfg` 成功加载；源码修复了尾随 sysinfo ZIP 和自定义 `.cfg` 引起的检查假阴性。磁盘资产检查仍不能单独证明设备已加载配置，现场结论以关闭重开后的控制台回读为依据，详见[本轮验收记录](docs/USG-REOPEN-ACCEPTANCE-20261114.zh-CN.md)。

历史业务证据包括原生 HTTP/DNS/FTP、四台 Server 修复副本，以及两轮 0.5/2/8 Mbps、1/8/32 UDP 流的 USG 转发样本。入口/出口样本零丢包，外侧终端约 1.94 Mbps 的瓶颈尚未定位；这些样本不能推断最大吞吐或 TCP 并发。历史结果与未完成项见[验收摘要](docs/TOTAL-ACCEPTANCE.zh-CN.md)及 [1.1.2 说明](docs/releases/1.1.2.zh-CN.md)。

部署前还需了解：

- GUI 依赖解锁的 Windows 桌面；锁屏、模态窗、权限或窗口缩放可能中断操作。
- 配置执行失败后不会自动回滚已生效命令。先检查部分结果，再按[变更管理](docs/CHANGE-MANAGEMENT.zh-CN.md)与[恢复流程](docs/ACCEPTANCE-RUNNER.zh-CN.md)处理。
- 通用构建器的型号支持代表拓扑生成能力；AP/STA 通用构建、全部固件组合、24/72 小时稳定性与 200 Mbps 负载尚未完成验收。
- 包内不分发设备镜像、虚拟磁盘、凭据或原始现场数据。截图、历史日志和未知 CLI 语法仍需人工核查敏感内容。

## 开发与验证

在完整源码根目录执行：

```powershell
npm test
npm run check:plugin
npm run test:package
npm run check:release
git diff --check
```

修改 DSH 依赖或注册契约时，在目标宿主环境额外执行：

```powershell
npm run check:dsh
# 非默认安装位置：
npm run check:dsh -- --app "C:/path/to/DeepSeek Harness.exe"
```

`test:package` 依赖本机 npm 缓存和 tar；`check:dsh` 要求已安装目标 DSH 桌面版。这些检查不启动 eNSP。分发包只包含运行文件、文档、示例与夹具，开发脚本和完整测试应从源码运行。贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 项目结构

| 目录或文件 | 职责 |
| --- | --- |
| `index.js`、`base.js` | DSH 入口、配置和基础工具注册 |
| `lib/` | 设备会话、GUI 桥、融合工具、验收与恢复 |
| `mcp/`、`bin/` | MCP 适配和命令行入口 |
| `skills/`、`locale/` | 宿主指导和本地化 |
| `upstream/` | 复用来源代码与许可证 |
| `examples/`、`test/`、`scripts/` | 示例、自动化测试和维护检查 |
| `docs/` | 部署、设计、验收及版本说明 |

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [1.1.3 更新说明](docs/releases/1.1.3.zh-CN.md) / [更新日志](CHANGELOG.md) | DSH rc.3 兼容修复、升级及历史变更 |
| [部署手册](docs/DEPLOYMENT.zh-CN.md) | DSH/MCP/CLI 接入、依赖与排错 |
| [统一验收](docs/ACCEPTANCE-RUNNER.zh-CN.md) / [变更管理](docs/CHANGE-MANAGEMENT.zh-CN.md) | 计划、断言、日志和恢复 |
| [验收摘要](docs/TOTAL-ACCEPTANCE.zh-CN.md) / [已知问题](docs/KNOWN-ISSUES.zh-CN.md) | 成功范围、失败项和未测项 |
| [可靠性修复](docs/RELIABILITY-HARDENING.zh-CN.md) / [模块实现记录](docs/REMAINING-MODULES.zh-CN.md) | 实现与验证过程 |
| [项目对比](docs/GRBJ-COMPARISON.zh-CN.md) / [源码分析](docs/ANALYSIS.zh-CN.md) | 来源分析和能力补齐 |
| [GitHub 发布指南](docs/GITHUB-RELEASE.zh-CN.md) | 提交检查、推送和分发边界 |

## 来源与许可

### 上游项目与作者署名

本项目包含上游代码复用与修改，来源如下：

| 来源 | 作者或来源标识 | 复用与衍生内容 | 保留的许可 |
| --- | --- | --- | --- |
| [dsh-ensp](https://github.com/lizi600jin/dsh-ensp) | lizi600jin | 拓扑构建、解析及实验场景模块，通过适配层接入融合版 | [GPL-3.0-or-later](upstream/lizi600jin/LICENSE) |
| [dsh-ensp](https://github.com/YunoSeng/dsh-ensp) | YunoSeng | 经 ENSPLB 增强实现接入的基础 GUI、控制台、拓扑编辑与文档流程 | [MIT 原始声明](LICENSE-MIT) |
| ENSPLB 增强实现 | 详见来源记录 | 设备会话、错误处理、保存确认、就绪检测与只读验收等增强 | 随来源保留相关声明 |

融合版在上述实现上增加统一工具注册与 DSH/MCP/CLI 适配，并扩展诊断、LLDP 链路核对、业务探测、工程检查点、脱敏日志导出及验收恢复流程。来源与修改说明见 [NOTICE.md](NOTICE.md)及[源码融合设计](docs/ANALYSIS.zh-CN.md)。这些扩展不改变上游代码的作者归属。

### 开源协议与再分发

本项目整体采用 **[GPL-3.0-or-later](LICENSE)**，即 GNU GPL 第 3 版或其后续版本。遵循 lizi600jin/dsh-ensp 的来源署名要求，修改或再次分发本项目时应：

1. 保留原有版权、许可及无担保声明，随附完整 `LICENSE`，并保留上游许可证与适用的 MIT 声明。
2. 在源码及随附文档中保留原项目名称 **dsh-ensp**、作者 **lizi600jin** 及仓库地址 **[https://github.com/lizi600jin/dsh-ensp](https://github.com/lizi600jin/dsh-ensp)**；同时保留其他来源的署名与许可。
3. 对外分发基于本项目形成的衍生作品时，遵循 **GPL-3.0-or-later**，并按 GPL 的适用条款向接收者提供对应源码或获取方式。
4. 对修改过的文件作出明确的修改说明并记录相关日期，保留来源与变更记录。

仅自行运行或作不对外分发的私人修改，不触发向他人提供源码的分发义务。以上为项目许可说明，具体权利与义务以 [LICENSE](LICENSE) 全文为准。保留原 MIT 声明用于记录对应代码的原始授权，不表示融合版整体改用 MIT，也不免除 GPL 对衍生作品的适用要求。

### 致谢

感谢 **lizi600jin**、**YunoSeng** 及 ENSPLB 增强实现的贡献者。本项目不包含华为 eNSP 本体、设备镜像或虚拟磁盘；相关软件与素材由使用者自行准备，并遵守各自许可。
