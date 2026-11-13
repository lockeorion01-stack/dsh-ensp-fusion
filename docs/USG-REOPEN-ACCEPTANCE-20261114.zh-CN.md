# USG 配置恢复与工程重开阶段验收

日期：2026-11-14，Asia/Shanghai。本轮三台USG真实控制台、选定配置恢复、设备保存、正常关闭及同路径重开回读验收结论为 **PASS**，`reloadVerified=true`。旧进程退出与VM全停后，新进程和三台新VM实例启动，界面再次确认34台设备的同一工程，三台版本与current/saved分别39/39/23项匹配。此结论仅覆盖三台USG选定配置持久化，**园区整体业务验收仍未通过**。

## 范围与判据

现场是当前34台设备的园区工程，包含三台 USG、13台交换机与两台ISP。验收分别检查配置资产、真实控制台及设备版本、当前/保存配置、设备保存、工程回写、同路径关闭重开和重开后回读。每一阶段单独记录，界面投递、VM running、端口监听或文件变大不等于后续阶段通过。

本文只列关键项及脱敏证据路径，不包含完整配置、账号口令。`test-results/ui-acceptance-20261114/` 为本地忽略证据目录，不随插件打包。

## 阶段结果

本表保留早期设备验收结束时的记录；其中桌面部署PENDING已在后续完成，见文末补充。

| 阶段 | 状态 | 已取得证据及当前限制 |
| --- | --- | --- |
| 完整备份与三USG资产定向恢复 | PASS（资产范围） | 完整备份473文件；恢复FW-01/FW-02/财务墙配置，分别7511/7516/6388字节，去除各源尾部1个NUL，原始源保留。未整体覆盖旧工程，其他资产保留；不据此声明设备已加载 |
| FW-01真实控制台与版本 | PASS | 获得真实 `<FW-01>` 与 display version，VRP 5.170 / USG6000V1 V500R005C10SPC300；不再是仅 `#` 的状态 |
| FW-01当前/保存配置与本机save | PASS（选定基线） | 当前配置39项、保存前配置39项及明确save后的保存配置39项匹配。设备保存成功，startup指向hda1:/vrpcfg.cfg。对端离线产生同步保存不可用警告，不能宣称双机同步成功 |
| 财务墙真实控制台、版本与保存 | PASS（选定基线） | 获得真实 `<FW-CW-01>` 与 display version，VRP 5.170 / USG6000V1 V500R005C10SPC300；当前、保存前、保存后配置各23项匹配，包含VLAN31、FIN-DB与OPS-DB-MGMT，明确save成功 |
| FW-02真实控制台、版本与保存 | PASS（选定基线） | 早先认证请求后已取得真实VRP与display version，同为VRP5.170；当前、保存前、保存后配置各39项匹配，明确save成功。没有以VM启动或用户登录反馈代替设备回读 |
| HRP运行状态抽样 | PASS（重开后双墙状态） | 重开后分别回读双墙实际状态为active/standby且peer角色相对一致；此为运行状态抽样，不能替代接管时限、双WAN可用或会话保持测试 |
| 财务实际启动文件持久化 | PASS（原生自定义文件） | 原生退出导出fwcw.cfg 6425字节；重开后current/next startup均为hda1:/fwcw.cfg，目录存在该文件且current/saved各23项匹配。关闭前临时设置next vrpcfg.cfg未被原生工程序列化保留，不宣称文件名归一化成功，也不将原生自定义fwcw.cfg认定为缺陷 |
| 13台交换机磁盘配置内容 | PASS（只读资产范围） | 实际配置均可读且设备身份匹配；旧解析器对尾随sysinfo ZIP产生假阴性，已修源码并复核原文件未变。未证明当前挂载指针或冷启动加载 |
| 全18台CLI设备持久资产 | NOT PASS / 待补 | 汇总configurationContentVerified仍为false；两台ISP目录缺少持久配置。此结论不能解释为13台交换机损坏 |
| 源码与打包回归 | PASS | 最终308项Node、24项MCP冒烟通过，无失败或跳过；包含尾随日志ZIP、唯一USG .cfg识别、多候选ambiguous及检查点保留全部候选。插件检查、rc.3隔离宿主、101文件离线干净安装打包及发布前检查通过；20篇文档、87条相对链接检查无发现 |
| 桌面安装副本与运行中会话 | PENDING | 实际运行UI显示1.1.3及rc.3兼容状态；没有运行中工具加载指纹，且安装副本尚未包含本轮新增flash与USG自定义配置资产源码修复。需更新后重新核对live fingerprint，不能以UI版本号或隔离检查代替 |
| 工程保存、正常关闭及磁盘回写 | PASS（关闭与选定资产范围） | 用户保存退出后，确认无eNSP进程、无running VM、8302/8303/8306无监听；稳定备份472文件、4159375字节。磁盘FW01/FW02 vrpcfg.cfg及财务fwcw.cfg分别39/39/23项匹配 |
| 保存前后拓扑与其他资产 | PASS（限定字段） / 端点差异待验 | 34设备身份/型号/端口/接口数、38链路端点接口与47注释相同；13交换机配置内容哈希全相同，四Server静态网络与eth保留。PC2—PC9仍DHCP但序列化租约地址归零，四Server system_mac变化；不是所有差异均为布局/空白，端点业务不据此判通过 |
| 同路径重开及重开后回读 | PASS（三USG选定配置） | 旧PID27208退出、VM全停后，同路径新PID31828于本地01:54:11启动，三台VM实例UUID均更新；fresh界面确认hengrui-expanded、34设备。01:59真实回读三台VRP、current/saved各39/39/23项匹配，财务actual current/next均fwcw.cfg。不是复用旧进程或只依据用户反馈 |
| 园区业务与稳定性 | NOT PASS / 未复验 | 本轮配置恢复没有复验真实应用、HRP接管、NAT数据面、财务访问正反断言及历史业务FAIL |

