# 场景预设（23 个）

由 `src/core/presets.mjs` 生成，勿手改。

每个场景只给**方向、顺序、验证命令**，不给成品命令块。

## 基础

### vlan-access — VLAN 与 Access 端口

- **英文名**：VLAN and access ports
- **来源**：eNSP HCNA Lab 1-2
- **设备**：1 台二层交换机 + 若干 PC
- **目标**：把不同端口划进不同 VLAN，同 VLAN 可通、跨 VLAN 不通

**配置顺序**

1. **创建 VLAN** — 按部门规划 VLAN ID，先创建再划端口
   - 验证：`display vlan`
2. **端口改为 access** — 每个接入口设置 link-type access 并指定 PVID
   - 验证：`display port vlan active`
3. **验证隔离** — 同 VLAN PC 互通；跨 VLAN 应不通（无需路由）

**易错点**

- 端口默认是 hybrid，直接设 PVID 不会让 VLAN 生效，必须先改 access
- trunk 口不要设 access，否则会把上行打断

### trunk-interconnect — Trunk 互联与多 VLAN 透传

- **英文名**：Trunk interconnect
- **来源**：eNSP HCNA Lab 1-2 / 1-4
- **设备**：2 台交换机 + PC
- **目标**：跨交换机同 VLAN 通信，VLAN 通过 trunk 携带

**配置顺序**

1. **两端建同名 VLAN** — VLAN 必须两端都存在，否则帧被丢弃
   - 验证：`display vlan`
2. **互联口设 trunk** — 放行所需 VLAN；PVID 保持默认 1
   - 验证：`display port vlan active`
3. **接入口设 access** — 按 VLAN 划分

**易错点**

- trunk 未放行目标 VLAN 时静默丢帧，无报错
- PVID 与 access VLAN 混淆会导致本征 VLAN 错乱

### vlanif-routing — VLAN 间路由（三层交换机）

- **英文名**：Inter-VLAN routing with a layer-3 switch
- **来源**：eNSP HCNA Lab 1-4 / 1-5
- **设备**：三层交换机 + PC
- **目标**：每个 VLAN 一个网关，VLAN 间可路由

**配置顺序**

1. **建 VLAN 与 access 端口** — 先二层通，再上三层
2. **创建 Vlanif 并配地址** — 一个 VLAN 一个 Vlanif，地址即该网段网关
   - 验证：`display ip interface brief`
3. **验证** — 不同 VLAN 的 PC 互 ping，网关应可达

**易错点**

- Vlanif 的 up 依赖该 VLAN 下至少一个 up 的端口
- 忘记给 PC 配网关则跨网段必然不通

### stp-rstp — STP / RSTP 生成树

- **英文名**：STP and RSTP
- **来源**：eNSP HCNA Lab 3-1 / 3-2
- **设备**：3 台交换机成环
- **目标**：破除二层环路，观察根桥、端口角色与收敛

**配置顺序**

1. **选根桥** — 核心设最低优先级，其余保持默认
   - 验证：`display stp`
2. **选择模式** — RSTP 收敛更快；MSTP 用于多实例场景
3. **观察端口角色** — 根端口 / 指定端口 / 阻塞端口
   - 验证：`display stp brief`
4. **断链验证** — 断一条链路，阻塞口应在数秒内转为转发

**易错点**

- 所有交换机优先级相同则靠 MAC 选根桥，结果不可控
- 边缘端口未开 edged-port 会让接终端时反复重收敛

### link-aggregation — 链路聚合 Eth-Trunk

- **英文名**：Link aggregation
- **来源**：eNSP 常规实验
- **设备**：2 台交换机 + 2 条互联线
- **目标**：多条物理链路聚合成一条逻辑链路，提高带宽并提供冗余

**配置顺序**

1. **建 Eth-Trunk** — 选 LACP 静态模式，两端必须一致
   - 验证：`display eth-trunk`
