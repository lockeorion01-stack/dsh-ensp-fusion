# 1.1.0 剩余模块完善

> 本文保留分轮实现和历史现场状态，后段修复会更新早期限制。当前版本统一结论见[1.1.0发布说明](releases/1.1.0.zh-CN.md)、[验收摘要](TOTAL-ACCEPTANCE.zh-CN.md)与[已知问题](KNOWN-ISSUES.zh-CN.md)。下文提及的独立实验原始文件不随本仓库分发。

## 完成范围

| 模块 | 本轮实现 | 验证依据 |
| --- | --- | --- |
| LLDP | topo_path直读、显式sysname映射、时间戳新鲜度、逐链路双向证据、排除PC/Server/Cloud、未映射接口清单 | 生成拓扑、原生USG接口声明、历史实机LLDP夹具、过期/单向/越界测试 |
| 脱敏 | 共用文本及结构化结果脱敏；配置、认证参数、URL凭据、认证头；覆盖采集、CLI、转录、预览、日志和验收报告 | 独立口令、重叠口令、未用于登录的设备配置口令、真实TCP返回与转录测试 |
| 应用层验收 | 新增ensp_services：HTTP状态/内容、指定DNS服务器A/AAAA解析、匿名FTP二进制下载SHA256、TCP连接 | 本机真实HTTP、UDP DNS、FTP控制/数据套接字；超时、不匹配、被动地址拒绝 |
| 稳定性 | 有界重复采样、逐轮证据、失败至恢复的采样间隔、连续失败次数 | 注入中断/恢复序列，原始失败不被最终成功覆盖 |
| GUI | select_tab按标准控件实时矩形点击、换算DPI并确认选中状态；PC命令页按可见终端及PC>提示符发现 | 模拟Win32测试及真实eNSP 150% DPI复验，实测命令页索引为1 |
| 兼容性 | 历史实机版本矩阵、经过筛选的版本/LLDP回显夹具；inspect输出历史匹配状态 | 前轮真实设备验收证据回放，不扩大为全型号支持 |
| 工程 | base.js设备批次执行拆入lib/device-execution.js；版本升为1.1.0；peer依赖固定为本机已验证版本；工具总数16 | 全量回归、插件检查、离线干净安装和打包后CLI/MCP验证 |

## LLDP输入迁移

`links` 和 `topo_path` 必须二选一。拓扑路径限制在工作区，读取支持现有readTopo的编码识别。按原生设备interface声明顺序读取扁平索引；未知型号/槽位不推测接口，返回unresolved。PC/Server/Cloud链路返回excluded，不能用LLDP替代这些端点的业务验收。

```json
{
  "topo_path": "enterprise.topo",
  "max_age_ms": 300000,
  "require_bidirectional": true,
  "name_map": [{"topology_name":"R1","sysname":"actual-R1"}],
  "observations": [
    {"device":"actual-R1","collected_at":"2026-11-11T10:00:00Z","output":"GE0/0/0  R2  GE0/0/1  120"},
    {"device":"R2","collected_at":"2026-11-11T10:00:01Z","output":"GE0/0/1  actual-R1  GE0/0/0  120"}
  ]
}
```

示例时间仅演示格式，实际调用必须使用采集完成时间。`ensp_inspect.results[]`现在返回collected_at，可用于构造observations。缺时间戳、超过五分钟、未来超过五秒或缺少某条链路的反向报告时为INCONCLUSIVE。过期数据不会制造DIFFERENT结论。max_age_ms可在1至86400000之间设置；require_bidirectional:false可用于明确接受单向证据的情况。离线库compareLldp不指定maxAgeMs时保留历史无时间戳分析行为，公开工具始终检查时间。

## 服务验收

先配置宿主机到隔离实验网络的实际可达路径，再按examples/service-plan.json修改目标；其中192.0.2.0/24是占位地址，不是已部署服务。调用：

```json
{"plan_path":"service-plan.json","report_prefix":"reports/service-round1"}
```

report_prefix父目录必须存在，JSON/Markdown/CSV三份文件全部独占预留后才开始探测；已有报告不会覆盖。运行中JSON标记status:running，进程中断留下该标记，不能作为验收通过证据。最终结果区分PASS、FAIL、ERROR；任一失败外层ok:false，完整证据保留在data。

