# M3 三项可靠性修补交付记录

日期：2026-11-20（Asia/Shanghai）。本轮完成源码修补及离线证据核验；候选版本 1.1.4，运行安装副本仍为原 1.1.3。没有执行真实设备启停、配置、保存或 GUI 自动化。

## 修复与实证

| 范围 | 修改 | 实际文件/会话核验 |
| --- | --- | --- |
| AC/AP 格式 | 唯一配置资产、CRC/边界验证、VRP 版本头正文识别；未知与歧义保留 | AC1 的 1469 字节 ZIP、3926 字节配置载荷识别为 content_verified；AP3 保持 persistence_unverified |
| 检查点 | 全部设备配置资产清单、非控制台 XML/ZIP、空目录、三方哈希一致 | 18 文件、18 目录、250195 字节完全一致；stable 和 assetCopyVerified 为 true，因 AP3 未验证而整体 ok=false |
| 错误证据 | 按操作/调用 ID 导出结构化脱敏 JSON，保留物理行号和外层错误定位 ID | 真实连续 Zstandard 会话的第 04 次 connect/ECONNREFUSED、skipped、operation_id/call_id 与历史恢复结果一致；两种筛选均保留正文 |

真实错误原始 execution 的保守 may_have_applied=true/unconfirmed 也原样保留；导出器不重新评估或覆盖旧运行结论。不能据此重放操作。原会话 SHA256 前后一致；原工程只使用此前不可变副本，源文件未改。

## 回归与交付

验证记录与候选固定目录：test-results/m3-20261120/reliability-completion/。其中 field-validation.json 汇总真实文件与压缩会话核验；field-checkpoint/checkpoint.json 为逐文件清单；field-failed-operation.json、field-failed-call.json 为脱敏错误证据，仍需按本地敏感证据管理。

定向回归已覆盖无 sysname AC、损坏/截断/空/重复成员 ZIP、未知 AP、歧义资产、PC.xml/ZIP 变化、符号链接拒绝、导出不覆盖/不匹配/双筛选拒绝、跨记录脱敏、纯元数据不补造正文，以及真实 DSH SDK 和 MCP 边界。完整回归、安装包完整性、发布静态扫描及隔离宿主结果在该目录的最终交付清单中记录。

本轮结果：366 项 Node 测试及 24 项 MCP 冒烟全部通过，零失败、零跳过；check:plugin、rc.5 Electron-as-Node 隔离宿主、test:package 与 check:release 均通过。包测试逐一核验 126 个文件大小与源码 SHA256、12 个声明入口，完成离线干净安装和 19 工具检查。隔离宿主同时验证 operation_id/call_id 导出及完整失败正文；runtime_session_verified=false，不能解释为用户桌面运行版本已切换。

固定候选位于该证据目录的 final/dsh-ensp-fusion-1.1.4.tgz；final/delivery.json、package-files.json 和 content-manifest.json 记录包 SHA256、运行构建指纹、逐文件清单与各门禁结果。新包另行解包核对全部文件并通过隔离宿主检查；完整输出保留为本地证据，不包含在分发包中。

## 放行边界

本交付只确认已修复的软件行为、历史日志证据导出与配置资产复制完整性。AP 持久化机制、活动工程身份、保存/重开、业务、并发和原生崩溃根因仍是 M3 待验门禁。现有安装与旧固定包不被本候选覆盖；新包的加载需单独核对运行构建指纹。
