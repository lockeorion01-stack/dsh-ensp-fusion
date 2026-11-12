# dsh-ensp-fusion

**面向华为 eNSP 的网络实验自动化工具，支持 DSH 插件、MCP 和命令行。**

将拓扑构建、设备配置、协议检查、业务探测和报告取证连接成一套可重复执行的实验流程。适用于网络教学、协议实验、园区方案验证，以及需要通过 AI 客户端调用 eNSP 的开发者。

- **统一调用**：三个入口复用同一组 16 个工具，配套 23 个实验指导和 2 个 DSH 技能。
- **完整流程**：从生成拓扑、配置前探查、下发命令，到等待收敛、执行断言和整理证据。
- **可追溯结果**：支持变更预览、控制台锁、可选快照日志和受保护恢复；验收区分通过、失败、错误和未执行。

当前版本 **1.1.1**，目标宿主 **DSH 0.2.2-rc.1**。本次修复 1.1.0 的旧 SDK 依赖导致的加载拦截，详见 [1.1.1 更新说明](docs/releases/1.1.1.zh-CN.md)和[完整更新日志](CHANGELOG.md)。npm 尚未发布，请按下文使用源码或本地打包安装。

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
| DSH 插件 | DSH **0.2.2-rc.1**；其他宿主版本需另行核验 |
| Node 依赖 | `@deepseek-ai/dsh-tools@0.2.2-rc.1`、`@deepseek-ai/schemastery@3.19.0` |
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

当前版本应显示 `1.1.1`，`tools` 应列出 16 项及其参数 schema。这两条检查命令不会启动 eNSP。

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
dsh plugin --profile desktop add "C:/tools/dsh-ensp-fusion/dsh-ensp-fusion-1.1.1.tgz"
```

替换为实际包路径。首次接入还需按[DSH 配置说明](docs/DEPLOYMENT.zh-CN.md#4-dsh接入)合并 bundle；升级后重新加载插件。若仍提示 1.1.0 不兼容，检查实际加载路径和旧包缓存。不要继续使用旧 `v1.1.0` 标签的安装包。

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

## 16 个统一工具

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

通用构建器支持 **12 种型号**：S5700、S3700、AR2220、AR2240、AR1220、USG5500、USG6000V、AC6005、PC、Client、Server、Cloud。设备名使用 ASCII 标识符。Client/Server 支持原生 Ethernet 及 IPv4/DNS 启动参数；应用服务目录和启动状态需单独恢复、检查。

## 验证结果与已知限制

2026-11-12，1.1.1 的验证结果：

| 层次 | 结果 | 已覆盖范围 |
| --- | --- | --- |
| 软件回归 | PASS | 292 项 Node 测试、24 项 MCP 冒烟 |
| 分发检查 | PASS | 插件检查、离线干净安装、外部目录 CLI、MCP 初始化及发布前检查 |
| DSH 0.2.2-rc.1 宿主服务 | PASS | 兼容性判定、16 工具、2 技能、系统提示、原生执行器和卸载清理 |
| 限定现场业务 | 部分通过 | 原生 HTTP/DNS/FTP、四台 Server 修复副本、USG 分级 UDP 转发样本 |
| 园区业务总验收 | **FAIL** | 冷 ARP、端到端吞吐及指定固件 TCP 隔离仍有失败 |

宿主验证在独立进程调用已安装 DSH 的真实服务，不修改用户 profile，也不覆盖完整桌面模型会话。USG 已测两轮 0.5/2/8 Mbps、1/8/32 UDP 流，入口/出口样本零丢包；外侧终端约 1.94 Mbps 的瓶颈尚未定位。此结果不能推断最大吞吐、TCP 并发或长时间稳定性。

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
| [1.1.1 更新说明](docs/releases/1.1.1.zh-CN.md) / [更新日志](CHANGELOG.md) | 兼容性修复、升级及历史变更 |
| [部署手册](docs/DEPLOYMENT.zh-CN.md) | DSH/MCP/CLI 接入、依赖与排错 |
| [统一验收](docs/ACCEPTANCE-RUNNER.zh-CN.md) / [变更管理](docs/CHANGE-MANAGEMENT.zh-CN.md) | 计划、断言、日志和恢复 |
| [验收摘要](docs/TOTAL-ACCEPTANCE.zh-CN.md) / [已知问题](docs/KNOWN-ISSUES.zh-CN.md) | 成功范围、失败项和未测项 |
| [可靠性修复](docs/RELIABILITY-HARDENING.zh-CN.md) / [模块实现记录](docs/REMAINING-MODULES.zh-CN.md) | 实现与验证过程 |
| [项目对比](docs/GRBJ-COMPARISON.zh-CN.md) / [源码分析](docs/ANALYSIS.zh-CN.md) | 来源分析和能力补齐 |
| [GitHub 发布指南](docs/GITHUB-RELEASE.zh-CN.md) | 提交检查、推送和分发边界 |

## 来源与许可

项目融合 YunoSeng 基础自动化与文档流程、ENSPLB 设备会话和验收增强，以及 lizi600jin 的拓扑与场景模块；在统一入口上补充诊断、链路核对、业务探测及验收恢复能力。来源和变更见 [NOTICE.md](NOTICE.md)。

整体采用 **GPL-3.0-or-later**，保留 MIT 及上游许可声明。详见 [LICENSE](LICENSE)、[LICENSE-MIT](LICENSE-MIT) 和 [上游许可证](upstream/lizi600jin/LICENSE)。