计划必须显式指定vantage:host。HTTP仅GET，不跟随重定向，TLS保持证书校验，默认预期200，可附expect_body子串。DNS必须指定server IP和预期地址，支持A/AAAA及自定义port。TCP仅证明端口连接成功。所有目标先整体校验，rounds默认1，最大120，timeout_ms默认5000，interval_ms默认1000，总最坏预算不超过十分钟。HTTP响应及FTP下载上限各1MiB。

FTP示例目标：

```json
{"name":"ftp","kind":"ftp","host":"192.0.2.20","port":21,"anonymous":true,"path":"/probe.txt","expect_sha256":"<替换为文件真实64位十六进制SHA256>"}
```

FTP仅支持显式匿名登录和二进制RETR读取；验证文件哈希以及传输完成回复，不上传、不删除、不把banner当下载成功。优先EPSV，回退PASV时要求服务器提供的IP与控制连接对端一致。需要认证或FTPS的服务尚未支持。

rounds>1时持续记录各轮结果及recoveries，保留初次失败。采样恢复间隔包含探测和调度耗时，不能当作精确RTO。工具不主动断链、关接口或修改路由。当前没有新增的eNSP客体HTTP/DNS/FTP服务部署或真实故障倒换验收；从eNSP PC发起的验证仍需客体终端/应用证据。

## GUI页签

先按当前窗口发现唯一可见SysTabControl32，然后发送：

```json
{"steps":[{"op":"select_tab","hwnd":12345,"index":2}]}
```

index从0开始，必须读取返回confirmed，再重新发现唯一可见终端。桥接仅向标准SysTabControl32发送TCM消息；TCM_GETITEMRECT所需RECT分配在目标进程并读取后释放，避免向远程控件传入本地指针。实际点击按查询到的客户区矩形，不使用固定坐标；越界或未确认会失败。该操作仍需Windows交互桌面及匹配权限。

2026-11-11真实eNSP复验发现150% DPI下逻辑坐标直接投递会选中相邻页签，现已按目标窗口DPI转换坐标，并在目标DPI上下文校验客户区边界。实测dpi_scale为1.500669344042838。lib/pc-console.js新增discoverPcTerminal，逐页确认选择后，只接受唯一可见且以PC>结束的RichEdit终端；实际命令页索引为1，不再假设固定页序。

同轮真实单链路中断/恢复已执行，恢复日志成功且接口配置与基线完全一致，设备业务断言18/18通过。但PC恢复早期两次100%丢包，后续仍间歇出现首包超时；补充连续三轮为20%、0%、0%，稳定性验收未通过。接口UP/UP、STP FORWARDING及ARP/MAC存在不足以确定根因。保留原始失败，不以最后成功覆盖。证据位于同级dsh-ensp-experiments/test-results/live-modules-20261111，详见其实验报告docs/LIVE-MODULES-20261111.zh-CN.md。当前拓扑无HTTP/DNS/FTP服务端及冗余路径，因此这些客体业务与故障倒换仍未实测。

## 兼容性矩阵

| 型号 | 历史实机软件 | 已有真实业务证据 |
| --- | --- | --- |
| S5700-28C-HI | VRP5.110 / V200R001C00 | VLAN、接口、静态路由、Ping、启动配置、LLDP |
| USG6000V1-ENSP | VRP5.170 / V500R005C10SPC300 | 安全策略、源NAT会话、接口、路由、Ping、启动配置、LLDP详情 |
| AR2220 | VRP5.130 / AR2200 V200R003C00 | 接口、路由、Ping、启动配置、LLDP |
| 其他构建器型号 | 未建立同等级业务验收证据 | 可生成拓扑，不据此宣称运行命令已兼容 |

历史环境为Windows / eNSP1.2.0.500，日期2026-11-11。夹具来源为同级实验项目fixes-20261111的acceptance-final.json及07-auto-usg-detail.json，仅提取版本和LLDP证据，不携带认证参数或完整配置。inspect.compatibility匹配时返回HISTORICALLY_VERIFIED；新版本/未知型号为UNVERIFIED。历史匹配不会证明当前业务已通过。

## 发布和脱敏边界

源码包版本1.1.0，仍为private本地包。peer依赖固定到已验证的@deepseek-ai/dsh-tools 0.0.1-rc.1及@deepseek-ai/schemastery 3.19.0，不声称其他版本兼容。没有新增运行依赖，也没有修改用户MCP配置。