## 恢复基线

双出口来自已核实的历史非空资产；每台保留自己的WAN地址、默认下一跳、HRP对端和active/standby配置偏好，保留OFFICE/MOBILE PAT、SNAT顺序及四条DNAT。配置偏好不证明实际协商角色或接管时限。

财务恢复源是较新的6389字节重启前保存配置，包含GE1/0/2.31的10.20.31.14/28、数据库10.20.31.11、FIN-DB及OPS-DB-MGMT；它优于缺少VLAN31的6179字节旧备份。本轮current/saved及save后23项匹配。关闭前曾在guard下显式保存vrpcfg.cfg并临时设置next；原生正常退出仍导出fwcw.cfg 6425字节，重开后实际current/next startup均为`hda1:/fwcw.cfg`，文件存在且运行/保存配置23项匹配。因此已证明原生自定义文件导出和实际加载成功；临时next vrpcfg设置未保留，不登记为文件名归一化成功，也不将fwcw.cfg本身写成缺陷。配置持久化通过仍不证明真实数据库服务或策略业务断言通过。

项目检查器源码另补唯一USG .cfg资产选择：存在唯一候选时支持原生自定义名，多个候选保持ambiguous、不猜启动文件，检查点保留全部候选。磁盘检查器仍不能单凭文件存在推断active startup；本次财务加载结论来自独立实机回读。

当前34台拓扑、数据库端点、13台交换机最新管理/日志配置及ACC06财务端口调整保留。未使用旧完整工程覆盖当前现场。

## 证据索引

以下均为本地证据目录下的相对文件名，保留原始时间点；文件名中的UTC日期可能仍为2026-11-13，对应本地2026-11-14凌晨。