2. **加入成员口** — 成员口不能单独配 IP 或 VLAN
   - 验证：`display eth-trunk 1`
3. **在聚合口上配业务** — trunk / access 都配在 Eth-Trunk 上，不配在成员口

**易错点**

- 两端模式不一致（lacp-static vs manual）聚合不 up
- 成员口速率/双工不一致会只有部分成员 Selected

### static-route — 静态路由与默认路由

- **英文名**：Static and default routes
- **来源**：eNSP HCNA Lab 4-1
- **设备**：2~3 台路由器
- **目标**：手工打通非直连网段，并用默认路由简化边缘配置

**配置顺序**

1. **配接口地址** — 先保证直连可达
   - 验证：`display ip interface brief`
2. **写明细静态路由** — 目的网段 + 掩码 + 下一跳
   - 验证：`display ip routing-table`
3. **边缘用默认路由** — 0.0.0.0/0 指向出口，避免逐条写明细
4. **备份用浮动静态** — 同一目的写两条，备路由 preference 调高
   - 验证：`display ip routing-table protocol static`

**易错点**

- 下一跳必须直连可达，否则路由不进路由表（inactive）
- 掩码写错会让目的网段归一化成别的网段，形成意外覆盖或冲突

### rip — RIPv1 / RIPv2

- **英文名**：RIP versions 1 and 2
- **来源**：eNSP HCNA Lab 4-2 / 4-3
- **设备**：3 台路由器
- **目标**：用距离矢量协议自动学习路由；对比 v1 有类与 v2 无类的差别

**配置顺序**

1. **启动 RIP 进程** — 指定版本；v2 支持子网与认证
   - 验证：`display rip`
2. **network 宣告** — v1 按主类宣告，v2 可带掩码；宣告的是直连网段
3. **可选：认证与聚合** — v2 支持明文/MD5 认证和手动聚合
   - 验证：`display rip route`

**易错点**

- v1 不做子网掩码，遇到不连续子网会出错
- network 写错网段则接口不参与，邻居起不来

### ospf-single — OSPF 单区域

- **英文名**：OSPF single area
- **来源**：eNSP HCNA Lab 4-4
- **设备**：3~4 台路由器
- **目标**：单区域 OSPF 邻居建立与路由学习

**配置顺序**

1. **建 OSPF 进程** — 指定 router-id，建议显式配置避免选举不确定
   - 验证：`display ospf peer`
2. **area 0 内 network** — 宣告直连网段；通配符是反掩码
3. **调整 cost 或带宽** — 影响选路；默认按接口带宽计算
   - 验证：`display ospf interface`
4. **验证** — 邻居 FULL、路由表出现远端网段
   - 验证：`display ip routing-table protocol ospf`

**易错点**

- 反掩符写错（写成子网掩码）会宣告错网段
- 邻居卡在 2-Way 通常是 DR 选举正常但网络类型不匹配

### dhcp — DHCP 服务（含中继）

- **英文名**：DHCP server and relay
- **来源**：eNSP HCNA Lab 5-2
- **设备**：1 台路由器/交换机作 DHCP + PC
- **目标**：自动分配地址；跨网段时用中继

**配置顺序**

1. **启用 DHCP** — 全局 dhcp enable 必须先做
   - 验证：`display dhcp server statistics`
2. **建地址池** — network、gateway-list、dns-list
   - 验证：`display ip pool`
3. **接口绑定** — 本网段用 dhcp select global/interface；跨网段加 dhcp relay
   - 验证：`display dhcp relay`

**易错点**

- 地址池建了但接口没绑 dhcp select，客户端拿不到地址（静默失败）
- 中继场景下 DHCP 服务器必须有回程路由到客户端网段

### acl-filter — ACL 访问控制

- **英文名**：ACL filtering
- **来源**：eNSP HCNA Lab 3-1
- **设备**：2 台路由器
- **目标**：按源/目的/协议精确放行或拒绝

**配置顺序**

