# eNSP 实验自动化项目基底（权威工作底稿）

版本：1.0　维护日期：2026-11-23　适用范围：当前 dsh-ensp-test 工作区内的 eNSP 网络实验自动化与 72h 诊断采集

> 本文用于给后续开发、实验、报告提供一致的事实底座。它区分已观测事实、当前实现、已验证范围与待验证事项；不把短跑推断成长期稳定性结论。

## 1. 项目定位

本项目以 dsh-ensp-fusion / dsh-ensp 工具链自动化华为 eNSP 拓扑实验，当前覆盖拓扑资产、VRP console 操作、连通性与设备资源诊断、结构化证据及报告。

定位分层：
- **已可用**：读取/构建拓扑、通过 console 执行 VRP 命令、重复 ping 与资源采样、记录命令及结构化执行证据、按状态与证据形成阶段报告。
- **当前质量等级**：适合受控环境与有人看护的实验辅助；本次证据不支持“正式 72h 无人值守稳定性已通过”。
- **完整验收边界**：72h 诊断采集不等于业务验收。guest HTTP/DNS/FTP、应用级 UDP 接收计量与持续吞吐、TCP 并发、冷加载、无人值守重启恢复均需单独设计和验证。

## 2. 环境与资产基线

| 项目 | 当前已观测值 | 备注 |
|---|---|---|
| 工作区 | F:/AgentProject_EXP/dsh-Network/dsh-ensp-test | 实验产物与脚本均位于该工作区 |
| eNSP | 1.2.0.500 | 主窗口可最小化；console 操作不依赖窗口前置 |
| dsh-ensp-fusion | 1.1.6 | 以本次状态工具返回的构建信息为准 |
| 拓扑 | lab/validation-20261121-201439/project-copy/h0engrui-expanded.topo | 本次诊断使用的拓扑副本 |
| 观测点 | SW-CORE-01（S5700 / VRP 5.110） | ping 到 10.20.30.2 与 10.20.91.2 |
| 资源设备 | FW-01、FW-02、FW-CW-01（USG） | 每 5 分钟采集 CPU、内存、会话表 |
| console | SW-CORE-01 8304；FW-01 8302；FW-02 8303；FW-CW-01 8306 | 端口来源应以当前拓扑和现场验证为准 |
| 凭据 | 工作区私有凭据文件 | 路径、ref 与明文均不得进入普通报告；此次 3 分钟样本证明 FW-01 登录成功 |

上述是本次实验快照，不代表所有机器和所有拓扑的永久配置。操作前仍需用 ensp_status / ensp_topo / ensp_cli 重新确认运行时状态。

## 3. 运行架构与责任边界

当前诊断链：
1. `diagnostic-supervisor.py` 建立运行目录、锁文件、manifest 和 child config；按真实单调时钟每 60 秒派发一个 worker；采集结束时生成窗口报告、restoration、state 与 heartbeat。
2. `diagnostic-slot-worker.mjs` 采集主机/进程身份、两条 ping；每 5 个槽访问三台 USG 读取资源；每个槽将输出写入独立证据目录。
3. dsh-ensp-fusion 提供 `ensp_cli` 等执行层；负责 console 连接、设备命令传输、执行状态和证据。
4. 上层 worker/supervisor 决定样本有效性、错误处理、继续/停止策略和窗口覆盖率。
5. 报告层根据 `state.json`、`stability-*.json`、`events.jsonl`、`business.jsonl`、`resources.jsonl` 等证据汇总，不以“工具没有抛异常”作为成功依据。

归因原则：设备命令传输和执行状态属于插件/传输层证据；采样周期、重试、soft skip、是否停全轮属于本项目 worker/supervisor 策略；测试期间人工打开同一 console 属于操作干扰。问题报告必须标明所属层，不可将其中一层的问题泛化为插件整体故障。

## 4. 本次长测与后续短跑的权威结论

### 4.1 主诊断运行

