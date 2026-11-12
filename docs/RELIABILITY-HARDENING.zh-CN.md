# 严重问题后续完善

> 2026-11-12 总验收更新：下文早期“USG负载未测”“园区Server副本未实测”已由 [最新总验收说明](TOTAL-ACCEPTANCE.zh-CN.md) 更新；冷ARP丢包和S5700 TCP拒绝仍失败。整体业务总验收为FAIL。

本轮修复验收误判和中断后的可恢复性，增强原生服务恢复前校验。第三方 PC 间歇丢包、S5700 指定固件的 TCP ACL 业务拒绝失败仍未解决，不能宣称全部严重问题已修复。

## 业务判定

`ensp-fusion-accept assess evidence.json` 是只读证据评估入口，退出码只有 PASS 为 0；FAIL 和 INCONCLUSIVE 均为 1。它评估提供的记录，不验证记录真实性，也不生成新流量。

稳定性证据格式为 `version:1, kind:"stability", samples:[...]`。每轮必须有 `completed:true`、`transmitted`、`received`、`loss_percent`。按完整数字核对数量及百分比，任何有效丢包轮次保留为 FAIL，不能因最后重试成功而通过；缺失或矛盾数据为 INCONCLUSIVE。可用 `criteria:{rounds:120,packets_per_round:3}` 明确验收采样数，轮次或每轮包数不足时不得通过；未声明时只评估已提交样本。初次、冷启动、空闲样本不得在汇总前删除。

隔离证据格式为 `version:1, kind:"isolation"`，包含：

- `flow`：`source`、`target`、`protocol`（http/tcp）、`port`。
- `baseline`、`restricted`、`restored`：非空观察数组；每项包含同一 flow、`completed` 和 `reached`。
- 每个 restricted 观察必须有非空 `window`，以及同窗口的 `control`：不同授权源访问相同目标、协议和端口成功。
- `denial`：同一 flow、非空 `rule`、覆盖所有 restricted 观察窗口的 `windows` 数组、非负整数 `before`/`after` 拒绝计数且递增、原始 `evidence` 路径。计数证据必须来自受控测试窗口，其他流量共享规则时应单独取证。

restricted 中出现可达即 FAIL；仅配置成功、服务器停机、无健康授权对照、只有超时或缺少匹配拒绝证据均不能 PASS。该判定仅适用于记录中的流，不能推广到全部协议或型号。

`ensp_inspect` 的兼容信息现返回 S5700 VRP5.110/V200R001C00 的 `observed_failures`，明确这组实验发生过二层 TCP ACL 配置接受但 HTTP 可达。它不是“所有 S5700 都不支持 ACL”的结论，也不阻止用户在其他明确支持的场景配置 ACL。

统一验收器同时修复对象形式 `data.ok:false` 被外层 `ok:true` 遮蔽的误判。

## 验收中断后的清理

新运行在外部动作之前，将已登记清理项及原计划 SHA256 写入 summary 并 fsync 后替换。计划及产物仍脱敏，恢复所需认证从用户持有的原计划重新读取，不从脱敏文本猜测。

```powershell
ensp-fusion-accept status <run-directory>
ensp-fusion-accept recover <run-directory> <original-plan.json> <workspace>
```

恢复只执行原计划中尚未成功的 cleanup，按反序执行，不重放原业务动作。cleanup 必须使用 `ensp_cli` 的 `recover_from`，例如其值为 `${steps.change.change_journal}`。不得带目标或命令覆盖，也不得 `save:true`。现场身份和变更后配置指纹由既有恢复 guard 在控制台锁内核对。

恢复前校验原计划哈希、原任务是否仍活动、清理台账及所有所需引用。任一日志缺失或不完整、旧运行没有台账、guard 拒绝，均不绕过。重复步骤以后一次为准：即使后一次缺失结果或 evidence 字段，也清除前一次上下文，不使用旧 journal 恢复。证据文件 realpath 必须位于运行目录内。多个清理项中一项恢复失败立即停止，避免继续恢复较早状态。已成功的清理不重复执行。

恢复结果写入独立 `cleanup-recovery.json` 和 UUID 结果文件；原 summary、原失败结论及证据不改写。status 同时显示原结论与清理恢复结果；RECOVERED 仅指清理完成，不表示原验收通过。

并发恢复由独占 `cleanup-recovery.lock` 阻止。若恢复进程也遭强杀而残留锁，应先核对该锁 PID、设备现状及恢复证据，再人工处理锁；无强制跳过入口。原业务进程在“已变更但尚未返回完整 journal”之间被杀时，可能无法自动恢复，必须人工核查。文件 fsync 不能承诺所有硬件断电情形下的持久性。

本轮测试实际创建并强杀子进程，再检查台账和受保护恢复调度；设备 guard 已有独立实机证据。本轮没有对企业设备实施强杀中断实验。

## 原生服务恢复