| 内容 | 文件 |
| --- | --- |
| 备份、定向恢复和关键项检查 | `asset-restoration.json`、`recovery-analysis.md` |
| 选定运行基线、无正文断言比较器及自检 | `runtime-assertion-baseline.json`、`compare-runtime-config.mjs`、`runtime-comparator-selfcheck.json` |
| FW-01真实提示及版本探测 | `probe-FW-01-2026-11-13T17-17-38-571Z.json` |
| FW-01当前/保存配置首次回读 | `runtime-FW-01-read-2026-11-13T17-18-22-402Z.json` |
| FW-01保存动作及保存后39项回读 | `runtime-FW-01-save-2026-11-13T17-19-33-736Z.json` |
| 财务墙版本、startup、save及保存后23项回读 | `runtime-FW-CW-01-save-2026-11-13T17-42-37-200Z.json` |
| FW-02版本、save及保存后39项回读 | `runtime-FW-02-save-2026-11-13T17-44-23-975Z.json` |
| FW-02实际HRP standby/peer active状态抽样 | `operational-FW-02-2026-11-13T17-47-19-829Z.json` |
| 财务vrpcfg.cfg显式保存、文件回读及下次启动指针设置 | `finance-startup-normalization.json` |
| 正常关闭后的三USG导出文件与基线 | `disk-after-project-close.json` |
| 三USG同路径重开综合结论、进程/VM/UI身份 | `final-usg-reopen-summary.json`、`reopen-ui.json` |
| FW-01重开后VRP、current/saved与startup | `runtime-FW-01-reopen-read-2026-11-13T17-59-02-147Z.json` |
| FW-02重开后VRP、current/saved与startup | `runtime-FW-02-reopen-read-2026-11-13T17-59-02-155Z.json` |
| 财务墙重开后VRP、current/saved与startup | `runtime-FW-CW-01-reopen-read-2026-11-13T17-59-02-168Z.json` |
| 重开后双墙HRP与财务实际fwcw文件 | `operational-FW-01-2026-11-13T17-59-21-498Z.json`、`operational-FW-02-2026-11-13T17-59-21-493Z.json`、`operational-FW-CW-01-2026-11-13T17-59-21-492Z.json` |
| 保存前后34设备、38链路、13交换机及端点资产比较 | `project-save-comparison.json`、`project-save-comparison.md` |
| VM/代理生命周期与日志能力边界 | `usg-current-lifecycle.json`、`usg-current-lifecycle.md` |
| flash假阴性复现、修复及真实资产复核 | `flash-validation.md`、`flash-validation.json`、`flash-reliability-test.txt` |
| 修复后18台CLI资产汇总 | `after-parser-fix-assets.json` |
| 最终308项Node与24项MCP输出 | `npm-test-final.txt`；较早306项批次为`npm-test-after-flash.txt` |
| 最终插件、隔离宿主、打包及发布前检查 | `plugin-check-final.txt`、`host-final.json`、`package-final.txt`、`release-final.txt` |

断言比较器仅处理选定字段，不检查所有策略，也不能证明不存在其他更宽规则。配置正文在内存中处理，报告只保留布尔、缺失项和必要元数据。HRP基线曾因前导空格漏匹配，已改逐行trim并自检；这属于验收脚本修正，不是设备HRP配置变更。

## 剩余验收范围

1. 原桌面安装更新与运行指纹待办已完成，见后续补充。UI版本及兼容标记仍不能替代运行中工具回读。
2. 补齐两台ISP有效持久配置或明确其无法验收的原因，重新检查18台资产；13交换机实际冷加载仍需独立回读。
3. 独立核验DHCP租约重获、四Server实际端点身份与业务，不回灌旧动态地址或盲改system_mac。
4. 另做园区业务正反测试、HRP/双WAN故障切换时限与稳定性。历史冷ARP、端到端负载瓶颈和指定S5700隔离失败仍保留，见[已知问题](KNOWN-ISSUES.zh-CN.md)与[总验收状态](TOTAL-ACCEPTANCE.zh-CN.md)。三台USG同路径重开与选定配置验收已经完成，不再列作待办。

## 后续桌面部署补充

2026-11-14 已从验证包恢复旧空安装目录的101个文件，逐文件SHA256匹配源码；当前GitHub安装副本通过rc.3真实隔离宿主检查。后续 `ensp_status` 原始会话日志确认插件实际加载路径为profile下 `node_modules/dsh-ensp-fusion`，指纹为 `71de65bc418c462f7639296b30a74da7d43e057c80c784971b79654d60087d9b`，与已修源码一致。`loadedAt` 为北京时间2026-11-14 03:01:45.284，后续回读确认生效。

因此早期表中的桌面部署PENDING已闭环为 **PASS（本机运行加载）**，两项资产检查修复已部署。完整步骤、旧路径ENOENT及模块缓存边界见 [1.1.3 后续部署核验](releases/1.1.3.zh-CN.md#后续部署核验)。此项不改变园区业务FAIL或其余设备待验范围。
