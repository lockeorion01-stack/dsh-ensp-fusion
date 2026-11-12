# 正式验收问题修复

针对 2026-11-11 企业五设备正式验收的复现问题进行修复。

## LLDP 交互确认

`ensp_cli` 新增可选 `confirm_lldp_disable` 布尔值，支持单设备参数或 devices[] 中逐设备传入。仅当命令是 `undo lldp enable`，且真实回显严格匹配“删除全部端口 LLDP 配置，是否继续”的已知 VRP 提示时生效。

默认回复 n，等待正常提示符，返回 `confirmation_required`，停止该设备后续命令；显式传 true 才回复 y。确认问答共用命令时间预算，保留完整回显。其他未知交互不自动确认，返回确认错误。此参数不是通用自动 yes 开关。

```json
{"port":9300,"system_view":true,"commands":["undo lldp enable"],"confirm_lldp_disable":true,"save":false}
```

正常配置仍按原规则保存；本示例属于明确的临时恢复操作。

## USG 探查详细邻居

`ensp_inspect` 若发现 USG `Interface ... has N Neighbors` 简表缺邻居身份，将追加 `display lldp neighbor`，仍共享总超时、不使能 LLDP，results 中保留简表和详细输出。这时最多六条命令。禁用状态仍保留为失败证据，不用成功包装替代真实结果。

## GUI 启动与设备就绪

`ensp_gui` 的 `{op:"start_all"}` 默认使用原生 Ctrl+Alt+A。桥先进行无鼠标前台激活，检查模态窗、窗口几何稳定性和当前前台归属，任何失败都不发送快捷键。随后仍检查端口以及真实提示符/display version，不能将快捷键发送当作成功。

旧工具栏方式可显式使用 `{op:"start_all",method:"toolbar"}`。鼠标移动保护保留；停止设备与开窗仍执行原守卫流程，不在取消后自动重复点击。

含 USG 设备的拓扑默认就绪预算为 240000ms，其余为 120000ms，ready_wait_ms 可覆盖。超时继续返回未就绪，不能保证任意机器四分钟内启动成功。

## PC 验收结果等待

新增 lib/pc-console.js 的 runPcPing，使用读取/发送回调：先确认 PC> 空闲，发一次合法 IPv4 Ping，再轮询新追加回显，等待本次完整收发数量、丢包率与 PC>，校验统计一致性。超时返回未完成，不沿用历史成功，不向忙碌控制台继续发送。

实验 formal-policy-check.mjs 改用该模块，运行时发现当前 PC 窗口、tab 与可见终端句柄，验证读取结果后使用。策略测试先确认基线 permit，修改部分由 finally 恢复。历史首包丢失保留为真实结果；稳定测试与首次测试分别记录，未假定其根因是 ARP。

实验记录器先独占预留证据文件再执行工具，防止重复标签在变更后才发现文件已存在。ENSP_ACCEPTANCE_OUTPUT 可指定新证据目录。旧记录保持不变。

## 验证记录

216 项 Node 测试及 24 项 MCP 冒烟通过，离线打包、插件自检通过。企业实机冷启动约 94 秒，默认拒绝约 155ms；USG 自动详细采集、三设备显式恢复与 PC 完整统计验证通过。完整证据与局限见同级实验项目 dsh-ensp-experiments/docs/LIVE-FIXES-20261111.zh-CN.md。
