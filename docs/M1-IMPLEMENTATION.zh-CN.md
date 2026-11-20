# M1 失败判定与崩溃取证

2026-11-19。对应 [优化方案](OPTIMIZATION-PLAN.zh-CN.md) 的 W1–W4 首版；代码保留 1.1.3，属于未发布源码增强。本文保留 M1 交付时的范围与验证记录；随后实施的取消能力及 Electron 隔离启动复核见 [M2 交付说明](M2-IMPLEMENTATION.zh-CN.md)，不能由 M1 的软件测试推导后续能力已完成。

## 结果兼容与行为更正

19 个工具名称和原字段保留，外层新增 `ok`（旧工具没有时补充）和 `execution`。fusion 工具原 `data` 继续为字符串，不替换为对象；GUI 原 `outcome` 保留。

公共判定检查已声明结果边界：对象或 JSON 字符串 `data.ok`、CLI 设备/命令/断言/保存、GUI steps、截图捕获、业务验收 rows、inspect 查询及文档结构 verification。未知布尔形式、必需结果缺少判定、格式损坏、跳过和证据不足不能计成功；不解析命令 `output` 里的 JSON。LLDP DIFFERENT/INCONCLUSIVE 和文档结构校验失败会聚合为 `ok:false` 和工具错误。

```javascript
import { assertOperationSucceeded } from 'dsh-ensp-fusion/result'
const result = await tools.ensp_cli(args)
assertOperationSucceeded('ensp_cli', result)
// 业务验收另外核对具体流量、协议和断言，不能以调用成功代替。
```

函数接收工具业务结果；宿主错误信封由入口按契约处理。DSH 失败继续使用 SDK 错误信封，脱敏完整结果位于 content。MCP `isError`、CLI 退出码、验收器使用同一判定。诊断工具成功分析 UNKNOWN 文本不代表网络健康，GUI dispatched 不代表工程加载或持久化通过。

`execution` 包含 schema_version、operation_id、可用时的 call_id、入口、构建指纹、单调耗时、status、验证层级及失败/跳过/未知路径。首条命令回复失败、嵌套传输未确认等情形也保留“可能已生效”；`may_have_applied` 仅是保守提示，不是原生动作事务保证，也不构成回滚或重放授权。未知终态仍需核查。

命令断言与提供的 LLDP 观察使用 `assertion_verification` 和明确的 `verification_scope`，不自动升级为业务通过。services 的 business_verification 仅覆盖本次宿主协议探测，不代表 eNSP 客体、转发或长期稳定性。

## 元信息记录

DSH 配置新增 `diagnosticLogging`（默认 true）、`diagnosticDirectory`（默认空，使用用户 LOCALAPPDATA）。CLI/MCP 可使用：

```powershell
$env:ENSP_FUSION_DIAGNOSTICS_DIR = 'F:/labs/ensp/diagnostics'
# 或关闭本进程的元信息记录：
$env:ENSP_FUSION_DIAGNOSTICS = 'off'
```

默认目录为 `%LOCALAPPDATA%/dsh-ensp-fusion/diagnostics`。每次调用独立 JSONL 文件，单次最多 16 KiB，总预算 128 MiB；已关闭元信息保留 7 天。分配采用跨进程独占锁，容量统计预留活动任务预算，每次分配最多检查 8,192 个目录项；超限保守停止新日志记录，不影响设备动作。未关闭任务与非本功能文件不自动删除。陈旧 allocation.lock 保守地使记录不可用，不自动抢占，需核查活动进程后处理。

与原方案的单文件轮转不同，首版采用每操作独立文件，避免跨进程 JSONL 交错；保留相同总预算和终态保护。超过单次上限时保留结束记录和省略数量。日志目录继承用户目录的 Windows ACL，未显式重写 ACL；自定义共享目录由使用者管理访问权限，不能把 mode:0600 当 Windows 隔离保证。

记录白名单元信息，不默认保存参数、命令正文、配置和认证回复。日志写入失败不改写已确认设备动作，返回 `evidence_persisted:false`；没有证据不能声称完成完整取证。当前阶段事件覆盖 CLI 的校验/命令发送/观察以及主要 GUI 桥批次；其余工具记录调用开始/结束。没有进程创建时间的操作只按时间关联，不伪造进程身份。

## 崩溃报告

```powershell
node bin/ensp-fusion-doctor.mjs incident --from '2026-11-18T22:25:00+08:00' --to '2026-11-18T22:40:00+08:00' --workspace 'F:/labs/ensp' --output 'incident-20261118-2233'
```

可选 `--session <path>`（可重复）、`--native-log-root <eNSP日志根>`、`--pc-log-root <PCServer日志目录>`、`--execution-root <元信息目录>`、`--topology <topo>` 和 `--wer-root <已有WER报告目录>`。不指定会话不会扫描全部 DSH 会话；指定拓扑后只匹配对应 USG UUID 的日志。WER 仅提取可读已有报告的有限字段，不复制 dump、不修改 ACL。

