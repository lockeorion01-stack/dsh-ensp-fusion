/**
 * Scenario presets.
 *
 * ## Why these are skeletons, not command dumps
 *
 * Every preset here answers three questions and stops:
 *
 *   1. **What changes on the devices** — the objects to create (VLANs, areas,
 *      peers, pools…), so the shape of the work is obvious.
 *   2. **In what order** — VRP rejects commands that reference objects which do not
 *      exist yet, so the order is the part people actually get wrong.
 *   3. **How to prove it worked** — the `display` command whose output settles the
 *      question.
 *
 * The literal commands are deliberately absent. Copying a blind command block is
 * what produces the failures this project exists to catch (wrong wildcard mask,
 * a `system-view` inside system view, an interface number the model does not
 * have). A skeleton plus a verification command lets the operator — human or
 * model — fill in two or three lines with full awareness of the target device.
 *
 * This also keeps the package small and keeps the model's context free for the
 * task itself rather than for hundreds of lines of boilerplate.
 *
 * ## Provenance
 *
 * The catalogue mirrors the labs Huawei ships with eNSP
 * (`eNSP/examples/**`, 40 topologies) plus the scenarios this project has verified
 * against a live simulator. `docs/SCENARIOS.md` documents each entry; the tables
 * below are the machine-readable form.
 *
 * @module dsh-ensp/presets
 */

/**
 * A step is an ordered instruction, not a command:
 * `{ do, detail?, verify? }`.
 *
 * `do` names the object being configured; `detail` narrows it; `verify` is the
 * command whose output confirms the step.
 */
