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

  'port-security': {
    title: '端口安全与 MAC 限制',
    titleEn: 'Port security and MAC limits',
    level: 'basic',
    source: 'eNSP 常规实验',
    devices: '1 台交换机 + 2 PC + 1 台非法终端',
    goal: '限制端口可学习的 MAC 数量，非法接入时丢包、告警或关闭端口',
    steps: [
      { do: '开启端口安全', detail: '接口下 port-security enable，默认只允许 1 个 MAC', verify: 'display port-security' },
      { do: '选择学习方式', detail: 'sticky 粘滞学习自动转成静态表项；或手工 mac-address static 绑定' },
      { do: '设违规动作', detail: 'protect 只丢包、restrict 丢包并告警、shutdown 直接关闭端口' },
      { do: '验证', detail: '换一台 PC 接入，观察丢包/告警/端口 down 是否符合预期' },
    ],
    pitfalls: [
      '默认动作是 protect，只丢包不告警，容易误判为没生效',
      '粘滞 MAC 已写入配置后换设备接入会学不到新 MAC，需先清 port-security mac-address sticky',
      'shutdown 动作需 error-down auto-recovery 或手工 undo shutdown 才能恢复',
    ],
  },

  'port-isolation': {
    title: '端口隔离与 MUX VLAN',
    titleEn: 'Port isolation and MUX VLAN',
    level: 'basic',
    source: 'eNSP 常规实验',
    devices: '1 台交换机 + 3 PC',
    goal: '同一 VLAN 内用户互不通信，但都能访问网关与服务器',
    steps: [
      { do: '配端口隔离组', detail: '接入端口加入 port-isolate group，同组之间二层不通', verify: 'display port-isolate group' },
      { do: '上行口与服务器口不入组', detail: '隔离只作用于同组端口，未入组的口仍可双向访问' },
      { do: '需要跨设备隔离时用 MUX VLAN', detail: 'principal VLAN 对接上行，separate VLAN 完全隔离，group VLAN 内互通' },
      { do: '验证', detail: '同组 PC 互 ping 不通，各自都能 ping 网关' },
    ],
    pitfalls: [
      '端口隔离只在单台交换机内生效，跨设备要靠 VLAN 划分或 MUX VLAN',
      'MUX VLAN 中 separate 与 group 的语义容易配反，导致该通的通不了、该隔离的没隔离',
      '把上行口也加进隔离组会切断所有人的网关访问',
    ],
  },

  'super-vlan': {
    title: 'VLAN 聚合（Super-VLAN）',
    titleEn: 'Super-VLAN and sub-VLANs',
    level: 'basic',
    source: 'eNSP 常规实验',
    devices: '1 台三层交换机 + PC',
    goal: '多个子 VLAN 共用一个网关地址，节省 IP 网段',
    steps: [
      { do: '建子 VLAN', detail: '子 VLAN 只作二层划分，不建 Vlanif' },
      { do: '建 Super-VLAN 并关联子 VLAN', detail: 'aggregate-vlan 指定主 VLAN，access-vlan 列出子 VLAN', verify: 'display vlan' },
      { do: '只在 Super-VLAN 上建 Vlanif', detail: '该地址同时是所有子 VLAN 的网关' },
      { do: '验证', detail: '不同子 VLAN 的主机同网段，可直接互通' },
    ],
    pitfalls: [
      'Super-VLAN 的 Vlanif 上不能再挂物理 access 口，否则冲突',
      '给子 VLAN 也建 Vlanif 会直接报错或造成地址冲突',
      'Super-VLAN 本身不做隔离，需要隔离要再配合端口隔离',
    ],
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

  'ospf-lsa-types': {
    title: 'OSPF LSA 类型与区域过滤',
    titleEn: 'OSPF LSA types and area filtering',
    level: 'intermediate',
    source: 'eNSP 2-3 OSPF Adjacency Relationships and Various Types of LSAs',
    devices: '4 台路由器（骨干 + 两个非骨干区域）',
    goal: '观察 Type-1/2/3/4/5/7 的产生位置与泛洪范围，并在 ABR 上过滤区域间路由',
    steps: [
      { do: '建立多区域拓扑', detail: '两台 ABR 各挂一个非骨干区域，其中一侧引入外部路由', verify: 'display ospf brief' },
      { do: '逐个区域看 LSDB', detail: '区域内看 Type-1/2；ABR 上额外有 Type-3；ASBR 所在区域有 Type-5', verify: 'display ospf lsdb' },
      { do: '观察 ASBR 与外部路由', detail: 'Type-4 描述 ASBR 位置，由 ABR 产生；Type-5 携带外部网段', verify: 'display ospf lsdb ase' },
      { do: 'NSSA 场景看 Type-7', detail: 'NSSA 内引入的外部路由先以 Type-7 存在，由 ABR 转换成 Type-5', verify: 'display ospf lsdb nssa' },
      { do: '在 ABR 上过滤 Type-3', detail: 'filter import/export 配合 ACL 或 ip-prefix，只影响区域间路由', verify: 'display ospf lsdb summary' },
    ],
    pitfalls: [
      'Type-3 只有 ABR 会产生，普通区域内的路由器看不到也不会转发',
      'Type-5 不进 stub 区域，这是 stub 的本意；想带外部路由只能用 NSSA',
      'filter 只过滤区域间（Type-3），对区域内和外部路由无效',
      'abr-summary not-advertise 与 filter deny 效果相似但粒度不同，混用会互相抵消',
    ],
  },

  'ospf-virtual-link': {
    title: 'OSPF 虚连接',
    titleEn: 'OSPF virtual link',
    level: 'intermediate',
    source: 'eNSP 2-5 OSPF VCs and Inter-Area Route Filtering',
    devices: '4 台路由器（一个区域被割裂）',
    goal: '让未直连骨干区域的区域通过 transit 区域接入 area 0',
    steps: [
      { do: '确认割裂点', detail: '非骨干区域两侧都没有物理接口在 area 0 内', verify: 'display ospf brief' },
      { do: '两端 ABR 配 vlink-peer', detail: '指向对端 router-id，不是接口地址；两端都要配', verify: 'display ospf vlink' },
      { do: '确认 transit 区域是普通区域', detail: '虚连接只能穿过普通区域，不能穿 stub 或 NSSA' },
      { do: '验证区域间路由恢复', detail: '割裂侧应重新学到 Type-3 路由', verify: 'display ip routing-table protocol ospf' },
    ],
    pitfalls: [
      'vlink-peer 填成接口 IP 而不是 router-id，虚连接起不来',
      '只配一端：状态会停在 INIT 或 DOWN',
      '用 stub 区域当 transit 会直接报错，特殊区域不能承载虚连接',
      '虚连接是过渡手段，物理上补齐 area 0 直连才是正规做法',
    ],
  },

  'ospf-troubleshooting': {
    title: 'OSPF 邻居排障',
    titleEn: 'OSPF neighbour troubleshooting',
    level: 'intermediate',
    source: 'eNSP 2-6 OSPF Troubleshooting / 本项目实测',
    devices: '2~3 台路由器',
    goal: '按状态机逐层定位邻居建立失败的原因',
    steps: [
      { do: '先读状态', detail: 'Down 无 Hello；Init 单向收到；2-Way 正常但不是 DR/BDR；ExStart 卡在 DD 交换', verify: 'display ospf peer' },
      { do: '查 Hello 参数', detail: '区域号、hello/dead 定时器、认证、网络类型、掩码（broadcast 下要求同掩码）必须一致', verify: 'display ospf interface' },
      { do: '查报文层错误', detail: 'MTU 不一致会让 DD 交换卡在 ExStart；ACL 挡 224.0.0.5/224.0.0.6 会让邻居根本起不来', verify: 'display ospf error' },
      { do: '确认接口 MTU', detail: '两侧 MTU 必须相等；也可用 ospf mtu-enable 让 DD 携带 MTU 并显式报错', verify: 'display interface GigabitEthernet0/0/0 | include MTU' },
      { do: '确认直连可达', detail: 'ping 对端接口地址通不通，不通则先解决二层或地址问题' },
    ],
    pitfalls: [
      'ExStart 卡住最常见原因是 MTU 不一致，但 display ospf peer 不会直接告诉你是 MTU',
      '2-Way 在点到点场景可能正常，在 broadcast 场景说明双方都是 DR-Other，需要看 DR 是否已选出',
      '改完参数邻居不会立刻重建，undo 掉进程或 shutdown 接口再开更快',
      '掩码不一致在 broadcast 网络会直接导致邻居关系无法建立，且报错信息很含糊',
    ],
  },

  'bgp-attributes': {
    title: 'BGP 选路属性',
    titleEn: 'BGP attributes and path selection',
    level: 'advanced',
    source: 'eNSP 3-3 / 3-4 BGP Attributes and Path Selection',
    devices: '4 台路由器（两个 AS，含一台双出口路由器）',
    goal: '用 local-preference、AS_PATH、MED 分别影响入向和出向选路',
    steps: [
      { do: '造出多条等价路径', detail: '同一前缀从两个方向学到，先确认 BGP 表里有多条 candidate', verify: 'display bgp routing-table' },
      { do: '影响入向：local-preference', detail: '值大优先，只在 IBGP 内传递，用于让本 AS 偏好某个入口' },
      { do: '影响出向：AS_PATH prepend', detail: '在不想被选中的方向重复本 AS 号，让对端觉得这条更长' },
      { do: '影响出向：MED', detail: '值小优先，可跨 EBGP 传递，但对端不一定采纳' },
      { do: '看清比较顺序', detail: 'weight > local-preference > 本地始发 > AS_PATH 长度 > origin > MED > EBGP 优于 IBGP > IGP cost > router-id', verify: 'display bgp routing-table 10.0.0.0' },
    ],
    pitfalls: [
      'weight 是本机私有属性，不传递，配错方向时完全没效果',
      'local-preference 默认 100，只在 IBGP 内传递，跨 EBGP 会被重置',
      'MED 只在同一对 AS 之间比较，且对端可用 always-compare-med 改变行为',
      '只看 BGP 表不看出方向，容易误判成属性没生效',
    ],
  },

  'bgp-aggregation': {
    title: 'BGP 路由聚合与团体属性',
    titleEn: 'BGP aggregation and communities',
    level: 'advanced',
    source: 'eNSP 3-2 BGP Route Aggregation',
    devices: '3~4 台路由器',
    goal: '把明细路由聚合成一条，并控制聚合后是否保留明细与 AS_PATH 信息',
    steps: [
      { do: '先有可聚合的明细', detail: '至少两条同前缀长度的明细路由在 BGP 表中', verify: 'display bgp routing-table' },
      { do: '配 aggregate', detail: '指定聚合网段与掩码，默认同时发布聚合与明细', verify: 'display bgp routing-table' },
      { do: '抑制明细', detail: 'detail-suppressed 只发聚合；suppress-policy 按策略选择性抑制' },
      { do: '保留 AS_PATH 信息', detail: 'as-set 让聚合路由携带明细的 AS 集合，避免被对端当成更优路径' },
      { do: '团体属性', detail: 'apply community 打标记，对端用 community-filter 做策略', verify: 'display bgp routing-table community' },
    ],
    pitfalls: [
      '聚合路由默认不继承明细的 AS_PATH，可能造成环路或选路异常，需要 as-set',
      '只配聚合不抑制明细，路由条目数并不会减少',
      '聚合网段必须覆盖所有明细，否则会产生黑洞',
      '团体属性默认不传递，需显式 peer advertise-community',
    ],
  },

  'bgp-troubleshooting': {
    title: 'BGP 邻居排障',
    titleEn: 'BGP neighbour troubleshooting',
    level: 'advanced',
    source: 'eNSP 3-6 BGP Troubleshooting',
    devices: '3 台路由器',
    goal: '按邻居状态机定位 BGP 建立失败的原因',
    steps: [
      { do: '读状态', detail: 'Idle 未发起；Connect/Active 在尝试 TCP；OpenSent/OpenConfirm 在协商；Established 才算成功', verify: 'display bgp peer' },
      { do: '查 TCP 179', detail: '先确认到对端 179 端口可连，路由不可达时永远停在 Connect', verify: 'display tcp status' },
      { do: '查对端配置', detail: 'AS 号、peer 地址、router-id 唯一性；IBGP 是否 update-source 到 loopback', verify: 'display bgp peer verbose' },
      { do: '查策略拦截', detail: 'ACL 或防火墙是否放行 179；EBGP 是否配了 ebgp-max-hop（非直连时）' },
      { do: '看具体错误码', detail: 'verbose 输出里的 last error 与 notification 码直接指向原因' },
    ],
    pitfalls: [
      '两个邻居用相同 router-id 会互相踢下线，表现为 Established 反复抖动',
      'IBGP 用 loopback 建邻居但没配 update-source，源地址不匹配永远连不上',
      'EBGP 非直连建邻必须 ebgp-max-hop，否则报文 TTL 为 1 被丢弃',
      'hold timer 不一致会协商成较小值，网络抖动时容易误判断开',
    ],
  },

  'stack-istack': {
    title: '交换机堆叠与 iStack',
    titleEn: 'Switch stacking and iStack',
    level: 'advanced',
    source: 'eNSP 常规实验',
    devices: '2~4 台同型号交换机 + 1 台上行设备',
    goal: '多台物理交换机合成一台逻辑设备，跨成员链路聚合、单一管理地址',
    steps: [
      { do: '规划主备与成员编号', detail: '先定主交换机（priority 高）、再定成员 ID，编号必须唯一', verify: 'display stack' },
      { do: '配堆叠端口', detail: '用专用堆叠卡口或业务口做 stack-port，两台设备互联成环更可靠', verify: 'display stack configuration' },
      { do: '上电合并', detail: '先配好再同时重启，成员加入后堆叠 ID 生效' },
      { do: '跨成员聚合', detail: 'Eth-Trunk 成员口分布在不同成员上，单成员故障链路仍可用', verify: 'display eth-trunk' },
      { do: '管理面验证', detail: '整机只有一个管理 IP，成员口统一编号（如 GigabitEthernet1/0/1 与 2/0/1）', verify: 'display interface brief' },
    ],
    pitfalls: [
      '两台设备都用默认优先级 100 时主备由 MAC 决定，换设备后主备关系会变',
      '堆叠 ID 重复会导致成员无法加入，且报错信息很简短',
      '堆叠线接成单链而非环，一条线断就分裂成两台独立设备（双主）',
      '分裂后两台都认为自己为主，若没配双主检测会导致地址冲突',
    ],
  },

  'route-policy-pbr': {
    title: '路由策略与策略路由',
    titleEn: 'Route policy and policy-based routing',
    level: 'advanced',
    source: 'eNSP 常规实验',
    devices: '3 台路由器（双出口）',
    goal: '用 route-policy 过滤/修改路由，用 PBR 让特定流量走指定出口',
    steps: [
      { do: '先写匹配条件', detail: 'ip-prefix 或 ACL 描述网段，community-filter 描述团体', verify: 'display ip ip-prefix' },
      { do: '写 route-policy 节点', detail: 'if-match 匹配，apply 修改 cost/tag/preference；节点号小的先匹配', verify: 'display route-policy' },
      { do: '挂到协议上', detail: 'import-route 时引用，或 BGP peer 的 route-policy import/export' },
      { do: '策略路由另行处理', detail: 'traffic classifier + behavior（redirect ip-nexthop）+ traffic policy，绑到接口 inbound', verify: 'display traffic policy' },
      { do: '验证分流', detail: '用 tracert 看不同源/目的的流量是否走了不同下一跳' },
    ],
    pitfalls: [
      'route-policy 末尾隐含 deny，没被任何节点匹配上的路由会被丢弃',
      '只写 if-match 不写 apply 也能命中，但行为是 permit 且不修改属性',
      'PBR 优先级高于路由表，配错会绕过正常转发路径且很难排查',
      '策略路由只能匹配接口入方向，出方向需要换方案',
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
      { do: '设封装类型', detail: '串口默认是 PPP，HDLC 要显式切换；PPP 支持认证与多链路', verify: 'display interface Serial0/0/1' },
      { do: '配置认证', detail: '一端 authenticator，另一端 pap/chap 用户名密码', verify: 'display current-configuration interface Serial0/0/0' },
      { do: 'PPPoE', detail: '服务端建 VT 与地址池，客户端 dialer 拨号', verify: 'display ip pool' },
    ],
    pitfalls: [
      '串口上默认封装是 PPP，不是 HDLC，`display interface` 里的 Link layer protocol 会直接说明当前是哪种',
      'PPP 认证两端 pap/chap 不一致会反复协商失败',
      'PPPoE 服务端要在物理口上 `pppoe-server bind virtual-template`，地址池挂在 VT 上',
    ],
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

  'vrrp-basics': {
    title: 'VRRP 网关冗余',
    titleEn: 'VRRP gateway redundancy',
    level: 'basic',
    source: 'eNSP 常规实验',
    devices: '2 台三层交换机/路由器 + PC',
    goal: '两台设备共用一个虚拟网关，主设备故障时秒级切换',
    steps: [
      { do: '两台设备同网段同 Vlanif', detail: '虚拟网关地址在同一个二层域内才有效', verify: 'display ip interface brief' },
      { do: '建 VRRP 组', detail: '两端 vrid 必须一致；虚拟 IP 不能与任何真实接口地址冲突', verify: 'display vrrp' },
      { do: '定主备', detail: '优先级大者为主（默认 100，最大 254）；地址拥有者优先级 255' },
      { do: '加认证', detail: '两端 authentication-mode 与密钥必须一致，否则报文被丢弃、双主', verify: 'display vrrp verbose' },
      { do: '加 track 上行', detail: 'track interface 上行口，主设备上行断则主动降优先级让备接管', verify: 'display vrrp' },
    ],
    pitfalls: [
      '两端 vrid 或认证不一致会各自成为 Master，形成双主且无任何报错',
      '只配优先级不配 track，主设备上行断了仍占着虚拟 MAC，业务全断',
      'track 的 reduced 值太大会让备设备比主还低，切换后无法回切',
      '虚拟 IP 配成某台设备的真实接口地址会报错',
    ],
  },

  'dhcp-snooping': {
    title: 'DHCP Snooping 与 IPSG',
    titleEn: 'DHCP snooping and IPSG',
    level: 'intermediate',
    source: 'eNSP 常规实验',
    devices: '1 台三层交换机 + 1 台接入交换机 + PC',
    goal: '阻断私接 DHCP 服务器，绑定合法地址防止 IP 冒用',
    steps: [
      { do: '全局开 DHCP Snooping', detail: 'dhcp snooping enable，再按 VLAN 开 dhcp snooping enable', verify: 'display dhcp snooping' },
      { do: '上行口设 trusted', detail: '接合法 DHCP 服务器的口必须 dhcp snooping trusted，否则所有 DHCP 报文被丢' },
      { do: '接入口保持 untrusted', detail: '用户口默认 untrusted，收到 DHCP Offer 直接丢弃', verify: 'display dhcp snooping user-info' },
      { do: '开 IPSG', detail: 'ip source check user-bind enable，基于 snooping 表项校验源 IP+MAC' },
      { do: '验证', detail: '私接 DHCP 服务器后 PC 拿不到错误地址；手工改 IP 后无法上网' },
    ],
    pitfalls: [
      '上行口忘记 trusted 是黑白名单反了，表现为全网 DHCP 都拿不到地址',
      'trusted 配在不存在的接口上不会报错，等于没配',
      'IPSG 依赖 snooping 表项，静态 IP 用户需要手工绑定静态表项',
    ],
  },

  'arp-security': {
    title: 'ARP 安全（防欺骗与防攻击）',
    titleEn: 'ARP security',
    level: 'intermediate',
    source: 'eNSP 常规实验',
    devices: '1 台交换机 + 3 PC',
    goal: '防御 ARP 欺骗、ARP 泛洪，保证网关 MAC 不被冒充',
    steps: [
      { do: '静态绑定网关', detail: '用户侧手工 arp static 或交换机侧 arp static，锁定网关 MAC', verify: 'display arp' },
      { do: '开 ARP 检测', detail: 'arp anti-attack check user-bind enable，丢弃 MAC/IP 不匹配的 ARP', verify: 'display arp anti-attack' },
      { do: '限速防泛洪', detail: 'arp anti-attack rate-limit 限制单位时间 ARP 报文数' },
      { do: 'DAI 类方案', detail: '基于 DHCP Snooping 表项的动态 ARP 检测，比纯静态更适合终端多的场景' },
      { do: '验证', detail: '在攻击机上伪造网关 MAC 发 ARP，受害机 ARP 表不应被改写' },
    ],
    pitfalls: [
      '只做静态绑定而不开检测，攻击者仍可伪造其他主机的 ARP',
      'ARP 检测依赖 DHCP Snooping 表项，纯静态 IP 环境要先造表',
      '限速值设太小会把正常 ARP 也丢掉，表现为间歇性断网',
    ],
  },

  'qos-basics': {
    title: 'QoS 分类标记与队列',
    titleEn: 'QoS classification, marking and queues',
    level: 'intermediate',
    source: 'eNSP 常规实验',
    devices: '2 台交换机 + PC + 打流工具',
    goal: '给语音/视频打高优先级，拥塞时优先转发、限制普通流量带宽',
    steps: [
      { do: '分类', detail: 'traffic classifier 匹配 ACL 或 VLAN，指定 operator or/and', verify: 'display traffic classifier' },
      { do: '标记', detail: 'traffic behavior 里 remark dscp 或 remark 8021p；标记要尽量靠近源端' },
      { do: '队列调度', detail: '接口下 qos schedule 或 diffserv domain，给高优先级队列加权' },
      { do: '限速与整形', detail: 'car 做入向限速，traffic shaping 做出向整形', verify: 'display qos car' },
      { do: '绑定并验证', detail: 'traffic policy 绑到接口；打流观察高优先级丢包率', verify: 'display traffic policy statistics' },
    ],
    pitfalls: [
      '只标记不调度：标记完没人看，拥塞时仍是先到先服务',
      '队列数超过接口支持数量会配不上，需先查接口默认队列模板',
      '入向限速与出向整形混淆，用错方向限不住目标流量',
      'DSCP 与 802.1p 映射关系不一致会导致跨设备优先级丢失',
    ],
  },

  'multicast-pim-sm': {
    title: '组播 PIM-SM 与 IGMP',
    titleEn: 'Multicast with PIM-SM and IGMP',
    level: 'advanced',
    source: 'eNSP 5-2 PIM-SM and Dynamic RP / multicast',
    devices: '4~5 台路由器 + 组播服务器 + 接收者',
    goal: '用 PIM-SM 建立共享树与最短路径树，接收者按需加入组播组',
    steps: [
      { do: '全局开组播', detail: 'multicast routing-enable 必须在所有组播路由器上开', verify: 'display pim' },
      { do: '配 IGMP', detail: '面向接收者的接口开 igmp enable，指定版本（默认 v2）', verify: 'display igmp group' },
      { do: '配 PIM-SM', detail: '所有三层接口开 pim sm，形成 RPF 邻居', verify: 'display pim neighbor' },
      { do: '配 RP', detail: '静态 RP pim static-rp，或动态 BSR/C-RP；所有路由器 RP 信息必须一致', verify: 'display pim rp-info' },
      { do: '验证树形', detail: '初始为共享树（*，G），源出现后切到 SPT（S，G）', verify: 'display pim routing-table' },
    ],
    pitfalls: [
      '未开 multicast routing-enable 时接口 pim 命令根本挂不上',
      'RPF 检查看的是单播路由，单播回程不对会导致组播流量被丢弃',
      'RP 地址不一致会导致不同路由器算出不同共享树，组播时通时不通',
      '接收者侧接口没开 IGMP，PIM 邻居正常但流量下不来',
      'eNSP 组播需要设备支持组播转发，部分低端型号不可用',
    ],
  },

  'firewall-zones': {
    title: '防火墙安全域与策略',
    titleEn: 'Firewall zones and security policies',
    level: 'advanced',
    source: 'eNSP Security Authentication 延伸',
    devices: 'USG 防火墙 + 内外网路由器',
    goal: '按安全域划分接口，用安全策略控制域间流量，配置 NAT 与服务器映射',
    steps: [
      { do: '划分安全域', detail: '把接口加入 trust/untrust/dmz 域，接口必须先 firewall zone 再配策略', verify: 'display zone' },
      { do: '写安全策略', detail: 'security-policy 按源/目的域 + 地址 + 服务放行；默认动作是 deny', verify: 'display security-policy' },
      { do: '配 NAT', detail: 'trust 到 untrust 用 nat-policy 做源 NAT；服务器发布用 nat server', verify: 'display nat-policy' },
      { do: '验证域间', detail: 'trust 到 untrust 通、untrust 到 trust 默认不通；策略计数应增长', verify: 'display security-policy statistics' },
    ],
    pitfalls: [
      '同域内（intra-zone）流量不匹配域间安全策略，用策略做同域隔离不会生效',
      '接口没加进域时所有流量都被丢弃，且日志里只显示无匹配域',
      '策略顺序从上到下匹配，宽泛规则放前面会让后面的精确规则永远不命中',
      'NAT 与安全策略是两套独立匹配，NAT 放行了不等于策略放行',
    ],
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

  'bfd-fast-convergence': {
    title: 'BFD 快速故障检测',
    titleEn: 'BFD fast failure detection',
    level: 'advanced',
    source: 'eNSP 常规实验',
    devices: '2~3 台路由器',
    goal: '用毫秒级 BFD 会话替代秒级的协议 Hello 超时，缩短收敛时间',
    steps: [
      { do: '先建底层可达', detail: 'BFD 只做检测，不负责转发；直连或已有路由必须先通' },
      { do: '配 BFD 会话', detail: 'bfd 全局开启后，单跳用 bfd bind peer-ip；多跳需 bfd multi-hop', verify: 'display bfd session all' },
      { do: '调检测参数', detail: 'min-tx-interval / min-rx-interval / detect-multiplier，两端取大值协商' },
      { do: '挂到协议上', detail: '静态路由 bfd enable，或 OSPF/VRRP 的 bfd 联动', verify: 'display bfd session all verbose' },
      { do: '验证收敛', detail: '断开链路后 BFD 应在百毫秒级 Up→Down，路由表随之切换' },
    ],
    pitfalls: [
      '检测间隔设得过小（如 3.3ms）在 eNSP 里会因调度抖动误报 Down',
      '两端参数不一致时按较大值协商，实际收敛比预期慢',
      'BFD 会话 Up 但协议没联动，等于白配',
      '多跳 BFD 要显式指定 multi-hop，否则默认单跳会话起不来',
    ],
  },

  'mpls-basic': {
    title: 'MPLS 标签转发',
    titleEn: 'MPLS label switching',
    level: 'advanced',
    source: 'eNSP 常规实验',
    devices: '3~4 台路由器',
    goal: '建立 LSP，观察标签分配、压入、交换与弹出',
    steps: [
      { do: '开 MPLS 与 LSR-ID', detail: '全局 mpls lsr-id 唯一，接口下 mpls 与 mpls ldp', verify: 'display mpls ldp peer' },
      { do: '建 LDP 会话', detail: '两端接口都要开 mpls，LDP 用 UDP 646 建会话、TCP 646 传标签', verify: 'display mpls ldp session' },
      { do: '看标签分配', detail: '每条 IGP 路由被分配一个入标签与出标签', verify: 'display mpls lsp' },
      { do: '验证转发', detail: 'tracert 或 display mpls lsp 确认报文按标签而非 IP 逐跳转发' },
    ],
    pitfalls: [
      '接口未开 mpls 时 LDP 邻居起不来，且路由本身照常工作，容易误判 MPLS 已生效',
      'LSR-ID 重复会导致 LDP 会话反复建立又断开',
      '标签只在 LSP 上有效，LSP 断裂后回退到 IP 转发，现象是“能通但标签没了”',
      'eNSP 部分低端型号不支持 MPLS，配命令时会直接报错',
    ],
  },

  'mpls-l3vpn': {
    title: 'BGP/MPLS L3VPN',
    titleEn: 'BGP/MPLS L3VPN',
    level: 'advanced',
    source: 'eNSP 常规实验（HCIP 范围）',
    devices: '5~6 台路由器（PE/P/CE）',
    goal: '两个站点私网通过运营商 MPLS 骨干互通，地址可重叠',
    steps: [
      { do: '骨干先通', detail: 'P 与 PE 之间 IGP + MPLS LDP 全部就绪', verify: 'display mpls ldp session' },
      { do: 'PE 上建 VRF', detail: 'ip vpn-instance 绑定 RD 与 RT，接口划入 VRF', verify: 'display ip vpn-instance' },
      { do: 'PE-CE 路由', detail: '静态或 OSPF 把站点路由引入 VRF' },
      { do: 'MP-BGP 传 VPNv4', detail: 'PE 间建 IBGP 并开 vpnv4 地址族，配 VPN target 控制导入导出', verify: 'display bgp vpnv4 all routing-table' },
      { do: '验证隔离与互通', detail: '同 VPN 站点互通；不同 VPN 即使地址相同也互不可见' },
    ],
    pitfalls: [
      'RD 只保证唯一性不影响选路，真正控制导入导出的是 RT',
      'PE 间 IBGP 未开 vpnv4 地址族时 VPN 路由根本不传递',
      'VRF 接口没绑定 vpn-instance，站点路由进不了 VPN 表',
      'RT 配成 import 与 export 不一致是最常见的“单通”原因',
    ],
  },

  'network-management': {
    title: '网络管理（SNMP / NTP / Syslog）',
    titleEn: 'Network management with SNMP, NTP and syslog',
    level: 'basic',
    source: 'eNSP 常规实验',
    devices: '2~3 台设备 + 1 台管理服务器',
    goal: '设备可被网管平台监控、时间同步、日志集中收集',
    steps: [
      { do: 'SNMP', detail: 'snmp-agent 开团本，配 v2c community 或 v3 用户，ACL 限源', verify: 'display snmp-agent sys-info' },
      { do: 'NTP', detail: '客户端 ntp-service unicast-server 指向时钟源；层级用 stratum 区分', verify: 'display ntp status' },
      { do: 'Syslog', detail: 'info-center loghost 指定日志服务器，别把 info-center 整体关掉', verify: 'display info-center' },
      { do: '验证', detail: '网管能取到接口流量；设备时间与服务器一致；服务器收到日志' },
    ],
    pitfalls: [
      'undo info-center enable 是关掉整个日志系统，连本地缓存都没了，与日志审计要求直接冲突',
      'SNMP community 用 public/private 且不限源，等于把设备交出去',
      'NTP 单向可达（服务器回包被 ACL 挡）时同步不上，display ntp status 显示 unsynchronized',
      '日志服务器地址不可达时设备只在本地缓冲，缓冲满了就丢，没有任何提示',
    ],
  },

  'ospfv3-ipv6': {
    title: 'OSPFv3 与 IPv6 双栈',
    titleEn: 'OSPFv3 and IPv6 dual stack',
    level: 'intermediate',
    source: 'eNSP HCNA Lab 5-1 延伸',
    devices: '3~4 台路由器',
    goal: '在 IPv6 网络上跑 OSPFv3，与 IPv4 并存互不干扰',
    steps: [
      { do: '全局与接口双开 IPv6', detail: 'ipv6 全局开启，接口 ipv6 enable 并配地址', verify: 'display ipv6 interface brief' },
      { do: '建 OSPFv3 进程', detail: 'ospfv3 1 需指定 router-id（用 IPv4 地址形式），再在接口 ospfv3 1 area 0', verify: 'display ospfv3 peer' },
      { do: '观察链路本地地址', detail: 'OSPFv3 邻居用 fe80:: 建立，接口必须有链路本地地址', verify: 'display ospfv3 interface' },
      { do: '验证路由', detail: 'IPv6 路由表出现对端网段，双栈下 IPv4 路由不受影响', verify: 'display ipv6 routing-table' },
    ],
    pitfalls: [
      '只开全局 ipv6 未在接口 ipv6 enable，接口没有链路本地地址，OSPFv3 邻居起不来',
      'OSPFv3 的 router-id 仍是 32 位点分十进制，不是 IPv6 地址',
      'OSPFv3 用链路本地地址泛洪，跨网段邻居需要额外的全局地址配置',
      'IPv6 没有 ARP，ND 未通时 ping 不通但接口是 up 的',
    ],
  },

  'dual-homed-isp': {
    title: '双出口多运营商选路',
    titleEn: 'Dual-homed ISP egress',
    level: 'advanced',
    source: 'eNSP 常规实验（HCIP 范围）',
    devices: '2 台出口路由器 + 2 个运营商 + 核心交换机',
    goal: '两条出口互为备份，按目的与业务分流，故障时自动切换',
    steps: [
      { do: '两出口各自建默认路由', detail: '主出口 preference 60，备出口 preference 80，形成浮动备份', verify: 'display ip routing-table protocol static' },
      { do: '按目的分流', detail: '用 ip-prefix 匹配不同运营商网段，各走各的出口，避免非对称回程' },
      { do: '挂 BFD 加速切换', detail: '两条默认路由 bfd enable，链路故障百毫秒级切走', verify: 'display bfd session all' },
      { do: 'NAT 与回程', detail: '两出口各自做 easy-ip；运营商侧回程路由必须指回对应出口地址' },
      { do: '验证主备与分流', detail: '断开主出口，走主出口的流量应切到备；tracert 确认不同目的走不同运营商' },
    ],
    pitfalls: [
      '两条默认路由 preference 相同会形成 ECMP，一半流量走不可用出口',
      '两出口都做 NAT 但只在一个出口配回程，切换后会出现单向不通',
      '非对称回程（去走 A、回走 B）会被运营商或防火墙状态检测丢弃',
      'BFD 会话建在运营商链路上时要注意对端是否支持，不支持就退回路由协议检测',
    ],
  },

  'firewall-hrp': {
    title: '防火墙双机热备（HRP）',
    titleEn: 'Firewall HA with HRP',
    level: 'advanced',
    source: 'eNSP Security 延伸',
    devices: '2 台 USG 防火墙 + 上下行设备',
    goal: '主备防火墙同步会话与配置，主设备故障时业务不中断',
    steps: [
      { do: '直连心跳口', detail: '两台之间用独立链路配 hrp interface 与对端 remote 地址，不要与业务口混用', verify: 'display hrp state' },
      { do: '开 HRP 并定主备', detail: '一台 hrp enable，另一台 hrp enable + hrp standby-device', verify: 'display hrp state' },
      { do: '同步内容', detail: 'hrp auto-sync 同步配置与连接表；hrp mirror session 同步状态化会话' },
      { do: '上下行做 VRRP', detail: '两台在上下行接口各跑一组 VRRP，主设备优先级高并 track 上行', verify: 'display vrrp' },
      { do: '调 OSPF 代价', detail: 'hrp adjust ospf-cost enable 让备机对外发布更高 cost，避免流量被引到备机' },
      { do: '切换验证', detail: '断开主设备上行，会话应保持、业务不中断', verify: 'display hrp state / display session table' },
    ],
    pitfalls: [
      '两台都注入默认路由却没调 OSPF 代价，会形成 ECMP，一半流量打到不转发的备机',
      '心跳口与业务口共用链路时，主设备故障会连带心跳中断，备机可能误判',
      '只同步配置不同步会话，切换后已建立的 TCP 连接全部中断，表现为“切换即掉线”',
      'HRP 要求两台型号、版本、接口编号一致，否则同步失败',
    ],
  },

  'spine-leaf-vxlan': {
    title: 'Spine-Leaf 与 VXLAN 大二层',
    titleEn: 'Spine-leaf with VXLAN overlay',
    level: 'advanced',
    source: 'eNSP 数据中心实验（依赖机型支持）',
    devices: '2 台 Spine + 2 台 Leaf + 服务器',
    goal: '用 VXLAN 在三层互联的 Underlay 上构建大二层 Overlay，虚拟机跨机架迁移',
    steps: [
      { do: '先建 Underlay', detail: 'Spine-Leaf 之间 OSPF 或 BGP 打通，每台 Leaf 有 loopback 作 VTEP 地址', verify: 'display ip routing-table' },
      { do: '建 NVE 接口', detail: 'interface nve 下 source 指向 VTEP 地址，配 vni 与头端复制列表', verify: 'display nve' },
      { do: '建二层网关', detail: 'VNI 映射到 Bridge-Domain，BD 绑定 Vlanif 做网关', verify: 'display bridge-domain' },
      { do: '配 EVPN 或静态头端', detail: 'EVPN 用 BGP evpn 地址族自动发现；静态则手工配 ingress-replication peer' },
      { do: '验证迁移', detail: '同网段服务器在不同 Leaf 下互通，IP 不变', verify: 'display vxlan vni' },
    ],
    pitfalls: [
      'eNSP 多数交换机型不支持 VXLAN，命令直接报错，需先确认机型能力',
      'VTEP 地址必须用 loopback 且三层可达，用物理口地址会导致 Underlay 变化时隧道断',
      'BD 与 Vlanif 绑定关系配错时 VXLAN 通但网关不通',
      'EVPN 的 route-target 配反会导致本地 VNI 不导入远端路由',
    ],
  },

  'ipsec-gre-tunnel': {
    title: 'IPsec 与 GRE 隧道组合',
    titleEn: 'IPsec over GRE and tunnel backup',
    level: 'advanced',
    source: 'eNSP HCNA Lab 3-4 延伸',
    devices: '2 台出口路由器',
    goal: 'GRE 承载组播/动态路由，IPsec 保护它；或两条隧道互为备份',
    steps: [
      { do: '先建 GRE 隧道', detail: 'tunnel 接口指定 source/destination 与 tunnel 地址，两端地址同网段', verify: 'display interface Tunnel' },
      { do: '在隧道上跑路由', detail: '隧道口宣告进 OSPF，让两端私网通过隧道学到对方路由', verify: 'display ospf peer' },
      { do: '用 IPsec 保护 GRE', detail: '感兴趣流写 GRE 两端公网地址之间的协议 47，套 ipsec policy', verify: 'display ipsec sa' },
      { do: '备选：两条隧道浮动', detail: '两条 tunnel 配不同 cost/preference，主隧道断时切备' },
      { do: '验证', detail: 'display ipsec sa 有加密统计；断开主链路后流量走备隧道' },
    ],
    pitfalls: [
      'IPsec 感兴趣流的协议写错（写成 ip 或 tcp）会导致 GRE 报文不被加密',
      'GRE 本身不加密，只 IPsec 保护才是安全的；只配 GRE 等于明文隧道',
      '隧道两端地址不在同网段时隧道 up 但路由不通',
      'GRE 会增加 24 字节开销，MTU 未调会导致大包被丢（表现为能 ping 通但网页打不开）',
    ],
  },

  'wlan-roaming': {
    title: 'WLAN 漫游与 AC 高可用',
    titleEn: 'WLAN roaming and AC redundancy',
    level: 'advanced',
    source: 'eNSP WLAN 实验延伸',
    devices: '2 台 AC（或 1 AC + 多 AP）+ 交换机',
    goal: '终端在 AP 间移动时不断线，AC 故障时 AP 重新上线',
    steps: [
      { do: 'AP 上线', detail: '所有 AP 拿到管理地址并成功注册到 AC', verify: 'display ap all' },
      { do: '统一 SSID 与安全模板', detail: '同一 SSID、同一安全策略、同一 VLAN 才能二层漫游' },
      { do: '开漫游', detail: '同一 AC 内默认支持；跨 AC 需配漫游组与 AC 间隧道', verify: 'display station roam-track' },
      { do: 'AC 备份', detail: 'AP 配主备 AC 地址，主 AC 故障后 AP 切到备 AC 重新上线' },
      { do: '验证漫游', detail: '终端移动时看 roam-track 记录，ping 应基本不丢包' },
    ],
    pitfalls: [
      '不同 SSID 或不同安全模板无法漫游，终端会先断再连',
      '跨 AC 漫游未建漫游组时终端会重新认证，表现为断线几秒',
      'AP 主备 AC 地址配了但 AC 间路由不通，主 AC 挂后备 AC 也拉不起 AP',
      '漫游要求 VLAN 在二层连续，跨三层需要隧道或 VXLAN',
    ],
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
      const detail = step.detail ? `：${step.detail}` : ''
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
