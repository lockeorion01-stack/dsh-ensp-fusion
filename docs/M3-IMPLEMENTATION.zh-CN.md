# M3 实施记录

更新日期：2026-11-20。已完成静态预检、单台历史只读样本和三项源码修补；未完成 M3 全部现场验收或发布放行。最新软件交付见 [三项修补报告](M3-RELIABILITY-FIXES-20261120.zh-CN.md)。

## 前置状态

A5 固定候选 1.1.3 的实际安装及桌面状态回读已通过；证据保留在 `test-results/m2.1-20261119/deployment-20261119-2205/fixed-readback-20261119T145522Z/`。该结论不代表 M3 生命周期、业务或崩溃根因验收通过。

## 本次已交付

工程为 `F:/AgentDeekseep-Desktop/SkillAdvancement/第六组/06_工程文件/h0engrui-expanded.topo`。27 台设备、35 条连线；结构与端口参数静态检查未发现问题。9 台 S5700 和 3 台 USG6000V 的磁盘配置可识别，但未提供 expected 配置基线，未证明运行生效。

在 `test-results/m3-20261119/project-preflight-20261119T150051Z/project-copy/` 中创建完整相关文件副本，18 个文件、250195 字节逐 SHA256 验证一致。保留空 UUID 目录。原工程未改；副本保留 UUID、端口和外部适配器映射，不能据此宣称 VM/网络隔离或运行态 checkpoint。

本轮详细报告与证据入口：`test-results/m3-20261119/project-preflight-20261119T150051Z/report.zh-CN.md`、`validation-summary.json`、`independent-copy-manifest.json`、`final-preflight-verification.json`。未执行新的状态工具、窗口自动化、设备启停、配置或保存。

## 2026-11-19 发现的修复和验证缺口（历史）

- **磁盘配置适配**：当前检查器把 AC/AP 默认按 flash.efz 检查。AC1 实际有 CRC 可读的 vrpcfg.zip/vrpcfg.cfg，带 `[V200R007C10SPC300]` 版本头；AP3 为空目录，机制待验证。须区分缺失、格式未支持和未知，不能让不支持的型号被误判损坏或通过。
- **副本/备份覆盖**：checkpointProject 文件白名单缺 vrpcfg.zip。需补齐型号适配、完整资产清单、源稳定性与副本哈希回归；不得通过造假 flash 文件绕过。
- **现场工程身份**：先由用户确认当前 eNSP 窗口/活动任务，再打开独立副本并核对路径。原工程与副本不可同时运行。两 Cloud 使用同一真实适配器映射，执行前核对实际范围。
- **型号覆盖**：本工程没有 AR、没有原生 Client；不能以 PC/Server 代替对应型号验收。
- **单设备起步**：工程身份确认后，单独安排 SW-ACC-01（S5700，8307）的就绪观察及只读基线；不以静态预检授权全量启停或配置。

本轮只记录缺口，不改动已验收的安装包。后续源码变更需定向测试并生成新的可追溯候选，再按变更范围执行安装/加载核验。

## 门禁状态

- [x] 首个工程静态预检与独立文件副本。
- [x] AC/AP 配置存储适配及 checkpoint 资产覆盖修复（2026-11-20 源码；AP 实际持久化仍未知）。
- [ ] GUI 活动工程完整路径、身份与任务状态确认。
- [ ] B1/B2 指定设备生命周期、持久化与重开验收。
- [ ] B3 只读并发与资源检查。
- [ ] B4 原生崩溃证据与覆盖缺口收口。

原生崩溃仍缺足够调用栈等根因证据，不能用静态检查或“本轮未发生崩溃”替代定位结论。

## 后续人机协同测试记录（2026-11-19）

本节记录预检之后的新证据，不将前述预检边界改写成运行验收完成。用户确认已打开原准备目录中的 project-copy 副本；该完整路径没有被 GUI 工具独立确认。