1. **选 ACL 类型** — 基本(2000-2999)只看源；高级(3000-3999)看五元组
2. **写规则并注意顺序** — 精确匹配在前、宽泛规则在后；默认末尾隐含拒绝
   - 验证：`display acl 3000`
3. **应用到接口方向** — inbound 是进入接口的流量；方向选反等于不生效
   - 验证：`display traffic-filter applied-record`

**易错点**

- 反掩码（通配符）写错会连带放行/拒绝相邻网段
- 方向选反是静默失效，接口计数不增长

### aaa-local — 本地 AAA 与设备登录

- **英文名**：Local AAA and device login
- **来源**：eNSP HCNA Lab 3-3
- **设备**：任意设备
- **目标**：统一账号、SSH 登录、VTY 限源

**配置顺序**

1. **建本地用户** — 设置 privilege 与 service-type
   - 验证：`display aaa local-user`
2. **VTY 用 aaa 认证** — authentication-mode aaa + protocol inbound ssh
   - 验证：`display user-interface 0`
3. **VTY 限源 ACL** — 只允许管理网段登录
   - 验证：`display current-configuration | include acl`

**易错点**

- protocol inbound 未改 ssh 时 telnet 仍可登录
- ACL 把管理网段自己挡掉会锁死远程登录

## 进阶

### mstp-load-balance — MSTP 多实例负载分担

- **英文名**：MSTP multi-instance load sharing
- **来源**：eNSP HCNA Lab 3-2 延伸
- **设备**：2 核心 + 2 汇聚
- **目标**：不同 VLAN 走不同根桥，两条上行都承载流量

**配置顺序**

1. **统一域参数** — 域名、修订级别、实例-VLAN 映射必须全网一致
   - 验证：`display stp region-configuration`
2. **分实例设优先级** — 实例 1 核心 A 为根、实例 2 核心 B 为根
   - 验证：`display stp instance 1 brief`
3. **实例 0 显式指定** — 未映射 VLAN 落在 CIST，同样要指定根桥
   - 验证：`display stp instance 0 brief`

**易错点**

- 域参数不一致会退化成单实例，负载分担失效且无明显报错
- 只配实例 1/2 而忽略实例 0，管理 VLAN 可能二层割裂

### ospf-multi-area — OSPF 多区域与 ABR

- **英文名**：OSPF multi-area and ABR
- **来源**：eNSP 2-2 Multi-Area OSPF
- **设备**：4 台路由器
- **目标**：区域划分、ABR 路由汇总、区域间路由传播

**配置顺序**

1. **划分区域** — 骨干 area 0 必须连续；非骨干挂在 ABR 上
   - 验证：`display ospf brief`
2. **ABR 汇总** — 在 ABR 上对区域间路由做 abr-summary
   - 验证：`display ospf abr-asbr`
3. **验证区域间路由** — 其他区域应看到汇总路由而非明细
   - 验证：`display ip routing-table protocol ospf`

**易错点**

- 非骨干区域未连接 area 0 会导致路由不计算（需 virtual-link）
- 汇总掩码写错会连带屏蔽不该屏蔽的网段

### ospf-stub-nssa — OSPF 特殊区域（Stub / NSSA）

- **英文名**：OSPF stub and NSSA
- **来源**：eNSP 2-4 OSPF Stub Area and NSSA
- **设备**：3~4 台路由器
- **目标**：用特殊区域减少 LSA 泛洪；理解默认路由自动下发条件

**配置顺序**

1. **边缘区域设 stub** — 区域内所有路由器都要配 stub
   - 验证：`display ospf brief`
2. **需要引入外部路由时改 NSSA** — NSSA 允许 ASBR 存在，通过 Type-7 转换
3. **验证 LSA 类型** — stub 区域无 Type-5；NSSA 有 Type-7
   - 验证：`display ospf lsdb`

**易错点**

- 区域类型不一致会导致邻居无法建立
- stub 区域不能有 ASBR；需要引入时只能用 NSSA

