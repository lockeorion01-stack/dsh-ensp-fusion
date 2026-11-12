# grbj-ensp-mcp v0.2.2 对比分析与补齐

分析对象为同一工作区内的 grbj-ensp-mcp-v0.2.2 源码及 dsh-ensp-fusion。分析日期：2026-11-11。依据是源码、注册入口、测试和打包配置，不以 README 工具数量代替能力验证。

## 参考项目解读

参考项目为 Python 3.10+ 的 MCP 服务，入口 server.py，依赖 mcp 和 defusedxml。topo_parser/topo_builder 处理拓扑，port_scanner 扫描控制台，telnet_client 处理 socket/IAC/提示符，session_manager 管理长驻会话。diagnostics 提供规则诊断和推理上下文，lldp_verifier 解析邻居并比较设计链路。配套 skill 强调先探查真实型号、版本及当前配置，再生成命令。

其优势是围绕网络工程操作拆出细粒度工具：版本与运行配置、单条/批量命令、会话清理、实验下发、验证、健康检查、诊断和 LLDP。参考项目的 health_check 支持显式预期接口、路由和邻居数量。smart_config 的命名不表示引入了独立大模型服务：命令方案仍依赖调用方，不能理解为自行完成自然语言规划。

LLDP 相关工具存在自动使能路径：读取未开启的 LLDP 时可能下发 lldp enable。这是有配置副作用的读取流程。安装器面向 WorkBuddy；README 中下载地址和 pyproject 中仓库地址含占位值，不能作为可用下载源或已发布证明。源码可直接分析，不需要运行安装器或导入 wheel。

## 能力映射

| 参考能力 | 融合项目现状与处理 |
| --- | --- |
| 拓扑解析、构建、端口发现 | 已有 ensp_topo/build/status 和拓扑解析模块；保留原实现 |
| Telnet 下发、认证、保存 | 已有 VrpSession 和 ensp_cli，包含失败停止、断言、保存确认与批次预校验；不导入第二套传输 |
| 运行版本、配置探查 | 新增 ensp_inspect，一次只读采集五类回显，记录失败、已执行项和未执行项 |
| VRP 诊断 | 新增 ensp_diagnose：12 类规则及 ping 丢包率；返回建议与只读探查命令，无匹配为 UNKNOWN |
| LLDP 拓扑核验 | 新增 ensp_lldp：brief/detail 解析、接口别名归一、无向去重、链路差异与证据覆盖检查 |
| 实验编排、验证与健康判断 | 已有 cli + wait + labtest；显式断言由 labtest 承担，inspect 仅收集证据 |
| 长驻会话及 idle 清理 | 未迁移；融合项目每次会话 finally close，不存在相同的 idle 池管理需求 |
| GUI、截图、Word 报告 | 融合项目已有，参考项目主要面向已启动设备的控制台操作 |
| 自然语言提示模板 | 已有 23 个场景指导；补充配置前探查和诊断流程到融合 skill/MCP instructions |

## 新工具调用

三个新工具通过同一注册入口提供 DSH/MCP/CLI。无新 npm/Python 依赖；未拷贝参考 Python 源码。原 12 工具扩展为 15 工具。

ensp_inspect 输入示例：`{"port":2000,"timeout_ms":30000}`。可传 username/password。共享总时间预算，执行 display version、display current-configuration、display ip interface brief、display ip routing-table、display lldp neighbor brief。失败停止，保留已采集回显，不 save，不使能 LLDP。运行配置可能含敏感信息，交付日志前应检查。

ensp_diagnose 输入示例：`{"output":"Error: Unrecognized command found at position."}`。返回分类、建议及探查命令。规则线索不构成确定根因；不会据此自动修复。

ensp_lldp 输入示例：

```json
{
  "links": [{"a":"R1","a_port":"GE0/0/0","b":"R2","b_port":"GE0/0/1"}],
  "observations": [
    {"device":"R1","output":"GE0/0/0  R2  GE0/0/1  120"},
    {"device":"R2","output":"GE0/0/1  R1  GE0/0/0  120"}
  ]
}
```

links 使用实验计划中的明确设备名与接口名；当前工具不直接读取 topo_path。observations 使用真实 display lldp neighbor brief/detail 回显。设备 sysname 与期望名必须精确对应，改名需要调用方显式映射。

返回 matched、topo_only、lldp_only、mismatched、unobserved、scans。mismatched 保留同一设备对所有未匹配候选，避免并行链路被任意配对；该项与 topo_only/lldp_only 可以重叠。只有期望链路匹配且端点都有可识别采集结果时为 MATCH；缺采集、禁用、未知格式或仅缺邻居为 INCONCLUSIVE；有额外/接口冲突观测为 DIFFERENT。LLDP 可受启动、老化、单向通告和设备支持影响，MATCH 不保证业务连通，也不证明双向通告。

统一响应为 `{ok,data,error}`，data 为 JSON 字符串。inspect 还需检查 data.ok；LLDP 的差异由 data.status 判断，不能把外层 ok 当作拓扑一致。

## 后续边界

1.1.0更新：topo_path直读、证据时间戳、逐链路双向校验及历史VRP回显夹具已补齐；当前参数及兼容性边界见REMAINING-MODULES.zh-CN.md。下文工具数与验证项保留为首轮历史记录。

未迁移参考项目全部工具别名、MCP 提示模板、base64 XML 输入、自动地址规划及完整诊断规则库。当前检查依据明确输入计划，不自动修复拓扑，不隐式使能协议，不宣称全量兼容参考项目。后续可以在现有拓扑解析器的槽位适配充分验证后增加 topo_path 直读，以及更多 VRP 实机回显夹具。

本次验证包括离线解析/诊断用例、MCP 注册及模拟 Telnet 的部分失败取证。无真实 eNSP 启停或业务验收；未运行参考项目安装脚本，不修改宿主 MCP 配置。

验证结果：npm test 的 MCP 冒烟 24 项通过，Node 测试 206 项通过；npm run check:plugin 通过；npm run test:package 的离线安装、CLI 外部工作目录调用、拓扑生成及 MCP initialize/list 通过，确认工具数 15。

后续实机验收（2026-11-11）：企业五设备拓扑完成设备断言 18/18、PC 出网与 NAT 会话、临时阻断/恢复，以及两条 LLDP 链路 MATCH。修复 USG6000V Interface/Neighbors、SysName/PortId 详细输出解析；缺邻居身份的简表返回 UNKNOWN。临时 LLDP 和策略变更均恢复。修复后 Node 回归 207 项通过，离线打包通过。完整报告在同级实验项目 dsh-ensp-experiments/docs/FORMAL-ACCEPTANCE-20261111.zh-CN.md；前述“无真实验收”仅指首轮离线补齐阶段。