文本脱敏在配置断言评估之后进行，避免用处理后的文本代替真实证据。新工具所有返回均经过共享脱敏；CLI转录/结果和验收报告也使用共享实现。截图、Word中的图像和历史日志不会因此自动清理；未知设备语法仍可能漏掉敏感字段，应控制产物访问权限。脱敏后的命令/快照不应直接用于恢复。


2026-11-12 稳定性专项更新（11日启动）：动态场景冷网关ARP及70秒空闲后复现首包丢失，抓包显示请求已到INET-PC，随后PC解析网关MAC而没有回复该次ICMP。静态ARP冷/连续/空闲对照零丢包，但第二次断链后置变更日志快照20秒超时使完整对照ERROR；恢复成功且恢复动态ARP，未修改策略/定时器。动态连续50包及恢复后30包通过，两次单链路恢复约49/50秒，最终设备18/18。原始动态场景仍未全项通过；后置快照超时也需修复复验。新报告位于同级dsh-ensp-experiments/docs/STABILITY-ACCEPTANCE-20261111.zh-CN.md，机器汇总test-results/stability-20261111/final-stability-summary.json。


2026-11-12 后续修复：已修复More分页提示被末尾异步日志遮挡导致的等待超时；新回归用例先失败后通过，242项Node与24项MCP冒烟及打包/插件检查通过。静态ARP完整两次断链对照通过，接口与动态ARP均恢复。原始动态ARP冷/空闲首包缺陷仍保留，未宣称全场景通过。详见同级dsh-ensp-experiments/docs/STABILITY-FIXES-20261112.zh-CN.md。
# 2026-11-12 优先完善与验收补充

本节更新以下历史记录中“未实测”的范围；原失败与限制继续保留。六项工作依次完成：恢复前置保护、统一验收入口及异常清理、真实客体 HTTP/DNS/FTP、有限长稳与设备/应用重启、真实双链路倒换、环境依赖及兼容完善。原始优先项完成报告单独归档，公开版本见[验收摘要](TOTAL-ACCEPTANCE.zh-CN.md)。

独立验收台完成 32 分 22 秒、120 轮、360/360 包，另有真实 PC 100/100 包；应用重开后 HTTP/DNS/FTP 协议及文件哈希复验通过。设备与应用重启后须显式执行服务恢复清单，不能称原生服务自动持久化。两轮 GE23 主用中断、GE24 接管及受保护恢复通过，过渡分别丢失 1/5、2/5 包，不声明无损切换。恢复配置指纹修复 DATASYNC、LLDP、PHY 异步日志同行误判，原失败保留。工程验证为 260 项测试及 24 项 MCP 冒烟通过，打包与插件检查通过。

仍未通过：原始企业动态 ARP 冷/空闲首包、该 S5700 固件的二层 TCP ACL 业务拒绝；原生服务须清单恢复。园区实验继续暂停，STA2、无线隔离、园区主备未列入本轮通过范围。有限长稳不能作为 24/72 小时稳定性承诺。最终企业拓扑已恢复运行，设备断言复验 18/18；补充真实 PC 三轮为 5/5、4/5、5/5，间歇丢包仍在，企业 PC 稳定性未通过。首次设备断言 17/18、外侧端点因画布位置打开失败及全部重试证据均保留。

# 严重问题后续完善

新增中断验收的持久清理台账和受保护恢复 CLI、逐轮稳定性与隔离证据判定、原生服务恢复前身份/IP/DNS/文件哈希预检；修复对象型内层失败被外层成功遮蔽的问题。详见 [实现与限制](RELIABILITY-HARDENING.zh-CN.md)。本轮现场只读复核企业 PC 为 15 发 14 收，第三方间歇丢包及指定 S5700 的 TCP ACL 问题仍未解决，不宣称全部严重问题修复。

# 不足项核验与代码修复补充

2026-11-12该轮按用户选择保留不同拓扑，仅完成代码修复。隔离可达优先失败、拒绝证据窗口、协议失败/未完成结果、身份与IP/DNS歧义、过期恢复日志回退、数量矛盾及采样覆盖判定均已加固；279项测试、24项MCP冒烟及打包/插件检查通过。该轮原企业设备未运行，后续负载与Server副本实测已经补充；最新结论见[验收摘要](TOTAL-ACCEPTANCE.zh-CN.md)，不改变原始失败记录。