运行目录：`diagnostic-72h-20261122T133843Z`。模式 `diagnostic_72h`；启动于 2026-11-22 21:38:43 +08；于 2026-11-23 11:08:59 +08 终止。实际 48,616 秒（13h30m16s），state 终态 `INTERRUPTED`，不是 72h 完成。

- 业务样本 811 条（slot 0–810），有效 810；一条 slot 806 的异常与人工 telnet 访问 SW-CORE-01 console 时间重叠，属于明确的测试干扰关联，但因果证据是时间相关而非完全隔离复现。
- 资源样本 163 条，其中 162 条有效；slot 810 对 FW-01 的 connect 阶段 10 秒超时触发 unconfirmed/stop_collection，监督器按当时策略停止。slot 810 的两条 ping 本身 PASS。
- 窗口覆盖：24h 56.25%，72h 18.75%；business_gaps / failures / resource_failures 为空，不表示 72h 已覆盖，只表示已观测部分未记录对应类别的间隙/失败。
- restoration.json 记录本次诊断没有设备配置、主机设置、生命周期或流量发生器变更。
- 已确认的缺项：guest HTTP/DNS/FTP 未运行；无应用级 UDP 接收计量与持续吞吐标定；无 TCP 并发测试；VIP Initialize / WAN down 已知基线问题保留；未做冷加载和无人值守重启恢复。

### 4.2 加固后短跑

- 3 分钟 smoke 运行达到 `COMPLETED_DIAGNOSTIC_DURATION`，3 个业务样本、1 个资源周期，样本所含三台资源结果 PASS，事件无 violation。它验证基本启动、调用、短时计时与收尾路径。
- 30 分钟短跑于约 236 秒后，由用户要求通过 STOP.request 正常停止；4 个业务样本全 PASS，1 个资源周期的三台设备 PASS，0 violation。它不是 30 分钟完整测试，不验证 30 分钟稳定性。
- 正式 72 小时运行没有启动。当前结论是“短时冒烟路径正常”，而非“加固已证明可支撑 72h”。

### 4.3 对先前报告的校正

以下表述不应再作为权威事实引用：
- “两次短跑验证可行/30 分钟短跑完成”：更正为 3 分钟 smoke 完成；30 分钟任务约 236 秒时按用户请求中止。
- “加固后可支撑正式 72h”：证据不足；仅短时基本路径通过。
- “所有设备全程无重启”：现有 uptime 证据只支持被检查设备/检查时点；不能外推到每个设备、全程。
- “资源 CPU 全程区间已完整确认”：此前给出的区间源于有限采样摘要，尚未对 162 个资源记录全量独立重算；除明确样本外应写“待全量复核”。
- “slot 806 已证实完全由人工连接导致”：关联性强，但需隔离重放才能证明排他因果；正式复盘用“与人工 console 访问时间重合，疑似/高度相关干扰”。
- “business_gaps=[] 因而无任何采样缺失”：不正确。必须结合 planned、actual、valid、elapsed 和 coverage 判断窗口完整度。

## 5. 当前脚本变更基线（待代码审查）

已对原始 worker/supervisor 做过备份并修改：
- `diagnostic-slot-worker.mjs`：ensp_cli 单次 command_timeout_ms 上限由 10s 提至 25s；connect 阶段或全 display 命令的 unconfirmed 被标成 soft；资源访问前使用本机 console TCP 探测（最多 3 次、每次 2s，间隔 1.5s），端口不通时跳过单设备资源槽。
- `diagnostic-supervisor.py`：TOTAL 可从 config.duration_seconds 覆盖；soft_readonly / soft_skip child_issue 不计 violation。
- 修改前副本：两份 `.bak-20261123T0715Z` 文件。语法检查通过。