### nat — NAT（源 NAT / NAT Server）

- **英文名**：NAT source and server
- **来源**：eNSP HCNA Lab 3-2
- **设备**：内网路由器 + 出口路由器 + 外部
- **目标**：内网访问外网、外网访问内网服务器

**配置顺序**

1. **写 ACL 匹配内网源** — permit 需要转换的源网段
   - 验证：`display acl`
2. **出口配 nat outbound** — 绑定 ACL；easy-ip 用接口地址
   - 验证：`display nat session all`
3. **发布服务器用 nat server** — 公网地址端口 -> 内网地址端口
4. **验证回程** — NAT 后需保证回程路由指向出口

**易错点**

- ACL 未命中则不做转换，且无报错
- NAT Server 后仍需要放行安全策略/ACL

### ppp-hdlc — HDLC 与 PPP（含 PPPoE）

- **英文名**：HDLC and PPP
- **来源**：eNSP HCNA Lab 2-1 / 2-3
- **设备**：2 台路由器（串口）
- **目标**：串口封装、PPP 认证、PPPoE 拨号

**配置顺序**

1. **设封装类型** — HDLC 为默认；PPP 支持认证与多链路
   - 验证：`display interface Serial`
2. **配置认证** — 一端 authenticator，另一端 pap/chap 用户名密码
   - 验证：`display ppp interface`
3. **PPPoE** — 服务端建 VT 与地址池，客户端 dialer 拨号
   - 验证：`display pppoe-client session summary`

**易错点**

- PPP 认证两端 pap/chap 不一致会反复协商失败
- 串口需先确认物理 up 且时钟配置正确

### ipv6 — IPv6 基础与路由

- **英文名**：IPv6 basics and routing
- **来源**：eNSP HCNA Lab 5-1
- **设备**：2~3 台路由器
- **目标**：IPv6 地址、邻居发现、静态/OSPFv3 路由

**配置顺序**

1. **全局启用 IPv6** — 接口下也要 ipv6 enable
   - 验证：`display ipv6 interface brief`
2. **配地址** — 可用链路本地 + 全球单播，或 address auto link-local
3. **路由** — 静态 ipv6 route 或 ospfv3
   - 验证：`display ipv6 routing-table`

**易错点**

- 只配 global 未在接口 enable ipv6，邻居发现不工作
- IPv6 无 ARP，ND 未通则 ping 不通

### wlan-basic — WLAN（AC + FIT AP）

- **英文名**：WLAN with AC and FIT AP
- **来源**：eNSP WLAN 实验
- **设备**：AC6005 + AP + 交换机
- **目标**：AP 上线、SSID 下发、终端接入

**配置顺序**

1. **AP 管理网段与 DHCP** — AP 需拿到地址并发现 AC（option 43 或同网段广播）
   - 验证：`display ap all`
2. **建安全/SSID/VAP 模板** — security-profile -> ssid-profile -> vap-profile
3. **绑定到 AP 组** — vap-profile 绑定 wlan 与 radio
   - 验证：`display vap ssid`

**易错点**

- AP 未上线通常是 DHCP option 43 或 CAPWAP 源地址未指定
- AC 与 AP 之间放行 CAPWAP（UDP 5246/5247）

### isis-multi-level — IS-IS 多级别与默认路由注入

- **英文名**：IS-IS levels and default-route injection
- **来源**：本项目实测验证（见 docs/SCENARIOS.md）
- **设备**：4 台路由器
- **目标**：L1/L2 分层，边界路由器隔离区域，L1 通过注入学默认路由

**配置顺序**

1. **规划 NET 与级别** — 同一区域用相同区域 ID；边界路由器 level-1-2
   - 验证：`display isis brief`
2. **配置 NET 并启用** — isis 进程下 network-entity，再在接口 isis enable
   - 验证：`display isis interface`
3. **注入默认路由** — L1 边缘路由器 default-route-advertise always level-1
   - 验证：`display ip routing-table`
