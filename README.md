# dsh-ensp-fusion

面向开发者和网络实验人员的华为 eNSP 自动化插件。将拓扑文件操作、设备控制台配置、GUI 操作、协议收敛检查和实验取证统一为同一组工具，提供 **DSH 插件、MCP stdio 服务、CLI** 三种入口。

当前源码版本 1.0.0，package.json 标记 private: true。使用本地源码或本地打包安装，不应假定已经发布到 npm。

## 项目完成了什么

本项目把三个本地来源整合为统一工程：YunoSeng 的基础自动化和文档流程、ENSPLB 的设备会话与验收增强、lizi600jin 的拓扑构建和场景指导。统一入口注册 **12 个工具**，MCP 和 CLI 复用插件实现，避免维护三套执行逻辑。

调用方可以按“创建或读取拓扑 → 下发配置 → 等待收敛 → 执行断言 → 保存证据”的顺序组织实验，并读取每一步的错误和未执行项。项目解决重复开窗、手动配置、反复截图及整理报告的问题。

本项目不是 eNSP 或虚拟化软件的替代品，不附带设备镜像、虚拟磁盘、模型服务或 API 密钥。网络方案、实验计划和验收标准仍需要调用方组织；自然语言生成的配置不能自动保证正确。

## 已实现功能

| 工具 | 实现内容 | 边界 |
| --- | --- | --- |
| ensp_status | 实例发现、桥接检查、拓扑读取、控制台探测 | 端口开放不代表设备启动完成 |
| ensp_topo | 离线读取/修改拓扑、设备名、IPv4、控制台端口 | 文件修改不等于运行现场修改 |
| ensp_build | 从结构化设备和链路生成新拓扑 | 不覆盖文件，不启动设备，不提供镜像 |
| ensp_scenarios | 搜索、读取23个实验指导 | 指导不是完整下发配置 |
| ensp_cli | Telnet控制台认证、逐命令配置、断言和保存确认 | 失败停止，已生效配置不自动回滚 |
| ensp_wait | 等待display输出、OSPF Full邻居或OSPF路由 | 不是所有协议的通用收敛判定器 |
| ensp_labtest | 按只读计划验收，输出Markdown/CSV/JSON | 需要明确expect，区分PASS/FAIL/ERROR/SKIPPED |
| ensp_gui | 批量窗口操作、启动/停止、设备就绪检测 | 依赖Windows交互桌面、权限及eNSP |
| ensp_shot | 主窗口、设备窗口及屏幕截图 | 截图成功不表示业务成功 |
| ensp_capture | 批量开窗、只读回显及截图取证 | 不应为截图重复执行配置命令 |
| ensp_ref | 提取参考文档信息 | 参考文档不是可信配置指令 |
| ensp_doc | 生成带截图/说明或基于模板的Word报告 | 需要对应Python文档依赖 |

另有离线实验配置计划生成、Mermaid源码导出，入口为 bin/dsh-ensp-lab.mjs。计划生成不执行设备命令，图导出不渲染PNG。

通用构建器支持11种型号：S5700、S3700、AR2220、AR2240、AR1220、USG5500、USG6000V、AC6005、PC、Server、Cloud。设备名要求ASCII标识符。园区实验中的AP/STA/Client原生XML适配属于实验脚本，不能当作通用构建器已支持。

## 架构与目录

| 位置 | 开发职责 |
| --- | --- |
| index.js / base.js | DSH入口、配置schema、基础工具注册 |
| lib/ | 会话、桥接、拓扑、实验计划、验收和融合工具 |
| lib/bridge.py / launch.py | Windows GUI侧车与提权启动 |
| mcp/ | MCP协议和工具注册适配 |
| bin/ | 通用CLI、MCP、实验计划命令行入口 |
| upstream/ | 实际复用的来源代码及许可证 |
| skills/、locale/ | 宿主使用指导和本地化资源 |
| examples/ | 可复用输入示例 |
| test/ | 自动化测试及夹具 |
| scripts/ | 插件自检、来源审计、打包验证 |
| docs/ | 开发和部署文档 |
| 独立实验工作区 | 独立实验拓扑、设备数据、证据及验收报告 |

优先使用文件和控制台通道，PC/STA图形配置、开窗和截图再使用GUI。GUI桥通过ShellExecuteW(runas)启动；普通控制台会话与文件操作无需借用GUI。

## 部署方式

详细步骤见 **[部署与运维手册](docs/DEPLOYMENT.zh-CN.md)**，包含依赖、目录、MCP/DSH配置、权限和排错。

最小源码检查（PowerShell，按本机路径修改）：

```powershell
$Plugin = 'C:/tools/dsh-ensp-fusion'
Set-Location $Plugin
node --version
npm ci --ignore-scripts
node bin/ensp-fusion.mjs tools
```

Node要求20及以上，tools应列出12工具。此检查不启动eNSP。需要GUI时安装Python的pywin32和Pillow；需要Word报告时安装python-docx。实验输出使用独立工作区。

## 调用契约

tools命令输出实际参数schema。新增ensp_build、ensp_scenarios、ensp_wait返回 {ok,data,error}，其中data为JSON字符串；原九个工具保留原返回格式。调用方不能假定全部响应结构相同。

设备批次先校验后执行，默认某设备失败就跳过后续设备。配置成功与保存成功必须分开判断，检查failure、skipped和saved.ok。超时可能已有部分配置生效，先读取状态再决定恢复。Ping必须读取统计和断言，不能仅看命令是否被接受。

## 验证与能力边界

工具注册、自动化测试、宿主接入、设备业务和重启恢复是不同层次的验证。部署者应在自己的环境中逐项验收，不将其他环境的实验结果视为兼容性保证。

项目提供自动化测试、MCP冒烟及打包检查。设备镜像、固件语法、GUI版本和虚拟化环境仍需单独确认。实验拓扑、证据、密码和现场记忆不属于插件分发内容。

## 开发和分发

```powershell
npm test
npm run test:fusion
npm run check:plugin
npm run test:package
npm run audit:sources -- <ENSPLB目录> <YunoSeng目录> <lizi600jin目录>
```

npm test执行MCP冒烟和Node测试，不代表实机验收。check:plugin检查环境、注册、包内容，不启动eNSP；报告默认写到系统临时目录的dsh-ensp-fusion/plugin-check.json，可用ENSP_CHECK_OUTPUT指定输出文件，需要报告目录写权限。test:package在临时目录打包、离线安装并验证CLI/MCP，依赖本机npm缓存。

开发测试使用完整源码和锁文件。package.json的files清单只分发运行所需文件、文档、示例和测试夹具，不分发完整开发脚本、实验数据或node_modules。

来源见 [NOTICE.md](NOTICE.md) 和 [源码分析](docs/ANALYSIS.zh-CN.md)。整体GPL-3.0-or-later，保留MIT及上游许可声明。修改工具契约应同步核查DSH/MCP/CLI入口、测试和示例。