**待审查的工程风险**：
1. `read_only` / `command_effects` 当前主要是采集器事件标签，未必改变插件底层对未确认的语义；必须核实它是否真正避免潜在副作用误判。
2. connect phase 不等于每种命令都只读；当前脚本用“全 display 命令”或 connect 阶段分类。后续应建立命令 allowlist / operation class，不应只靠字符串前缀判断安全性或恢复方式。
3. TCP connect 探活只证明端口 accept 连接，不能证明 console 的用户名/口令、VRP 提示符或命令通道健康；应将它记为 transport preflight，而非设备 ready。
4. 单设备资源跳过会改变资源样本完整性。窗口报告必须将 SKIP/INCONCLUSIVE 计入 coverage，禁止当作完整资源轮。
5. 当前 report() 的有效资源判定和 coverage 需审查是否把软跳过算作无效；确认分母、分子和状态优先级一致。
6. `TOTAL` 可配置，但 heartbeat 的 slot 范围保护仍固定为 4320；若将来配置更长短跑/其他窗口，应统一从 manifest 读取边界。
7. worker 使用 25s 工具超时，但单槽 deadline 为 50s、全 worker abort 49s；需做预算分析，确保多设备串行时不会超时后留下不可确认的子操作。
8. `finally` 生成的 24h/72h 窗口在人工 stop 或异常时都存在；消费者必须检查 `window_completed` 和 `status`，不能仅凭文件存在判成功。

## 6. 数据语义与验收规则

- `PASS`：命令执行成功且结果解析满足预期。
- `FAIL`：已执行且观测值明确违反门槛；不能将连接错误折叠成业务 FAIL。
- `ERROR`：调用、提示符身份、协议或解析异常；应保存结构化错误和原始证据。
- `INCONCLUSIVE`：工具/设备/证据状态不足以得出 PASS 或 FAIL。
- `SKIP`：按明确策略跳过；必须进入 coverage 分母说明，不可计 PASS。
- `unconfirmed`：执行效果未知；保持为独立状态，不能自动重放可能改变配置的命令。只读性应来自经过审查的命令分类。
- 运行成功：只表示计划时长真实达到且监督器完成收尾。
- 稳定性通过：还需覆盖率达到明确阈值、无超限 gap、无未处理失败、目标范围完整。
- 完整业务验收：还需所有预先声明的服务/吞吐/并发/恢复等验收项具备证据。

建议统一窗口验收条件：terminal=COMPLETED_DIAGNOSTIC_DURATION；window_completed=true；业务与资源 coverage 分别达到事先约定门槛；gap 规则明确；FAIL/ERROR/INCONCLUSIVE/SKIP 分开统计；每个例外具备可定位 evidence_refs；所有设备身份与拓扑版本一致。任何条件未满足，输出 INCOMPLETE / INCONCLUSIVE，不以“无失败记录”推导通过。

## 7. 标准操作流程

### 启动前
1. 以 ensp_status 确认当前 eNSP 实例、拓扑、端口与设备状态；以 ensp_topo 列设备清单。
2. 确认私有凭据文件存在、ref 命名正确；不把明文凭据写入命令日志、普通报告或版本库。
3. 保存目标配置快照；确认设备存储状态和拓扑副本；所有正式采集使用独立新目录。
4. 运行 read-only preflight：console prompt / display version / 目标 ping / USG 三项资源查询；确认设备和证据身份匹配。
5. 生成 manifest，明确目的、范围、采样周期、阈值、计划时长、允许的恢复策略与停止条件。
6. 先跑短 smoke，再跑至少 30 分钟 soak；在短测中注入可控的 console timeout / 端口拒绝 / worker 错误，检查是否只影响目标样本且记录完整。

### 运行中
1. 不人工登录采集所用 console；所有状态观察优先读取 heartbeat、events、business、resources。
2. 不用 GUI 点击或额外 CLI 操作抢占设备；确需操作时先明确暂停采集并记录干扰时间。
3. 监控 heartbeat 新鲜度、进程身份、child 超时、missed_slots、clock drift、窗口 coverage 和资源阈值。
4. 按风险分级：端口暂时不可达 → 有限重试并记录；认证/提示符错误 → 该设备标记 INCONCLUSIVE；可能改变配置的 unconfirmed → 停止该命令通道、不得重放；主机身份变化/设备重启/内存 stop line → 停止整轮并留完整证据。
5. 停止一律使用 STOP.request 或经过验证的 graceful stop；不强杀未知状态的子进程。

