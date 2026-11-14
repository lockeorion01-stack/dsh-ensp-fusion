# 场景拓扑与地址配置生成

本轮对照 lizi600jin/dsh-ensp 0.8.0 源码，接入场景蓝图与实验准备流程。融合版继续使用现有会话、保存确认、工作区限制、脱敏及验收通道。

## 来源与接入范围

- 原项目：[lizi600jin/dsh-ensp](https://github.com/lizi600jin/dsh-ensp)。
- 固定源码提交：`9f1452bb8a5448f1f26283159fb02752f21ac0b2`。
- 原样同步：`upstream/lizi600jin/src/core/presets.mjs`、`labs.mjs`。完整 GPL 许可保留于上游目录，整体来源见 [NOTICE](../NOTICE.md)。
- 融合适配：`lib/scenario-lab.js`；抽出 `lib/topology-builder.js` 共用既有设备、接口、端口和命名校验。
- 上游 `build.mjs` 只补充模拟 PC 的 DHCP 参数，保留 USG、Client/Server 模型映射。

| 上游能力 | 本轮融合状态 |
| --- | --- |
| 50 个场景指导和拓扑蓝图 | 已接入，支持搜索、指导、设备、链路与地址表 |
| 按场景生成拓扑 | 47 个可生成，其余 3 个明确返回不支持原因 |
| 从地址表生成配置 | 已接入为地址配置骨架，使用融合版校验和预览 |
| 课程目录与知识点索引 | 本轮未导入，继续使用场景步骤与检查指导 |
| 新型号注册和上游 GUI/会话实现 | 未整体替换，使用现有融合版通道 |
| 无 Python 的 DOCX 与报告实现 | 本轮未导入，现有 ensp_doc、验收报告仍可使用 |

## CLI 生成实验准备目录

从源码根目录执行，输出目录的父目录应已存在：

```powershell
$Lab = Join-Path $env:TEMP ('ensp-ospf-' + [guid]::NewGuid().ToString('N'))
node bin/dsh-ensp-lab.mjs scenario --id ospf-single --out $Lab --first-com-port 2000
node bin/ensp-fusion.mjs call ensp_cli (Join-Path $Lab 'cli-plan.json') $Lab
```

最后一条命令只执行 `dry_run:true` 的配置预览，不连接设备。生成目录包含：

| 文件 | 内容 |
| --- | --- |
| topology.topo | 由蓝图生成的新拓扑，保留专门布局 |
| addressing.json | 原始地址规划表，包括地址说明 |
| scenario.md | 实验步骤、检查命令、易错点与生成边界 |
| cli-plan.json | 有 VRP 地址配置时才生成，可供 ensp_cli 直接预览 |
| 001-device.cfg 等 | 对应设备的独立配置骨架，包含 system-view/return |
| manifest.json | 场景、设备/链路汇总、文件清单与限制说明 |

已有输出目录（包括空目录）一律拒绝复用。无效场景、超出端口范围或不支持型号在创建目录前报错；文件写入失败时清理本次新建的目录。没有 VRP 地址配置的二层场景不输出空 cli-plan.json。

## DSH / MCP / 通用 CLI

继续使用既有 19 个工具：

1. `ensp_scenarios {query:"ospf"}` 搜索；`generation.supported/reasons` 表示能否在当前构建器生成。
2. `ensp_scenarios {id:"ospf-single"}` 返回完整指导、设备、链路和地址表。
3. `ensp_build {scenario_id:"ospf-single",output_path:"ospf.topo"}` 生成拓扑，同时返回 cli_plan；没有 VRP 配置时为 null。
4. 将 cli_plan 传给 ensp_cli 先预览；补全实验配置，核对真实型号、版本和当前状态后再显式执行。

通用 CLI 示例要求 $Lab 已存在：

```powershell
node bin/ensp-fusion.mjs call ensp_build examples/build-scenario.json $Lab
```

该示例只生成 ospf-single.topo，不生成整个实验目录。scenario_id 与自定义 devices/links 互斥，原自定义构建方式继续可用。

## 配置范围与未完成项

- cli_plan 默认 dry_run:true，每台设备 save:false、system_view:true；生成不代表执行、保存或业务通过。
- IPv4 前缀仅接受 0..32，IPv6 仅接受 0..128，拒绝非法地址和多行注入。
- IPv6 骨架包含全局 ipv6 和接口 ipv6 enable；Vlanif 骨架先创建对应 VLAN。仍需核对具体固件语法。
- 不自动生成 OSPF/BGP/VRRP、路由策略、VLAN 端口成员、Trunk、隧道参数、安全策略或接口二三层切换。使用场景指导补全。
- DHCP 模拟 PC 通过原生 -simpc_dhcp_state 1 启用动态地址，静态 IPv4 字段归零并启用自动 DNS，不能与静态地址选项混用。
- Server 地址写入 .topo 原生启动参数，不向没有 VRP 控制台的终端生成设备命令。未指定服务器网关时设置为未配置的 0.0.0.0 并返回提示，路由业务前须补全。服务目录、服务启用与业务验收另行完成。
- ppp-hdlc 需要当前未注册的 Router；wlan-basic、wlan-roaming 需要 AP6050。保留指导和蓝图但拒绝生成，不替换成接口不相符的型号。
- 47 个可生成场景的离线检查不代表设备镜像、全部协议及固件已现场验收，园区现有失败项保持原结论。

## 验证

```powershell
node --test test/scenario-lab.test.mjs
npm test
npm run check:plugin
npm run test:package
npm run check:release
```

新增回归逐一生成全部支持蓝图并检查拓扑回读、端口唯一性和 CLI 计划；覆盖 CIDR 边界、IPv6/Vlanif 前置命令、DHCP、Server 参数、防覆盖、路径边界、外部工作目录 CLI 及共享工具处理器。现场设备测试另行记录。

本轮源码验证：317 项 Node 测试及 24 项 MCP 冒烟通过；插件注册、安装包离线干净安装、发布前检查通过。DSH 0.2.2-rc.3 隔离宿主原生执行器另行验证场景搜索、蓝图生成与地址配置预览。上述检查不修改用户 profile，不启动 eNSP，不构成现场网络验收。