```powershell
ensp-fusion-accept services-check <service-manifest.json> <topology.topo> <workspace>
```

该命令仅预检，输出 `PREFLIGHT_ONLY`、`business_verified:false`。核验唯一 Server/Client、服务端 IP、客户端 DNS、服务端指定 DNS 记录、HTTP/FTP 默认端口、实际文件 SHA256、目录及文件 realpath 工作区边界。拒绝缺失/修改内容和符号链接越界后，才能操作 GUI。

实验项目 `priority-rig-helpers.mjs` 的服务恢复已接入此预检，并明确启动操作本身未完成业务验证。库函数 `recoverNativeServices` 支持调用者提供 GUI 激活和客体协议探测回调；只有来自指定 Client 到指定目标的 HTTP200 正文哈希、指定 DNS 查询应答、FTP226 与下载哈希全部匹配才返回 RECOVERED。回调整体必须 `ok:true`，http/dns/ftp 三项各自必须 `ok:true,completed:true`；错误、缺失或未完成结果不会通过。Server/Client 名称须在整个库存中唯一，IP/DNS 参数缺失或重复时拒绝操作。

这里增加的是可供编排调用的恢复组件，没有实现 Windows 开机服务或后台驻留监控，也没有改变 eNSP 原生服务自动启动能力。真正无人值守重启恢复仍需接入明确的本地启动编排，交互桌面不可用时应报错。

## 现场与限制

本轮对企业现场只执行查询和真实 PC Ping，未修改配置、静态 ARP、服务状态或拓扑。三台设备查询成功，PC 三轮合计 15/14，稳定性仍为 FAIL。证据在同级实验项目 `test-results/serious-followup-*`。其中首个目录保留脚本参数错误导致的未完成采样，后续独立目录保存完整结果。

以上为此前现场状态。2026-11-12 后续切换验收结束后，应以同级实验项目 `docs/REMAINING-LIVE-20261112.zh-CN.md` 的恢复记录为准。原始 ACL 与 PC 失败不被软件回归通过替代。

## 后续实机修复（2026-11-12）

- GUI 的 `start_all` / `stop_all` 尊重显式 `hwnd`，不再静默选择其他主窗口；整批输入先验证句柄。
- 新增 `select_list`，标准单选 ListBox 使用原生选择消息、父窗口选择通知并复核结果。可指定唯一 `text` 或零基 `index`；自绘且无字符串的控件拒绝按文本查找，使用 `index` 时可用 `expected_count` 核对布局。实验 Server 为3项、Client为2项，选择后继续检查业务页面控件，再以真实协议判断恢复结果；不依赖全局 Home/Down/End 按键。
- USG 配置指纹排除严格匹配的独立控制台日期时间行；仍检测实际配置变化。实机临时 deny 后 `recover_from` 的身份和配置 guard 已通过，恢复配置与原配置一致；业务恢复首轮4/5，完整验收仍失败。
- 新增只读 `ensp-fusion-accept usg-health <resource-samples-and-limits.json>`。输入包含非空 `samples`（每项 `cpu` / `memory` / `sessions` 原始文本）及显式 `limits`（`min_samples` 与 CPU、管理面/设备/动态内存百分比上限）。输出分别列出当前 CPU、历史最高 CPU、各内存面与会话数。资源 PASS 也始终 `performance_accepted:false`；不完整采样为 INCONCLUSIVE，超限为 FAIL，两者退出码1。它不生成流量，也不能证明吞吐或最大容量。

本轮采样当前 CPU15.5%/17.7%，历史最高100%，管理面内存63%，设备内存71%/73%，动态内存79%/82%；资源健康通过本轮显式诊断阈值，吞吐、并发、高负载与长时间稳定性未完成。原生 HTTP/DNS/FTP 恢复已在独立验收台复验，并保留两次控件适配失败证据；不承诺 Windows 开机无人值守恢复。

恢复用户指定的园区磁盘版本时，另发现4个 Server 含 `-eth -ipaddr -ipaddr` 等缺值、重复参数；原生辅助进程报运行库错误，Windows事件指向 `eNSP_UDP_Plugin.dll`。参数损坏已确认，但 DLL 异常因果及修复效果尚未复验。新增原生参数预检，在 GUI 打开拓扑、启动设备及原生窗口操作之前拒绝已知缺值、重复参数和非法 IP/MAC/前缀；停止现有设备、只读取证仍可进行。写拓扑和编辑 IPv4 也拒绝传播损坏参数。通用 `spawn` 不解析任意命令行，不能将该入口当作受保护的拓扑打开操作。

原磁盘文件未修改，22台设备已恢复停机；4个错误弹窗已关闭。另生成4个 Server 参数的修复副本，仅通过静态预检，未打开此副本验证原生运行，因此不能声称园区 Server 故障已修复。副本及完整证据位置见实验项目 `docs/REMAINING-LIVE-20261112.zh-CN.md`。