### 收尾
1. 检查 supervisor/job、worker/child 进程状态；确认都已终止或给出具体仍运行 PID。
2. 检查最终 state、heartbeat、restoration 与稳定性窗口；确认 terminal / window_completed / sample totals。
3. 全量聚合 JSONL，重新计算有效数、各状态计数、最大 gap、CPU/内存区间和异常时间线；所有统计注明分母与排除样本。
4. 输出诊断报告与验收报告两种口径：诊断报告可呈现观测事实；验收报告逐项对照预注册标准。
5. 保留原始证据和脚本备份；不删除失败或中断记录；版本变更通过差异与回归测试证明。

## 8. 分阶段成熟路线

| 阶段 | 目标 | 验收证据 | 当前 |
|---|---|---|---|
| P0 可复现基线 | 固定拓扑、插件版本、设备身份、凭据引用、配置快照 | preflight JSON + manifest + 配置基线 | 部分具备 |
| P1 单槽鲁棒性 | 连接超时、认证失败、命令错误、设备离线均分类正确 | 合成故障测试，每类各至少 3 次，结果不串类、不误报 | 待做 |
| P2 短 soak | 连续 ≥30 min，按预设 coverage，端口/console 异常不导致静默丢样 | 逐槽计数、错误注入、coverage 报告 | 用户主动停止在约 4 min，未完成 |
| P3 24h 长稳 | 24h 真正跑满，coverage ≥99%，无未解释 >120s gap，无未处理异常 | stability-24h.json + 全量重算 + restore 检查 | 未完成（主跑覆盖 56.25%） |
| P4 72h 长稳 | 72h 真正跑满，coverage ≥99%，恢复/停机策略符合声明 | stability-72h.json + 重启/故障演练 + 证据审阅 | 未启动 |
| P5 完整业务验收 | HTTP/DNS/FTP、UDP 应用接收、TCP 并发、冷加载、服务恢复 | 各项独立 acceptance plan 与证据 | 未完成 |

## 9. 项目文件索引

- 原始长测：lab/validation-20261121-201439/full-runs/20261122-183520-46a9a593/followup-20261122-1919/diagnostic-72h-20261122T133843Z/
- 加固后 3 分钟 smoke：同目录 diagnostic-smoke-20261123T0720Z/
- 被用户停止的 30 分钟短跑：同目录 diagnostic-30min-20261123T0720Z/（约 236s）
- worker / supervisor：同目录 diagnostic-slot-worker.mjs 与 diagnostic-supervisor.py
- 修改前备份：对应 .bak-20261123T0715Z 文件
- 测试详细汇总：同目录 TEST-SUMMARY-20261123.zh-CN.md（请结合本基底对其过强结论作校正）
- 接续与操作说明：同目录 RESUME.zh-CN.md、SCRIPTS-USAGE.zh-CN.md
- 旧诊断中断证据：state.json、stability-24h.json、stability-72h.json、events.jsonl、business.jsonl、resources.jsonl、restoration.json，以及 child-slot-0810/ 下证据。

## 10. 后续默认交付格式

每次测试结果至少报告：一句话结论；计划/实际时长与 coverage 分母；PASS/FAIL/ERROR/INCONCLUSIVE/SKIP 分布；最大 gap；故障时间线与层级归属；资源范围及数据完整性；是否完成恢复/保存；范围外缺项；可点击证据索引；结论强度（observed / inferred / not verified）。

### 用语约束
- 只把文件或 runtime 明确证明的事实写为 observed。
- 关联性未隔离验证时写“与……同时发生/高度相关”，不要写“根因已证实”。
- 短测完成写“短时链路验证通过”，不要写“长稳通过”。
- 文件存在不等于窗口完成；进程存在不等于设备服务就绪；TCP 端口可连不等于 VRP prompt 可用。
- 数据缺失、跳过、错误和明确失败分别陈述。

---
本文是当前项目底座，不替代具体实验的现场状态核查。每次运行开始时以实时状态与原始证据更新本文引用的“当前基线”；若证据与此文冲突，以新鲜 runtime/证据为准，并记录修正。