输出新目录：summary.json、timeline.jsonl、sources.json、report.md。已有目录拒绝覆盖，输出必须位于工作区。元信息和会话保留结构化摘要；原生日志摘录经过现有配置文本脱敏，未结构化自由文本仍需人工检查后再分享。

默认最近两小时，最大七天；事件最多 2,000 条（原始 Application 查询超限会注明），文件候选最多 128 个，单日志尾部 256 KiB，文件读取/解压总预算 32 MiB，采集检查预算 20 秒。时间必须为带时区的 ISO8601。时间线最多 10,000 行、操作最多 2,000 个、报告合计最多 16 MiB，超限/缺失/拒绝访问/读取中变化明确标记。当前同步单帧解压受输入/输出字节上限约束，不能承诺原生同步解压可被毫秒级抢占。

PCServer 使用 BOM 识别 UTF-16LE，普通日志严格 UTF-8 后尝试 GB18030。原生本地时间注明未验证，不按执行机器时区偷偷转换为 UTC；因此原生行可留在“时间未知”部分。以文件名日期前后一天选采样候选，报告不是所选分钟内所有原生行的精确统计。事件按通道/RecordId 去重，只有 PID、创建时间、应用完整才合并实例。时间相邻只标 temporal_only，即使同进程也不能证明因果。

采集完成只表示读取能力，不代表无故障。来源不全返回 PARTIAL_EVIDENCE，CLI 退出 1，但仍保留可读部分。完整采集退出 0，即使其中记录了异常，也不会把进程异常当成采集器执行失败；报告中的异常数需要单独解读。

## 安装与宿主核验

完整源码中执行：

```powershell
node scripts/check-installed.mjs --create-manifest 'F:/release/content.json' --source-root 'F:/release/unpacked/package'
node scripts/check-installed.mjs --manifest 'F:/release/content.json' --installed-root 'C:/path/to/installed/dsh-ensp-fusion' --runtime-status 'F:/release/ensp-status.json' --output 'F:/release/install-check.json'
```

清单创建和报告输出拒绝覆盖；父目录需存在。内容清单应从验证后的实际解包目录生成，清单放在包外，避免自引用。对比大小、SHA256、缺失/额外分发文件和既有源代码指纹。默认忽略 node_modules 和未列入分发的开发文件；不作为任意目录的完整性审计。

`--runtime-status` 可省略，省略时只能 INSTALL_VERIFIED_RUNTIME_UNVERIFIED；传入原始 `ensp_status` 工具业务结果后，按 root/fingerprint/loadedAt 核对。M2.1 另要求 observedAt 默认五分钟内、最多五秒未来偏差且不早于加载时间；旧结果没有 observedAt 时为 STALE_OR_UNDATED。该工具信任提供的证据，不会自行连接或认证运行桌面；详见 [M2.1 说明](M2.1-IMPLEMENTATION.zh-CN.md)。

`check:dsh` 自动探测 unpacked resources/app，再尝试 app.asar。`--host-modules` 仍支持实际解包模块，在 Node --expose-internals 下运行时只标记 host-modules。Electron-as-Node 成功也不代表桌面 profile 或实时会话验证成功。候选包完成后才安排切换；不要仅因版本号一致覆盖运行目录。

## 后续与边界

本机验证：339 项 Node 测试、24 项 MCP 冒烟、插件检查和发布静态检查通过。实际 DSH 0.2.2-rc.3 模块在隔离 Node 进程中完成 19 工具、2 技能、原生执行器错误传播及卸载核验；Electron-as-Node 启动返回 EACCES，实时桌面 profile 和运行会话未验证。候选包逐文件 SHA256、离线安装和桌面副本差异结果另存本轮验证产物，不能以包版本均为 1.1.3 推断安装相同。

历史结构化事件重放保留 100 条 Event 1000 / 73 个受影响进程实例的计数，仍不是 73 次已证明的独立终止。真实采集 2026-11-18 22:25–22:40（+08:00）窗口得到 2 条 Event 1000 / 1 个实例；PCServer 活动日志 EBUSY 和省略行使覆盖不完整。显式大体积 DSH 会话在约 4.94 MB 压缩输入、28.49 MB 解码后触发共享 32 MiB 上限，未到窗口尾部；该次零操作不能解释为窗口内没有调用。完整原生根因仍缺崩溃调用栈。

M1 交付时 W5 尚待接线；后续实现与验证见 [M2 交付说明](M2-IMPLEMENTATION.zh-CN.md)。W6 仍需生命周期编排；W7 的并发默认尚未开放。M1 未修改 eNSP、VirtualBox、兼容 DLL 或设备配置，没有自动重启、回滚或配置重放。真实原生根因继续按 [审计报告](CRASH-AUDIT-20261119.zh-CN.md) 取证。