export const SCENARIOS = {
  // ---------------------------------------------------------------- switching
  'vlan-access': {
    title: 'VLAN 与 Access 端口',
    titleEn: 'VLAN and access ports',
    level: 'basic',
    source: 'eNSP HCNA Lab 1-2',
    devices: '1 台二层交换机 + 若干 PC',
    goal: '把不同端口划进不同 VLAN，同 VLAN 可通、跨 VLAN 不通',
    steps: [
      { do: '创建 VLAN', detail: '按部门规划 VLAN ID，先创建再划端口', verify: 'display vlan' },
      { do: '端口改为 access', detail: '每个接入口设置 link-type access 并指定 PVID', verify: 'display port vlan active' },
      { do: '验证隔离', detail: '同 VLAN PC 互通；跨 VLAN 应不通（无需路由）' },
    ],
    pitfalls: [
      '端口默认是 hybrid，直接设 PVID 不会让 VLAN 生效，必须先改 access',
      'trunk 口不要设 access，否则会把上行打断',
    ],
  },

  'trunk-interconnect': {
    title: 'Trunk 互联与多 VLAN 透传',
    titleEn: 'Trunk interconnect',
    level: 'basic',
    source: 'eNSP HCNA Lab 1-2 / 1-4',
    devices: '2 台交换机 + PC',
    goal: '跨交换机同 VLAN 通信，VLAN 通过 trunk 携带',
    steps: [
      { do: '两端建同名 VLAN', detail: 'VLAN 必须两端都存在，否则帧被丢弃', verify: 'display vlan' },
      { do: '互联口设 trunk', detail: '放行所需 VLAN；PVID 保持默认 1', verify: 'display port vlan active' },
      { do: '接入口设 access', detail: '按 VLAN 划分' },
    ],
    pitfalls: ['trunk 未放行目标 VLAN 时静默丢帧，无报错', 'PVID 与 access VLAN 混淆会导致本征 VLAN 错乱'],
  },

  'vlanif-routing': {
    title: 'VLAN 间路由（三层交换机）',
    titleEn: 'Inter-VLAN routing with a layer-3 switch',
    level: 'basic',
    source: 'eNSP HCNA Lab 1-4 / 1-5',
    devices: '三层交换机 + PC',
    goal: '每个 VLAN 一个网关，VLAN 间可路由',
    steps: [
      { do: '建 VLAN 与 access 端口', detail: '先二层通，再上三层' },
      { do: '创建 Vlanif 并配地址', detail: '一个 VLAN 一个 Vlanif，地址即该网段网关', verify: 'display ip interface brief' },
      { do: '验证', detail: '不同 VLAN 的 PC 互 ping，网关应可达' },
    ],
    pitfalls: ['Vlanif 的 up 依赖该 VLAN 下至少一个 up 的端口', '忘记给 PC 配网关则跨网段必然不通'],
  },

  'stp-rstp': {
    title: 'STP / RSTP 生成树',
    titleEn: 'STP and RSTP',
    level: 'basic',
    source: 'eNSP HCNA Lab 3-1 / 3-2',
    devices: '3 台交换机成环',
    goal: '破除二层环路，观察根桥、端口角色与收敛',
    steps: [
      { do: '选根桥', detail: '核心设最低优先级，其余保持默认', verify: 'display stp' },
      { do: '选择模式', detail: 'RSTP 收敛更快；MSTP 用于多实例场景' },
      { do: '观察端口角色', detail: '根端口 / 指定端口 / 阻塞端口', verify: 'display stp brief' },
      { do: '断链验证', detail: '断一条链路，阻塞口应在数秒内转为转发' },
    ],
    pitfalls: ['所有交换机优先级相同则靠 MAC 选根桥，结果不可控', '边缘端口未开 edged-port 会让接终端时反复重收敛'],
  },

  'mstp-load-balance': {
    title: 'MSTP 多实例负载分担',
    titleEn: 'MSTP multi-instance load sharing',
    level: 'intermediate',
    source: 'eNSP HCNA Lab 3-2 延伸',
    devices: '2 核心 + 2 汇聚',
    goal: '不同 VLAN 走不同根桥，两条上行都承载流量',
    steps: [
      { do: '统一域参数', detail: '域名、修订级别、实例-VLAN 映射必须全网一致', verify: 'display stp region-configuration' },
      { do: '分实例设优先级', detail: '实例 1 核心 A 为根、实例 2 核心 B 为根', verify: 'display stp instance 1 brief' },
      { do: '实例 0 显式指定', detail: '未映射 VLAN 落在 CIST，同样要指定根桥', verify: 'display stp instance 0 brief' },
    ],
    pitfalls: [
      '域参数不一致会退化成单实例，负载分担失效且无明显报错',
      '只配实例 1/2 而忽略实例 0，管理 VLAN 可能二层割裂',
    ],
  },

  'link-aggregation': {
    title: '链路聚合 Eth-Trunk',
    titleEn: 'Link aggregation',
    level: 'basic',
    source: 'eNSP 常规实验',
    devices: '2 台交换机 + 2 条互联线',
    goal: '多条物理链路聚合成一条逻辑链路，提高带宽并提供冗余',
    steps: [
      { do: '建 Eth-Trunk', detail: '选 LACP 静态模式，两端必须一致', verify: 'display eth-trunk' },
      { do: '加入成员口', detail: '成员口不能单独配 IP 或 VLAN', verify: 'display eth-trunk 1' },
      { do: '在聚合口上配业务', detail: 'trunk / access 都配在 Eth-Trunk 上，不配在成员口' },
    ],
    pitfalls: ['两端模式不一致（lacp-static vs manual）聚合不 up', '成员口速率/双工不一致会只有部分成员 Selected'],
  },

  // ---------------------------------------------------------------- IP services
  'static-route': {
    title: '静态路由与默认路由',
    titleEn: 'Static and default routes',
    level: 'basic',
    source: 'eNSP HCNA Lab 4-1',
    devices: '2~3 台路由器',
    goal: '手工打通非直连网段，并用默认路由简化边缘配置',
    steps: [
      { do: '配接口地址', detail: '先保证直连可达', verify: 'display ip interface brief' },
      { do: '写明细静态路由', detail: '目的网段 + 掩码 + 下一跳', verify: 'display ip routing-table' },
      { do: '边缘用默认路由', detail: '0.0.0.0/0 指向出口，避免逐条写明细' },
      { do: '备份用浮动静态', detail: '同一目的写两条，备路由 preference 调高', verify: 'display ip routing-table protocol static' },
    ],
    pitfalls: [
      '下一跳必须直连可达，否则路由不进路由表（inactive）',
      '掩码写错会让目的网段归一化成别的网段，形成意外覆盖或冲突',
    ],
  },

  'rip': {
    title: 'RIPv1 / RIPv2',
    titleEn: 'RIP versions 1 and 2',
    level: 'basic',
    source: 'eNSP HCNA Lab 4-2 / 4-3',
    devices: '3 台路由器',
    goal: '用距离矢量协议自动学习路由；对比 v1 有类与 v2 无类的差别',
    steps: [
      { do: '启动 RIP 进程', detail: '指定版本；v2 支持子网与认证', verify: 'display rip' },
      { do: 'network 宣告', detail: 'v1 按主类宣告，v2 可带掩码；宣告的是直连网段' },
      { do: '可选：认证与聚合', detail: 'v2 支持明文/MD5 认证和手动聚合', verify: 'display rip route' },
    ],
    pitfalls: ['v1 不做子网掩码，遇到不连续子网会出错', 'network 写错网段则接口不参与，邻居起不来'],
  },

  'ospf-single': {
    title: 'OSPF 单区域',
    titleEn: 'OSPF single area',
    level: 'basic',
    source: 'eNSP HCNA Lab 4-4',
    devices: '3~4 台路由器',
    goal: '单区域 OSPF 邻居建立与路由学习',
    steps: [
      { do: '建 OSPF 进程', detail: '指定 router-id，建议显式配置避免选举不确定', verify: 'display ospf peer' },
      { do: 'area 0 内 network', detail: '宣告直连网段；通配符是反掩码' },
      { do: '调整 cost 或带宽', detail: '影响选路；默认按接口带宽计算', verify: 'display ospf interface' },
      { do: '验证', detail: '邻居 FULL、路由表出现远端网段', verify: 'display ip routing-table protocol ospf' },
    ],
    pitfalls: [
      '反掩符写错（写成子网掩码）会宣告错网段',
      '邻居卡在 2-Way 通常是 DR 选举正常但网络类型不匹配',
    ],
  },

  'ospf-multi-area': {
    title: 'OSPF 多区域与 ABR',
    titleEn: 'OSPF multi-area and ABR',
    level: 'intermediate',
    source: 'eNSP 2-2 Multi-Area OSPF',
    devices: '4 台路由器',
    goal: '区域划分、ABR 路由汇总、区域间路由传播',
    steps: [
      { do: '划分区域', detail: '骨干 area 0 必须连续；非骨干挂在 ABR 上', verify: 'display ospf brief' },
      { do: 'ABR 汇总', detail: '在 ABR 上对区域间路由做 abr-summary', verify: 'display ospf abr-asbr' },
      { do: '验证区域间路由', detail: '其他区域应看到汇总路由而非明细', verify: 'display ip routing-table protocol ospf' },
    ],
    pitfalls: ['非骨干区域未连接 area 0 会导致路由不计算（需 virtual-link）', '汇总掩码写错会连带屏蔽不该屏蔽的网段'],
  },

  'ospf-stub-nssa': {
    title: 'OSPF 特殊区域（Stub / NSSA）',
    titleEn: 'OSPF stub and NSSA',
    level: 'intermediate',
    source: 'eNSP 2-4 OSPF Stub Area and NSSA',
    devices: '3~4 台路由器',
    goal: '用特殊区域减少 LSA 泛洪；理解默认路由自动下发条件',
    steps: [
      { do: '边缘区域设 stub', detail: '区域内所有路由器都要配 stub', verify: 'display ospf brief' },
      { do: '需要引入外部路由时改 NSSA', detail: 'NSSA 允许 ASBR 存在，通过 Type-7 转换' },
      { do: '验证 LSA 类型', detail: 'stub 区域无 Type-5；NSSA 有 Type-7', verify: 'display ospf lsdb' },
    ],
    pitfalls: ['区域类型不一致会导致邻居无法建立', 'stub 区域不能有 ASBR；需要引入时只能用 NSSA'],
  },

  'bgp-ebgp-ibgp': {
    title: 'BGP EBGP / IBGP',
    titleEn: 'BGP peering',
    level: 'advanced',
    source: 'eNSP 3-1/3-2/3-3',
    devices: '3~4 台路由器',
    goal: '建立 EBGP 与 IBGP 邻居，理解 next-hop 与同步',
    steps: [
      { do: '建 BGP 进程与 AS 号', detail: 'AS 号决定 EBGP/IBGP 关系', verify: 'display bgp peer' },
      { do: '配置 peer', detail: 'IBGP 常用 loopback + update-source；EBGP 用直连口', verify: 'display bgp peer verbose' },
      { do: '宣告网段', detail: 'network 只能宣告路由表中存在的精确网段' },
      { do: '处理下一跳', detail: 'IBGP 需 next-hop-local，否则路由不可达', verify: 'display bgp routing-table' },
    ],
    pitfalls: [
      'IBGP 邻居未 update-source 到 loopback 时，源地址不匹配会卡在 Connect',
      'network 宣告的网段路由表里不存在则不会发布，且无提示',
    ],
  },

  'bgp-route-reflector': {
    title: 'BGP 路由反射器与联盟',
    titleEn: 'BGP route reflector and confederation',
    level: 'advanced',
    source: 'eNSP 3-7 / 3-8',
    devices: '4~5 台路由器',
    goal: '解决 IBGP 全互联问题',
    steps: [
      { do: '选 RR', detail: '在 RR 上把客户端指定为 reflector-client', verify: 'display bgp peer' },
      { do: '验证反射', detail: '客户端之间无需直连即可学到路由', verify: 'display bgp routing-table' },
      { do: '可选：联盟', detail: '大 AS 拆子 AS，跨子 AS 仍是 IBGP 语义' },
    ],
    pitfalls: ['RR 的 cluster-id 冲突会造成环路防护误判', '客户端配置遗漏则路由不会反射'],
  },

  // ---------------------------------------------------------------- services
  'dhcp': {
    title: 'DHCP 服务（含中继）',
    titleEn: 'DHCP server and relay',
    level: 'basic',
    source: 'eNSP HCNA Lab 5-2',
    devices: '1 台路由器/交换机作 DHCP + PC',
    goal: '自动分配地址；跨网段时用中继',
    steps: [
      { do: '启用 DHCP', detail: '全局 dhcp enable 必须先做', verify: 'display dhcp server statistics' },
      { do: '建地址池', detail: 'network、gateway-list、dns-list', verify: 'display ip pool' },
      { do: '接口绑定', detail: '本网段用 dhcp select global/interface；跨网段加 dhcp relay', verify: 'display dhcp relay' },
    ],
    pitfalls: [
      '地址池建了但接口没绑 dhcp select，客户端拿不到地址（静默失败）',
      '中继场景下 DHCP 服务器必须有回程路由到客户端网段',
    ],
  },

  'nat': {
    title: 'NAT（源 NAT / NAT Server）',
    titleEn: 'NAT source and server',
    level: 'intermediate',
    source: 'eNSP HCNA Lab 3-2',
    devices: '内网路由器 + 出口路由器 + 外部',
    goal: '内网访问外网、外网访问内网服务器',
    steps: [
      { do: '写 ACL 匹配内网源', detail: 'permit 需要转换的源网段', verify: 'display acl' },
      { do: '出口配 nat outbound', detail: '绑定 ACL；easy-ip 用接口地址', verify: 'display nat session all' },
      { do: '发布服务器用 nat server', detail: '公网地址端口 -> 内网地址端口' },
      { do: '验证回程', detail: 'NAT 后需保证回程路由指向出口' },
    ],
    pitfalls: ['ACL 未命中则不做转换，且无报错', 'NAT Server 后仍需要放行安全策略/ACL'],
  },

  'acl-filter': {
    title: 'ACL 访问控制',
    titleEn: 'ACL filtering',
    level: 'basic',
    source: 'eNSP HCNA Lab 3-1',
    devices: '2 台路由器',
    goal: '按源/目的/协议精确放行或拒绝',
    steps: [
      { do: '选 ACL 类型', detail: '基本(2000-2999)只看源；高级(3000-3999)看五元组' },
      { do: '写规则并注意顺序', detail: '精确匹配在前、宽泛规则在后；默认末尾隐含拒绝', verify: 'display acl 3000' },
      { do: '应用到接口方向', detail: 'inbound 是进入接口的流量；方向选反等于不生效', verify: 'display traffic-filter applied-record' },
    ],
    pitfalls: [
      '反掩码（通配符）写错会连带放行/拒绝相邻网段',
      '方向选反是静默失效，接口计数不增长',
    ],
  },

  'aaa-local': {
    title: '本地 AAA 与设备登录',
    titleEn: 'Local AAA and device login',
    level: 'basic',
    source: 'eNSP HCNA Lab 3-3',
    devices: '任意设备',
    goal: '统一账号、SSH 登录、VTY 限源',
    steps: [
      { do: '建本地用户', detail: '设置 privilege 与 service-type', verify: 'display aaa local-user' },
      { do: 'VTY 用 aaa 认证', detail: 'authentication-mode aaa + protocol inbound ssh', verify: 'display user-interface 0' },
      { do: 'VTY 限源 ACL', detail: '只允许管理网段登录', verify: 'display current-configuration | include acl' },
    ],
    pitfalls: ['protocol inbound 未改 ssh 时 telnet 仍可登录', 'ACL 把管理网段自己挡掉会锁死远程登录'],
  },

  'ipsec-vpn': {
    title: 'IPsec VPN',
    titleEn: 'IPsec VPN',
    level: 'advanced',
    source: 'eNSP HCNA Lab 3-4',
    devices: '2 台出口路由器',
    goal: '两端私网通过公网安全互通',
    steps: [
      { do: '定义感兴趣流', detail: 'ACL 匹配两端私网互访' },
      { do: '配置 IKE 提议与 keychain', detail: '两端参数必须完全一致', verify: 'display ike sa' },
      { do: '配置 IPsec 提议与策略', detail: '封装模式、协议、算法两端一致', verify: 'display ipsec sa' },
      { do: '应用到接口', detail: '在公网出接口引用策略', verify: 'display ipsec policy' },
    ],
    pitfalls: ['两端提议任一参数不一致则 IKE 阶段就失败', 'ACL 匹配范围不对会导致部分流量不走隧道'],
  },

  'ppp-hdlc': {
    title: 'HDLC 与 PPP（含 PPPoE）',
    titleEn: 'HDLC and PPP',
    level: 'intermediate',
    source: 'eNSP HCNA Lab 2-1 / 2-3',
    devices: '2 台路由器（串口）',
    goal: '串口封装、PPP 认证、PPPoE 拨号',
    steps: [
      { do: '设封装类型', detail: 'HDLC 为默认；PPP 支持认证与多链路', verify: 'display interface Serial' },
      { do: '配置认证', detail: '一端 authenticator，另一端 pap/chap 用户名密码', verify: 'display ppp interface' },
      { do: 'PPPoE', detail: '服务端建 VT 与地址池，客户端 dialer 拨号', verify: 'display pppoe-client session summary' },
    ],
    pitfalls: ['PPP 认证两端 pap/chap 不一致会反复协商失败', '串口需先确认物理 up 且时钟配置正确'],
  },

  'ipv6': {
    title: 'IPv6 基础与路由',
    titleEn: 'IPv6 basics and routing',
    level: 'intermediate',
    source: 'eNSP HCNA Lab 5-1',
    devices: '2~3 台路由器',
    goal: 'IPv6 地址、邻居发现、静态/OSPFv3 路由',
    steps: [
      { do: '全局启用 IPv6', detail: '接口下也要 ipv6 enable', verify: 'display ipv6 interface brief' },
      { do: '配地址', detail: '可用链路本地 + 全球单播，或 address auto link-local' },
      { do: '路由', detail: '静态 ipv6 route 或 ospfv3', verify: 'display ipv6 routing-table' },
    ],
    pitfalls: ['只配 global 未在接口 enable ipv6，邻居发现不工作', 'IPv6 无 ARP，ND 未通则 ping 不通'],
  },

  'wlan-basic': {
    title: 'WLAN（AC + FIT AP）',
    titleEn: 'WLAN with AC and FIT AP',
    level: 'intermediate',
    source: 'eNSP WLAN 实验',
    devices: 'AC6005 + AP + 交换机',
    goal: 'AP 上线、SSID 下发、终端接入',
    steps: [
      { do: 'AP 管理网段与 DHCP', detail: 'AP 需拿到地址并发现 AC（option 43 或同网段广播）', verify: 'display ap all' },
      { do: '建安全/SSID/VAP 模板', detail: 'security-profile -> ssid-profile -> vap-profile' },
      { do: '绑定到 AP 组', detail: 'vap-profile 绑定 wlan 与 radio', verify: 'display vap ssid' },
    ],
    pitfalls: ['AP 未上线通常是 DHCP option 43 或 CAPWAP 源地址未指定', 'AC 与 AP 之间放行 CAPWAP（UDP 5246/5247）'],
  },

  'isis-multi-level': {
    title: 'IS-IS 多级别与默认路由注入',
    titleEn: 'IS-IS levels and default-route injection',
    level: 'intermediate',
    source: '本项目实测验证（见 docs/SCENARIOS.md）',
    devices: '4 台路由器',
    goal: 'L1/L2 分层，边界路由器隔离区域，L1 通过注入学默认路由',
    steps: [
      { do: '规划 NET 与级别', detail: '同一区域用相同区域 ID；边界路由器 level-1-2', verify: 'display isis brief' },
      { do: '配置 NET 并启用', detail: 'isis 进程下 network-entity，再在接口 isis enable', verify: 'display isis interface' },
      { do: '注入默认路由', detail: 'L1 边缘路由器 default-route-advertise always level-1', verify: 'display ip routing-table' },
      { do: '验证级别隔离', detail: 'L2 侧不应看到 L1 区域内部的默认路由注入', verify: 'display isis peer' },
    ],
    pitfalls: [
      'NET 的 system-id 必须唯一，重复会导致邻居震荡',
      '接口未 isis enable 时进程起来了但无邻居，且不报错',
      '默认路由注入不带 level-1 限定会污染 L2',
    ],
  },

  'campus-network': {
    title: '园区网综合（双核心 + 接入 + 出口）',
    titleEn: 'Campus network (dual core, access, edge)',
    level: 'advanced',
    source: 'eNSP Campus_Network',
    devices: '10+ 台设备',
    goal: '把 VLAN、MSTP、VRRP、OSPF、NAT、ACL 组合成可运行园区网',
    steps: [
      { do: '先二层后三层', detail: 'VLAN/Trunk/聚合先通，再上 Vlanif 与路由', verify: 'display vlan' },
      { do: '网关冗余', detail: '核心间 VRRP，优先级配合 track 上行口', verify: 'display vrrp' },
      { do: '路由', detail: '核心到出口 OSPF 或静态，出口默认路由', verify: 'display ip routing-table' },
      { do: '边界', detail: 'NAT + ACL，内网出网与外网发布', verify: 'display nat session all' },
      { do: '可靠性验证', detail: '逐项断开：核心、上行、出口、专线', verify: 'display vrrp / display stp brief' },
    ],
    pitfalls: [
      '先配三层再配二层会导致 Vlanif 反复 up/down',
      '双核心未做 VRRP 优先级与 track 会产生双主',
    ],
  },
}

