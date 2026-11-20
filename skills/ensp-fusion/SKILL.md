---
name: ensp-fusion
description: Fusion-specific topology construction, scenarios and convergence workflow.
---

先使用 `ensp_scenarios` 获取实验指导，再用 `ensp_build` 创建新拓扑；已有拓扑优先 `ensp_topo`。
生成器提供设备与 VRP 接口链路，不下发配置。场景是 brief，命令需要按设备确认。
`ensp_scenarios` 现在提供 50 个指导；精确 id 同时返回蓝图、地址表与 generation.supported/reasons。`ensp_build scenario_id` 使用蓝图创建拓扑并返回地址配置 cli_plan（默认 dry_run:true，每台 save:false），与 devices/links 互斥。47 个蓝图可生成；Router/AP6050 尚未注册，ppp-hdlc、wlan-basic、wlan-roaming 明确拒绝生成。先预览并按固件补全路由协议、VLAN 端口、隧道和安全配置。DHCP PC 使用原生动态参数，Server IPv4 写入启动参数而非 VRP 命令；缺省服务器网关为未配置并有提示。完整离线准备目录使用 ensp-fusion-lab scenario，详见 docs/SCENARIO-LABS.zh-CN.md。
新建拓扑后调用 `ensp_topo action:list` 更新上下文。
现场操作先 `ensp_status`，GUI 只负责必要的启停和取证，配置走 `ensp_cli`。
配置结束应核对保存状态，再 `ensp_wait` 等待协议收敛，随后 `ensp_labtest` 生成明确断言的验收证据。
原有截图与 Word 报告使用 `ensp_capture`、`ensp_doc`。
新工具返回 `{ok,data,error}`，data 是 JSON 字符串；失败时不要假定配置回滚。

1.1.2 增加 `ensp_project`（配置内容检查/新建检查点/磁盘对比）、`ensp_console_diagnose`（单次探测及串口/同步日志关联）和 `ensp_logexport`（新建脱敏日志副本）。这些工具直接返回结构化对象。DSH 对插件正文 `ok:false` 返回 `isError:true`，证据保留在 content；原始 GUI open/spawn/key/bmclick 成功只表示投递，不能证明工程加载。
1.1.4：AC/AP 检查唯一 vrpcfg.zip、vrpcfg.cfg 或 flash.efz；无资产为 persistence_unverified，多候选为 ambiguous。检查点包含 ZIP/CFG/flash.efz/PC.xml 和空目录，assetCopyVerified 仅证明文件复制一致，整体失败不可忽略。若只有通用 ToolCallError，使用 ensp_logexport 的 operation_id 或完整 call_id（二选一）导出结构化失败 JSON，核对 structuredResults/evidenceLevel；不得根据元数据补造正文、覆盖原日志或自动重放。
`ensp_status` 分开报告隐藏窗口、进程、模态框、构建指纹与磁盘拓扑；当前工程身份未验证时保持 unknown。仅收到 `#` 是 non_vrp_console，不延长等待冒充就绪。CLI 支持命令对象 `expected_view` 与逐条匹配的 `replies:[{expect,reply}]`；未知问答停止，return 后配置模式会重新进入 system-view。凭据优先用本地 credential_file/credential_ref，命令可用 commands_file；不要把凭据文件提交或把原始宿主日志公开。

`ensp_inspect` 采集失败时外层 `ok:false`，`data` 仍保留部分证据；`ensp_wait` 失败也保留结构化数据。`ensp_lldp` 的 DIFFERENT、INCONCLUSIVE 现在聚合为失败/证据不足，不能计入成功；`ensp_diagnose` 的 UNKNOWN 仍是成功完成文本分析，不代表网络健康。

每次调用返回 `execution.operation_id`、验证层级及 `evidence_persisted`；记录缺失不能冒充完整取证。包装脚本使用包导出 `dsh-ensp-fusion/result` 中的 `assertOperationSucceeded(toolName, result)`，或严格检查 `ok === true` 并核对设备、断言与保存结果。不要 `catch { return '' }`，也不要按“不抛异常”累计成功。GUI `operation_verification:dispatched` 仅表示投递；业务通过仍需独立验收。崩溃事件取证使用 doctor incident，详见 docs/M1-IMPLEMENTATION.zh-CN.md。

