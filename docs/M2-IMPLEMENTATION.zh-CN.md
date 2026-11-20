# M2 取消与统一截止时间

2026-11-19。对应 [优化方案](OPTIMIZATION-PLAN.zh-CN.md) 的 W5，承接 [M1](M1-IMPLEMENTATION.zh-CN.md)。本轮交付源码和独立候选包，保留 1.1.3 版本号；尚未切换运行桌面的 profile，不能仅凭版本号认定已部署。

## 交付内容

| 范围 | 实现与验证重点 |
| --- | --- |
| 操作上下文 | `execution-control.js` 使用单调截止时间与每调用独立 AbortController；子层取剩余总预算和自身上限的较小值，记录发送、观察、停止确认和任务引用 |
| DSH | 读取执行上下文的 `signal`；保留宿主规范错误码 ABORTED，通过公开 `finalizeContent` 回传脱敏停止证据。缩短的取消结果使用 SDK 支持的独立 oneOf 分支，正常结果仍保留原必需字段 |
| MCP | 按 request id 为活动与已排队请求登记控制器；取消通知绕过串行动作队列，完成、异常和断开后清理映射；保持动作串行，无新增并发写入 |
| CLI 与验收 | SIGINT/SIGTERM 转 signal；验收 execute 显式传递 signal/deadline。信号取消后在资源回收和报告结束时退出 130，普通工具失败仍退出 1 |
| 控制台 | 每条命令、认证和交互回复前检查取消；关闭 socket，等待 close 后释放设备锁。已发出但未观察到终态的命令不重放，保留 unconfirmed |
| job 桥 | UUID 绑定取消文件、状态和结果；等待互斥锁、进入事务及每 step 前检查。既有 watchdog 只退出本 job；超时结果保留任务身份和未确认停止证据 |
| resident 桥 | `cancel_task`/`task_status` 走独立连接并绕过 GUI 锁；排队取消使用任务 tombstone 阻止晚到请求。单任务取消不终止整个 resident；已投递动作不降级到 job 重放 |
| 辅助进程与探测 | 就绪、收敛、服务探测和文档辅助进程接入取消；辅助进程等待真实退出再回收输出文件，防止 Windows 文件句柄占用和过早宣称停止 |
| 验收清理 | `cleanup_deadline_ms` 为整段 LIFO 清理提供独立预算，默认 30,000 ms、范围 1..3,600,000。原动作或此前清理未确认停止时，后续清理标为 SKIPPED_UNCONFIRMED；显式 recover 同样拒绝未确认原动作 |

另修补 M1 的 CLI 输出契约：公开声明实际返回的 `command_effects`、`recovery_verified` 和错误字段；真实 SDK 测试覆盖正常控制台返回，避免只验证 dry_run 而遗漏输出校验失败。

## 如何判读结果

- `execution.status: cancelled` 且 `stop_confirmed:true`：本次执行已停止，不再发送后续动作。`may_have_applied:true` 仍可能存在，表示此前已投递动作可能生效，不能解释为已撤销。
- `execution.status: unconfirmed` 且 `stop_confirmed:false`：已发送命令/原生调用缺少完成证据，或停止确认超时。不得自动重发，也不运行可能冲突的 cleanup。
- `execution.task_refs`：保留桥任务引用。可把其中的 `task_id` 传给同一插件实例的 `ensp_status` 参数 `bridge_tasks` 查询；job 保留状态/结果路径。请求映射不跨插件进程持久化，重新加载后未知任务不能被当作已停止。
- DSH 取消通过错误信封返回，完整证据位于 `content`，不保证有成功 `value`；MCP 返回 `isError:true`。读取工具业务字段时继续使用公共结果断言。

取消只能阻止后续投递，不能撤回设备已经接受的配置、原生窗口消息或已写文件。`stop_confirmed` 是本执行任务的停止证据，不是设备业务停止、配置回滚、磁盘持久化或工程重开证明。

## 预算与边界

`Config.timeoutMs` 现在作为每次工具调用的总预算，默认 180,000 ms；命令/连接/GUI step 自身超时只会进一步缩短剩余预算。MCP 从入队时计预算，取消已排队调用会阻止实际连接。验收 CLI 的每工具配置为 240,000 ms，同时受计划 `deadline_ms` 约束。

`start_all` 的 USG 就绪阶段仍请求默认 240,000 ms，但会受工具总预算及前序动作耗时限制；需要更长启动窗口时应在 DSH 配置或嵌入式 registry 中显式增加 `timeoutMs`。普通 CLI/MCP 命令行当前没有新增总预算参数。

resident 停止确认采用约 2 秒轮询预算；最后一次状态查询可能带来最多约 500 ms 额外等待。job 也预留约 2 秒确认窗口。无法抢占的 Win32 原生调用在返回前保留 running/未确认；watchdog、系统调度、辅助进程退出和证据写盘可能使工具响应晚于动作预算。同步解析/文件调用及旧桥不具备强制抢占保证。

共享 resident 启动可以在一个等待者取消后继续，供其他调用使用；取消的等待者不会投递其 GUI step。resident 的最终任务记录与取消 tombstone 保留约 10 分钟，最多 4,096 个；JS 侧最多保留 4,096 个未释放任务引用，容量达到上限时拒绝新增动作，需先核查遗留任务。旧 resident 未返回停止协议时保守保留未确认，不用断开 TCP 代替停止证明。

## 验证与证据

执行命令：

```powershell
npm test
npm run check:plugin
npm run check:dsh -- --output <new-report.json>
npm run test:package
npm run check:release
```

故障注入覆盖：发送前取消、命令间取消、命令发出但回复丢失、跨命令共享总截止时间、MCP 真实 stdio 活动/排队取消、resident 已确认与仍阻塞两条分支、明确未确认回复阻止后续动作、延迟就绪不晚发命令、两个真实 CLI 入口信号转交、独立清理预算与冲突清理阻断、辅助进程真实退出、Python job/resident 任务身份及 watchdog。

真实本机验证分为两层：已安装 DSH 0.2.2-rc.3 的 Electron-as-Node 隔离服务调用插件并连接测试控制台；实际 Win32 Python 桥以 sleep 操作验证 job、resident、排队取消、真实命名互斥锁释放。后者使用普通权限，未发送鼠标/键盘操作，未调用 eNSP 设备。

DSH 的历史 EACCES 与本机“以管理员身份运行”兼容层有关。检查脚本只对本次隔离子进程设置 `__COMPAT_LAYER=RunAsInvoker`，没有写兼容性注册表或更改系统设置。隔离启动成功不等于已运行桌面会话的 profile 部署验证。

本机逐项日志、宿主报告、候选包及内容清单位于被 Git 忽略的 `test-results/m2-20261119/`，最终计数和包校验见其中 `final/validation-summary.json`。这是软件取消能力验收，不是 eNSP 原生崩溃根因或园区业务验收。

## 后续阶段

W6：接入受保护的启动、保存、磁盘检查和同路径重开生命周期，明确每层证据。W7：在命令影响分类及取消保护基础上测量只读探测的有界并发。两者属于 M3，本次不预先开放自动恢复、配置重放或并发写入。
