---
name: ensp-fusion
description: Fusion-specific topology construction, scenarios and convergence workflow.
---

先使用 `ensp_scenarios` 获取实验指导，再用 `ensp_build` 创建新拓扑；已有拓扑优先 `ensp_topo`。
生成器提供设备与 VRP 接口链路，不下发配置。场景是 brief，命令需要按设备确认。
新建拓扑后调用 `ensp_topo action:list` 更新上下文。
现场操作先 `ensp_status`，GUI 只负责必要的启停和取证，配置走 `ensp_cli`。
配置结束应核对保存状态，再 `ensp_wait` 等待协议收敛，随后 `ensp_labtest` 生成明确断言的验收证据。
原有截图与 Word 报告使用 `ensp_capture`、`ensp_doc`。
新工具返回 `{ok,data,error}`，data 是 JSON 字符串；失败时不要假定配置回滚。