/** All scenario ids, in a sensible reading order. */
export const SCENARIO_IDS = Object.keys(SCENARIOS)

/** Scenarios grouped by difficulty, for display. */
export function byLevel() {
  const groups = { basic: [], intermediate: [], advanced: [] }
  for (const [id, s] of Object.entries(SCENARIOS)) groups[s.level]?.push(id)
  return groups
}

/**
 * Render one scenario as a compact brief.
 *
 * This is the text handed to a model or printed by `ensp preset <id>`: short
 * enough to keep context free, specific enough to act on.
 *
 * @param {string} id
 * @returns {string}
 */
export function renderScenario(id) {
  const s = SCENARIOS[id]
  if (!s) throw new Error(`unknown scenario "${id}"; known: ${SCENARIO_IDS.join(', ')}`)

  const lines = [
    `# ${s.title} (${s.titleEn})`,
    `来源: ${s.source} | 难度: ${s.level} | 设备: ${s.devices}`,
    `目标: ${s.goal}`,
    '',
    '## 配置顺序（只给方向，具体命令按设备补全）',
    ...s.steps.map((step, i) => {
      const detail = step.detail ? ` — ${step.detail}` : ''
      const verify = step.verify ? `\n   验证: ${step.verify}` : ''
      return `${i + 1}. ${step.do}${detail}${verify}`
    }),
  ]

  if (s.pitfalls?.length) {
    lines.push('', '## 易错点')
    for (const p of s.pitfalls) lines.push(`- ${p}`)
  }
  return lines.join('\n')
}

/**
 * Search scenarios by keyword across title, goal and steps.
 *
 * @param {string} query
 * @returns {Array<{id: string, title: string, level: string, goal: string}>}
 */
export function searchScenarios(query) {
  const q = query.toLowerCase()
  const hits = []
  for (const [id, s] of Object.entries(SCENARIOS)) {
    const haystack = [id, s.title, s.titleEn, s.goal, ...(s.steps ?? []).map((x) => x.do)]
      .join(' ')
      .toLowerCase()
    if (haystack.includes(q)) {
      hits.push({ id, title: s.title, level: s.level, goal: s.goal })
    }
  }
  return hits
}
