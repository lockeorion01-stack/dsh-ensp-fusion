# 优先改进与变更管理

## 1. 结果状态

`ensp_inspect` 的任一采集命令失败或采集未完成时，外层 `ok:false`；完整的部分结果仍保留在 JSON 字符串 `data` 中。`ensp_wait` 未收敛或认证失败时也保留结构化尝试次数、输出、耗时和错误。MCP 对应 `isError:true`，命令行退出码为 1，DSH 读取同一个结果。

离线 LLDP 的 DIFFERENT / INCONCLUSIVE 和诊断工具的 FINDINGS / UNKNOWN 仍是分析结论，调用本身可成功；不能把调用成功解释为网络健康。

## 2. 控制台互斥

所有 `VrpSession` 会话在连接前按主机和端口获取跨进程锁，持有至关闭会话。CLI、采集、就绪及收敛探测共用此入口。同端口第二个会话立即失败，错误类型为 `device_busy`，不会排队后悄悄下发。不同端口可同时运行。localhost、IPv4 回环和 ::1 归一为同一锁域。

锁保存在系统临时目录 `ensp-fusion-device-locks`。所有者进程已不存在时，可回收旧锁；不会仅按超时删除活进程的锁。PID 复用会保守报忙。锁只协调使用此实现且共享同一临时目录的客户端，不能阻止第三方 Telnet 或 eNSP GUI 输入。远程主机别名未做 DNS 归一。

普通进程崩溃后的锁可自动回收。若进程恰好在回收旧锁时崩溃，可能遗留 `.reclaim` 文件并保守报忙；应停止相关客户端，核对锁内 PID 后清理对应记录，不能在其他会话运行时清空目录。

## 3. 预览、快照、记录与恢复

沿用 `ensp_cli` 工具。1.1.0增加服务验收工具后总数为16，变更管理参数保持兼容。`change_dir` 为显式启用参数；未提供时保持原有执行流程，不自动增加配置采集。推荐正式配置任务都提供该参数。

先预览（无设备连接、无日志写入）：

```json
{
  "port": 2000,
  "commands": ["interface GigabitEthernet0/0/0", "description acceptance-test", "return"],
  "system_view": true,
  "save": false,
  "change_dir": "changes",
  "recovery_commands": ["interface GigabitEthernet0/0/0", "undo description", "return"],
  "dry_run": true
}
```

恢复命令必须根据原有配置编写；示例仅适用于接口原本没有 description 的情况。预览校验命令结构、目标、恢复计划和工作区边界，不验证设备是否支持命令或业务效果。执行时去掉 `dry_run` 或设为 false。`devices[]` 中也可分别提供 `recovery_commands`，`change_dir` 应放在顶层，对整批生效。认证信息仍按原有参数提供。

每台设备生成独立目录，返回 `change_journal` 指向 `manifest.json`：

- `manifest.json`：版本、PID、目标、计划命令、显式恢复命令及原记录关联。
- `before.txt` / `after.txt`：执行前后经过脱敏的运行配置；采集时仍持有设备锁。
- `events.jsonl`：执行阶段、命令发送前后的进度、保存开始/最终结果、配置行增删摘要。每次写入执行 fsync；发送前日志写失败则不发送对应命令。

执行前快照被拒绝或为空，会阻断计划命令。执行中失败停止后续命令，记录已完成、失败和跳过项；连接仍可用时采集后快照。连接丢失、日志写失败或进程中断时，证据可能不完整，不能推断设备配置没有改变。行增删摘要忽略行序与重复次数，仅用于人工审阅，不是可执行配置补丁。

检索已有变更（不连接设备）：

```json
{"list_changes":"changes"}
```

状态为 `completed`、`failed`、`interrupted`、`active-or-unfinished` 或 `unreadable`。没有结束记录且所有者进程仍在时，恢复入口拒绝执行；PID 存活不能证明任务仍在运行，需检查持有该任务的客户端。

先检查原记录、快照、当前设备和显式恢复命令，再预览恢复：

```json
{"recover_from":"changes/<记录目录>/manifest.json","dry_run":true}
```

去掉 `dry_run` 即执行恢复。目标端口和命令从记录读取，不能通过 `port`、`device`、`commands` 或 `devices` 覆盖；凭据必须重新提供。恢复也产生新日志并关联原记录，默认 `save:false`，需要持久化时显式设置。回收记录中的恢复命令同样逐条执行、失败停止，不自动重试。

恢复不会自动发生，也不会根据运行配置猜测反向命令。2026-11-12 起，新记录保存 recovery-guard.json；恢复在同一控制台锁内校验 sysname、软件/型号指纹及变更后完整配置指纹，漂移或身份不符时不下发恢复命令。缺少 guard 的历史或不完整记录拒绝自动恢复。指纹不能区分同版本、同名、同配置的克隆，仍需核对实际拓扑。多设备变更不具备事务原子性；每台设备独立记录、独立恢复。恢复后应执行验收断言。统一验收与清理边界见 [ACCEPTANCE-RUNNER.zh-CN.md](ACCEPTANCE-RUNNER.zh-CN.md)。

日志仅记录执行证据，不保存认证参数；已知会话口令和常见 password / cipher / secret / community / key 字段会脱敏。脱敏快照不能直接当作完整备份；若恢复命令包含被脱敏的内容，自动读取恢复计划会拒绝执行，需人工重新提供命令。设备配置可能含未识别的敏感字段，日志目录应限制访问，不应直接提交仓库。文件创建使用 0600；Windows 访问控制仍取决于目录 ACL。

## 验证范围

本轮覆盖真实独立 Node 进程抢锁、不同端口互不阻塞、进程退出后旧锁回收，以及真实 TCP 模拟 VRP 控制台上的 MCP 配置、失败阻断、快照脱敏、进度记录、日志检索和显式恢复。还验证采集失败的 MCP 标记和 CLI 非零退出码，以及收敛失败保留结构化数据。

上述为最初实现时的离线验证记录。2026-11-12 已新增真实 eNSP 漂移阻断、核验后恢复，以及统一验收器故意断言失败后清理的证据；结果见同级实验项目 docs/PRIORITY-COMPLETION-20261112.zh-CN.md，不改写此前失败或中止记录。