4. **验证级别隔离** — L2 侧不应看到 L1 区域内部的默认路由注入
   - 验证：`display isis peer`

**易错点**

- NET 的 system-id 必须唯一，重复会导致邻居震荡
- 接口未 isis enable 时进程起来了但无邻居，且不报错
- 默认路由注入不带 level-1 限定会污染 L2

## 高级

### bgp-ebgp-ibgp — BGP EBGP / IBGP

- **英文名**：BGP peering
- **来源**：eNSP 3-1/3-2/3-3
- **设备**：3~4 台路由器
- **目标**：建立 EBGP 与 IBGP 邻居，理解 next-hop 与同步

**配置顺序**

1. **建 BGP 进程与 AS 号** — AS 号决定 EBGP/IBGP 关系
   - 验证：`display bgp peer`
2. **配置 peer** — IBGP 常用 loopback + update-source；EBGP 用直连口
   - 验证：`display bgp peer verbose`
3. **宣告网段** — network 只能宣告路由表中存在的精确网段
4. **处理下一跳** — IBGP 需 next-hop-local，否则路由不可达
   - 验证：`display bgp routing-table`

**易错点**

- IBGP 邻居未 update-source 到 loopback 时，源地址不匹配会卡在 Connect
- network 宣告的网段路由表里不存在则不会发布，且无提示

### bgp-route-reflector — BGP 路由反射器与联盟

- **英文名**：BGP route reflector and confederation
- **来源**：eNSP 3-7 / 3-8
- **设备**：4~5 台路由器
- **目标**：解决 IBGP 全互联问题

**配置顺序**

1. **选 RR** — 在 RR 上把客户端指定为 reflector-client
   - 验证：`display bgp peer`
2. **验证反射** — 客户端之间无需直连即可学到路由
   - 验证：`display bgp routing-table`
3. **可选：联盟** — 大 AS 拆子 AS，跨子 AS 仍是 IBGP 语义

**易错点**

- RR 的 cluster-id 冲突会造成环路防护误判
- 客户端配置遗漏则路由不会反射

### ipsec-vpn — IPsec VPN

- **英文名**：IPsec VPN
- **来源**：eNSP HCNA Lab 3-4
- **设备**：2 台出口路由器
- **目标**：两端私网通过公网安全互通

**配置顺序**

1. **定义感兴趣流** — ACL 匹配两端私网互访
2. **配置 IKE 提议与 keychain** — 两端参数必须完全一致
   - 验证：`display ike sa`
3. **配置 IPsec 提议与策略** — 封装模式、协议、算法两端一致
   - 验证：`display ipsec sa`
4. **应用到接口** — 在公网出接口引用策略
   - 验证：`display ipsec policy`

**易错点**

- 两端提议任一参数不一致则 IKE 阶段就失败
- ACL 匹配范围不对会导致部分流量不走隧道

### campus-network — 园区网综合（双核心 + 接入 + 出口）

- **英文名**：Campus network (dual core, access, edge)
- **来源**：eNSP Campus_Network
- **设备**：10+ 台设备
- **目标**：把 VLAN、MSTP、VRRP、OSPF、NAT、ACL 组合成可运行园区网

**配置顺序**

1. **先二层后三层** — VLAN/Trunk/聚合先通，再上 Vlanif 与路由
   - 验证：`display vlan`
2. **网关冗余** — 核心间 VRRP，优先级配合 track 上行口
   - 验证：`display vrrp`
3. **路由** — 核心到出口 OSPF 或静态，出口默认路由
   - 验证：`display ip routing-table`
4. **边界** — NAT + ACL，内网出网与外网发布
   - 验证：`display nat session all`
5. **可靠性验证** — 逐项断开：核心、上行、出口、专线
   - 验证：`display vrrp / display stp brief`

**易错点**

- 先配三层再配二层会导致 Vlanif 反复 up/down
- 双核心未做 VRRP 优先级与 track 会产生双主