- 23:20 状态结果已从用户保存的完整 JSON 与本机操作元数据交叉核对。插件 1.1.3 指纹一致，eNSP 窗口最小化、hung=false；进程扫描仍有 23 项未检查，active_project 为 unknown。所列 27 台设备来自原工程磁盘文件，不证明 GUI 活动工程或设备就绪。
- 第 01 次查询被工作区边界拒绝，第 02 次相对路径查询指向当前工作区中不存在的文件；两次均未发送设备命令。保留原始失败证据，没有解除路径约束。
- 已在当前 DSH 工作区 `F:/AgentDeekseep-Desktop/SkillAdvancement/ensp-plugin-validation-20261119/project-copy/` 内另建文件验证副本，18 个文件、250195 字节及 18 个设备目录与原预检副本一致。只创建目录和文件，没有切换 GUI 工程；UUID、端口和 Cloud 映射继续保留，不证明运行身份隔离。
- 第 03 次 dry_run=true 已通过，SW-ACC-01 正确解析到 8307，计划只有 display version，system_view/save 均为 false，没有连接设备。证据：cli-03-dryrun-assessment.json。
- 第 04 次实际查询在 23:38:27 的 connect 阶段返回 ECONNREFUSED 127.0.0.1:8307，display version 被 skipped，未进入命令阶段，未执行配置保存。该结果不能证明设备已停止或 eNSP 崩溃，也不能计为设备验收通过。
- 用户保存文件只保留通用 ToolCallError 摘要；已从本机 DSH 会话的精确 subCallId 记录恢复完整 structured content，并与操作日志 b7ffe5aa-88de-4859-be13-008cf770905b 核对。后续导出应保留原始错误 content、operation_id、failure.phase/kind/message 与 skipped，而不只保存外层消息。这是证据导出缺口，尚未修改安装包。

上述新增证据均位于 `test-results/m3-20261119/project-preflight-20261119T150051Z/`，第 04 次详见 cli-04-recovered-structured-result.json、cli-04-session-extract.json 与 cli-04-connection-refused-assessment.json。助手未重发设备查询；仅额外被动查看监听表，23:40:36 未见 8307 监听。

第 04 次失败后的启动检查与只读查询已有后续结果，见下一节；不要因这条历史失败记录自动重发命令。B1/B2、B3、B4 的最终现场门禁仍未通过。

## 单台只读样本通过（第 05 次）

已发现并交叉核对用户保存在当前工作区的 ensp-swacc01-readonly-05.json，无需再要求用户重复执行。该返回与本机 DSH 会话精确 subCallId 对应的工具 content 完全一致，操作日志、返回正文和独立转录文件一致。

- 完成时间：2026-11-19 23:44:17（Asia/Shanghai），耗时 381 ms。operation_id：18967104-fb72-43b9-9616-fc83355aa197。
- 请求从当前工作区的 ensp-plugin-validation-20261119/project-copy/h0engrui-expanded.topo 解析 SW-ACC-01，目标 console 为 8307。
- 唯一查询为 display version；提示符为 `<SW-ACC-01>`，回显型号 S5700-28C-HI，VRP 5.110，软件 S5700 V200R001C00。
- 单条命令派发/观察/成功终态完整，无 skipped，无 setupResults；system_view/save/echo_to_window 均为 false，没有执行配置保存或 GUI 回显。
- 助手随后仅被动观察监听表：23:54:23 的 8307 由 eNSP_Client.exe PID 47032 监听；没有新建连接或重发命令。

本结论仅通过单台控制台版本查询样本。未独立确认 GUI 活动工程完整路径或运行 VM UUID；相同名称/端口/UUID 的文件副本不能替代运行工程身份绑定。预期业务配置、保存/重开、并发稳定性及原生崩溃根因仍未通过。

证据位于同一预检目录：cli-05-user-saved-success.json、cli-05-operation.closed.jsonl、cli-05-session-extract.json、cli-05-transcript.txt、cli-05-single-device-success-assessment.json。下一步可按单台范围采集接口/VLAN 只读基线，不重复已完成的版本查询，不扩大到批量启动。

## 2026-11-20 软件修补收口

三项缺口已合并修复并形成 1.1.4 候选：AC1 的版本头 ZIP 内容识别、含非控制台 XML/ZIP 的完整受界资产清单与检查点三方哈希、按操作/调用 ID 导出完整脱敏错误。18 文件/250195 字节复制一致，AP3 仍未知而整体 ok=false。真实压缩会话第 04 次失败正文与原 execution 完整保留，不重放设备操作；旧 1.1.3 安装未覆盖。回归与候选清单见 [修补报告](M3-RELIABILITY-FIXES-20261120.zh-CN.md)。