正式配置用 `ensp_cli dry_run:true` 先预览，再提供 `change_dir` 启用前后快照和逐命令持久化记录；`recovery_commands` 必须根据原有配置编写。`list_changes` 检索历史及中断记录，`recover_from` 执行记录内显式恢复计划，默认不保存。恢复前核对设备和命令，不猜测反向命令、不自动回滚。控制台同端口有跨进程锁，`device_busy` 时先检查持有会话。详情见 docs/CHANGE-MANAGEMENT.zh-CN.md。

配置前先用 `ensp_inspect` 确认真实版本、当前配置、接口和路由，检查 data 内 ok/results/skipped。回显可能包含敏感配置。
报错用 `ensp_diagnose` 分析，不自动重试或修改；UNKNOWN 不能视为健康。

1.1.0 新增 `ensp_services`：plan_path计划必须显式声明vantage:host，支持HTTP状态/内容、指定DNS服务器解析、匿名FTP下载哈希和TCP连接；report_prefix产生新报告，不覆盖旧证据。rounds重复采样保留中断/恢复；宿主机探测不能作为eNSP PC业务或精确倒换RTO证据，不自动触发故障。

`ensp_lldp`现在要求links或topo_path二选一，默认五分钟新鲜度和逐链路双向观测；observations提供带时区的collected_at。缺时间戳/过期/单向为INCONCLUSIVE。name_map显式映射拓扑名与sysname，未知槽位列为unresolved，不猜测接口。inspect结果携带collected_at及历史版本兼容性识别，版本匹配也不表示当前业务健康。GUI的标准页签使用select_tab实时查询几何并确认，避免固定坐标。详见docs/REMAINING-MODULES.zh-CN.md。
用 `ensp_lldp` 比对 links（a/a_port/b/b_port）与 observations（device/output）；回显由 ensp_inspect 或 ensp_cli 采集。不会自动开启 LLDP。
设备 sysname 必须与 links 精确对应；MATCH 仅表示提供的证据一致，INCONCLUSIVE 表示证据不足。

USG 简表缺邻居身份时 inspect 自动补取详细邻居。关闭 LLDP 时只有明确接受删除所有接口 LLDP 配置才使用 `confirm_lldp_disable:true`；默认拒绝该提示并停止，不会超时等待人工确认。未知交互不自动 yes。
`start_all` 默认键盘方式；需要旧行为可传 `method:"toolbar"`，鼠标保护取消时先检查实际状态。含 USG 的就绪阶段默认请求四分钟，但受工具总 timeoutMs 及前序耗时限制，需预留充足总预算；仍应读取 readiness，不能把端口开放视为启动成功。

M2：DSH signal、MCP notifications/cancelled 和 CLI SIGINT/SIGTERM 会向控制台/桥转交取消。检查 execution.status、stop_confirmed、may_have_applied；cancelled 不等于配置回滚，unconfirmed 不得重放或执行冲突 cleanup。桥任务可在同一插件实例中用 ensp_status bridge_tasks 查询。工具总预算默认180秒，验收清理独立默认30秒；细节见 docs/M2-IMPLEMENTATION.zh-CN.md。

M2.1：GUI 整批预校验，截图 out/path 冲突拒绝；启动/停止只投递一次，超时不重放。就绪探测遇认证/交互/非 VRP 停止本次重试，暂态连接错误受总预算与退避约束。ensp_status observedAt 与 build.loadedAt 分别表示观测和加载时间；安装指纹一致且观测新鲜仍需注明实际入口。

拓扑绘图、排版或标注覆盖时使用 ensp-topology-drawing。ensp_topo 的 layout-inspect 检查原图，layout-preview 预览避让，layout-apply 写入新 .topo 副本。
