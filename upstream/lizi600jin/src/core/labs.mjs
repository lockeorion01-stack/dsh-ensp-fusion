/**
 * Topology blueprints for the scenario presets.
 *
 * A preset describes *what to configure and in what order*. This module adds the
 * piece that was missing to actually run one: a device list, the links between
 * them, and an addressing plan. `ensp preset <id> --topo out.topo` turns a
 * blueprint into a `.topo` file eNSP can open, so a reader no longer has to
 * rebuild the drawing by hand before the steps make sense.
 *
 * What a blueprint deliberately does **not** contain is a command script. The
 * scenarios stay skeletons (see `presets.mjs` for why), and the addressing plan
 * is a table rather than a paste-ready block. You still type the commands; the
 * lab just removes the geometry and the IP arithmetic.
 *
 * Ports in `links` and `addressing` are VRP names (`GigabitEthernet0/0/1`), the
 * same vocabulary used on the CLI, not eNSP's file-level indices.
 *
 * @module dsh-ensp/labs
 */

import { buildTopology, autoLayout } from './build.mjs'

/**
 * Shape:
 *
 * ```
 * {
 *   devices: [ ['SW1', 'S5700'], { name, model, ip, mask, gateway } ],
 *   links:   [ ['SW1', 'GigabitEthernet0/0/1', 'PC1', 'Ethernet0/0/1'] ],
 *   addressing: [ { device, port, ip, note? } ],
 *   positions?: { DEVICE: [x, y] },
 * }
 * ```
 *
 * A PC entry carries its address inline because eNSP stores it in the device
 * settings; every other device gets its address from `addressing`, which is also
 * what the reader copies from.
 */
const lab = (devices, links, addressing, positions) => ({ devices, links, addressing, positions })

const PC = (name, ip, mask, gateway) => ({ name, model: 'PC', ip, mask, gateway })

export const LABS = {
  // ------------------------------------------------------------------ switching
  'vlan-access': lab(
    [['SW1', 'S5700'], PC('PC1', '192.168.10.1', '255.255.255.0', '192.168.10.254'),
      PC('PC2', '192.168.20.1', '255.255.255.0', '192.168.20.254'),
      PC('PC3', '192.168.20.2', '255.255.255.0', '192.168.20.254')],
    [
      ['PC1', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/1'],
      ['PC2', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/2'],
      ['PC3', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/3'],
    ],
    [],
  ),

  'trunk-interconnect': lab(
    [['SW1', 'S5700'], ['SW2', 'S5700'],
      PC('PC1', '192.168.10.1', '255.255.255.0', '192.168.10.254'),
      PC('PC2', '192.168.10.2', '255.255.255.0', '192.168.10.254')],
    [
      ['PC1', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/1'],
      ['PC2', 'Ethernet0/0/1', 'SW2', 'GigabitEthernet0/0/1'],
      ['SW1', 'GigabitEthernet0/0/24', 'SW2', 'GigabitEthernet0/0/24'],
    ],
    [],
  ),

  'vlanif-routing': lab(
    [['SW1', 'S5700'], ['SW2', 'S5700'],
      PC('PC1', '192.168.10.1', '255.255.255.0', '192.168.10.254'),
      PC('PC2', '192.168.20.1', '255.255.255.0', '192.168.20.254')],
    [
      ['PC1', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/1'],
      ['PC2', 'Ethernet0/0/1', 'SW2', 'GigabitEthernet0/0/1'],
      ['SW1', 'GigabitEthernet0/0/24', 'SW2', 'GigabitEthernet0/0/24'],
    ],
    [
      { device: 'SW1', port: 'Vlanif10', ip: '192.168.10.254/24', note: 'VLAN10 网关' },
      { device: 'SW2', port: 'Vlanif20', ip: '192.168.20.254/24', note: 'VLAN20 网关' },
      { device: 'SW1', port: 'Vlanif200', ip: '10.0.12.1/24', note: '互联 VLAN200' },
      { device: 'SW2', port: 'Vlanif200', ip: '10.0.12.2/24', note: '互联 VLAN200' },
    ],
  ),

  'stp-rstp': lab(
    [['SW1', 'S5700'], ['SW2', 'S5700'], ['SW3', 'S5700'],
      PC('PC1', '192.168.10.1', '255.255.255.0', '192.168.10.254'),
      PC('PC2', '192.168.10.2', '255.255.255.0', '192.168.10.254')],
    [
      ['PC1', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/1'],
      ['PC2', 'Ethernet0/0/1', 'SW2', 'GigabitEthernet0/0/1'],
      ['SW1', 'GigabitEthernet0/0/23', 'SW2', 'GigabitEthernet0/0/23'],
      ['SW2', 'GigabitEthernet0/0/24', 'SW3', 'GigabitEthernet0/0/23'],
      ['SW3', 'GigabitEthernet0/0/24', 'SW1', 'GigabitEthernet0/0/24'],
    ],
    [
      { device: 'SW1', port: 'Vlanif10', ip: '192.168.10.251/24', note: '管理地址' },
      { device: 'SW2', port: 'Vlanif10', ip: '192.168.10.252/24', note: '管理地址' },
      { device: 'SW3', port: 'Vlanif10', ip: '192.168.10.253/24', note: '管理地址' },
    ],
  ),

  'mstp-load-balance': lab(
    [['CORE1', 'S5700'], ['CORE2', 'S5700'], ['ACC1', 'S5700'], ['ACC2', 'S5700'],
      PC('PC1', '192.168.10.1', '255.255.255.0', '192.168.10.254'),
      PC('PC2', '192.168.20.1', '255.255.255.0', '192.168.20.254')],
    [
      ['ACC1', 'GigabitEthernet0/0/1', 'PC1', 'Ethernet0/0/1'],
      ['ACC2', 'GigabitEthernet0/0/1', 'PC2', 'Ethernet0/0/1'],
      ['ACC1', 'GigabitEthernet0/0/23', 'CORE1', 'GigabitEthernet0/0/1'],
      ['ACC1', 'GigabitEthernet0/0/24', 'CORE2', 'GigabitEthernet0/0/1'],
      ['ACC2', 'GigabitEthernet0/0/23', 'CORE1', 'GigabitEthernet0/0/2'],
      ['ACC2', 'GigabitEthernet0/0/24', 'CORE2', 'GigabitEthernet0/0/2'],
    ],
    [
      { device: 'CORE1', port: 'Vlanif10', ip: '192.168.10.252/24', note: 'VLAN10 网关（实例1 主）' },
      { device: 'CORE1', port: 'Vlanif20', ip: '192.168.20.253/24', note: 'VLAN20 网关（实例2 备）' },
      { device: 'CORE2', port: 'Vlanif10', ip: '192.168.10.253/24', note: 'VLAN10 网关（实例1 备）' },
      { device: 'CORE2', port: 'Vlanif20', ip: '192.168.20.252/24', note: 'VLAN20 网关（实例2 主）' },
    ],
  ),

  'link-aggregation': lab(
    [['SW1', 'S5700'], ['SW2', 'S5700'],
      PC('PC1', '192.168.10.1', '255.255.255.0', '192.168.10.254'),
      PC('PC2', '192.168.10.2', '255.255.255.0', '192.168.10.254')],
    [
      ['PC1', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/1'],
      ['PC2', 'Ethernet0/0/1', 'SW2', 'GigabitEthernet0/0/1'],
      ['SW1', 'GigabitEthernet0/0/23', 'SW2', 'GigabitEthernet0/0/23'],
      ['SW1', 'GigabitEthernet0/0/24', 'SW2', 'GigabitEthernet0/0/24'],
    ],
    [],
  ),

  'port-security': lab(
    [['SW1', 'S5700'],
      PC('PC1', '192.168.10.1', '255.255.255.0', '192.168.10.254'),
      PC('PC2', '192.168.10.2', '255.255.255.0', '192.168.10.254')],
    [
      ['PC1', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/1'],
      ['PC2', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/2'],
    ],
    [],
  ),

  'port-isolation': lab(
    [['SW1', 'S5700'],
      PC('PC1', '192.168.10.1', '255.255.255.0', '192.168.10.254'),
      PC('PC2', '192.168.10.2', '255.255.255.0', '192.168.10.254'),
      PC('PC3', '192.168.10.3', '255.255.255.0', '192.168.10.254')],
    [
      ['PC1', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/1'],
      ['PC2', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/2'],
      ['PC3', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/3'],
    ],
    [],
  ),

  // -------------------------------------------------------------------- routing
  'static-route': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'],
      PC('PC1', '192.168.1.1', '255.255.255.0', '192.168.1.254'),
      PC('PC2', '192.168.2.1', '255.255.255.0', '192.168.2.254')],
    [
      ['PC1', 'Ethernet0/0/1', 'R1', 'GigabitEthernet0/0/1'],
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
      ['R2', 'GigabitEthernet0/0/1', 'PC2', 'Ethernet0/0/1'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/1', ip: '192.168.1.254/24', note: 'PC1 网关' },
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '10.0.12.1/24', note: '互联' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '10.0.12.2/24', note: '互联' },
      { device: 'R2', port: 'GigabitEthernet0/0/1', ip: '192.168.2.254/24', note: 'PC2 网关' },
    ],
  ),

  'ospf-single': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'], ['R3', 'AR2220']],
    [
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
      ['R2', 'GigabitEthernet0/0/1', 'R3', 'GigabitEthernet0/0/0'],
      ['R1', 'GigabitEthernet0/0/1', 'R3', 'GigabitEthernet0/0/1'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '10.0.12.1/24', note: '互联 R2' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '10.0.12.2/24' },
      { device: 'R2', port: 'GigabitEthernet0/0/1', ip: '10.0.23.2/24', note: '互联 R3' },
      { device: 'R3', port: 'GigabitEthernet0/0/0', ip: '10.0.23.3/24' },
      { device: 'R1', port: 'GigabitEthernet0/0/1', ip: '10.0.13.1/24', note: '互联 R3' },
      { device: 'R3', port: 'GigabitEthernet0/0/1', ip: '10.0.13.3/24' },
      { device: 'R1', port: 'LoopBack0', ip: '1.1.1.1/32', note: 'router-id 与业务网段' },
      { device: 'R2', port: 'LoopBack0', ip: '2.2.2.2/32' },
      { device: 'R3', port: 'LoopBack0', ip: '3.3.3.3/32' },
    ],
  ),

  'ospf-multi-area': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'], ['R3', 'AR2220'], ['R4', 'AR2220']],
    [
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
      ['R1', 'GigabitEthernet0/0/1', 'R3', 'GigabitEthernet0/0/0'],
      ['R2', 'GigabitEthernet0/0/1', 'R4', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'LoopBack0', ip: '1.1.1.1/32', note: '在 area 0' },
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '10.0.12.1/24', note: 'area 0' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '10.0.12.2/24', note: 'area 0' },
      { device: 'R1', port: 'GigabitEthernet0/0/1', ip: '10.0.13.1/24', note: 'area 1（R1 为 ABR）' },
      { device: 'R3', port: 'GigabitEthernet0/0/0', ip: '10.0.13.3/24', note: 'area 1' },
      { device: 'R2', port: 'GigabitEthernet0/0/1', ip: '10.0.24.2/24', note: 'area 2（R2 为 ABR）' },
      { device: 'R4', port: 'GigabitEthernet0/0/0', ip: '10.0.24.4/24', note: 'area 2' },
    ],
  ),

  'ospf-stub-nssa': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'], ['R3', 'AR2220'], ['R4', 'AR2220']],
    [
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
      ['R1', 'GigabitEthernet0/0/1', 'R3', 'GigabitEthernet0/0/0'],
      ['R1', 'GigabitEthernet0/0/2', 'R4', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '10.0.12.1/24', note: 'area 0' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '10.0.12.2/24', note: 'area 0' },
      { device: 'R1', port: 'GigabitEthernet0/0/1', ip: '10.0.13.1/24', note: 'area 1 → stub' },
      { device: 'R3', port: 'GigabitEthernet0/0/0', ip: '10.0.13.3/24', note: 'area 1' },
      { device: 'R1', port: 'GigabitEthernet0/0/2', ip: '10.0.14.1/24', note: 'area 2 → nssa' },
      { device: 'R4', port: 'GigabitEthernet0/0/0', ip: '10.0.14.4/24', note: 'area 2' },
    ],
  ),

  'ospf-virtual-link': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'], ['R3', 'AR2220']],
    [
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
      ['R2', 'GigabitEthernet0/0/1', 'R3', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '10.0.12.1/24', note: 'area 0' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '10.0.12.2/24', note: 'area 0' },
      { device: 'R2', port: 'GigabitEthernet0/0/1', ip: '10.0.23.2/24', note: 'area 1（transit）' },
      { device: 'R3', port: 'GigabitEthernet0/0/0', ip: '10.0.23.3/24', note: 'area 1' },
      { device: 'R3', port: 'LoopBack0', ip: '3.3.3.3/32', note: '虚拟链路的两端 router-id' },
    ],
  ),

  'bgp-ebgp-ibgp': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'], ['R3', 'AR2220']],
    [
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
      ['R2', 'GigabitEthernet0/0/1', 'R3', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'LoopBack0', ip: '1.1.1.1/32', note: 'AS 100' },
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '10.0.12.1/24', note: 'AS 100' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '10.0.12.2/24', note: 'AS 100' },
      { device: 'R2', port: 'GigabitEthernet0/0/1', ip: '10.0.23.2/24', note: 'AS 100 → EBGP' },
      { device: 'R3', port: 'GigabitEthernet0/0/0', ip: '10.0.23.3/24', note: 'AS 200' },
      { device: 'R3', port: 'LoopBack0', ip: '3.3.3.3/32', note: 'AS 200 业务网段' },
    ],
  ),

  'bgp-route-reflector': lab(
    [['RR', 'AR2220'], ['R2', 'AR2220'], ['R3', 'AR2220'], ['EXT', 'AR2220']],
    [
      ['RR', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
      ['RR', 'GigabitEthernet0/0/1', 'R3', 'GigabitEthernet0/0/0'],
      ['R2', 'GigabitEthernet0/0/1', 'EXT', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'RR', port: 'LoopBack0', ip: '10.1.1.1/32', note: 'AS 100 内 reflector' },
      { device: 'RR', port: 'GigabitEthernet0/0/0', ip: '10.1.12.1/24', note: 'AS 100' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '10.1.12.2/24', note: 'AS 100 client' },
      { device: 'RR', port: 'GigabitEthernet0/0/1', ip: '10.1.13.1/24', note: 'AS 100' },
      { device: 'R3', port: 'GigabitEthernet0/0/0', ip: '10.1.13.3/24', note: 'AS 100 client' },
      { device: 'R2', port: 'GigabitEthernet0/0/1', ip: '10.1.24.2/24', note: 'AS 100 → EBGP' },
      { device: 'EXT', port: 'GigabitEthernet0/0/0', ip: '10.1.24.4/24', note: 'AS 200' },
    ],
  ),

  'route-policy-pbr': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'], ['R3', 'AR2220'],
      PC('PC1', '192.168.1.1', '255.255.255.0', '192.168.1.254')],
    [
      ['PC1', 'Ethernet0/0/1', 'R1', 'GigabitEthernet0/0/2'],
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
      ['R1', 'GigabitEthernet0/0/1', 'R3', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/2', ip: '192.168.1.254/24', note: 'PC1 网关' },
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '10.0.12.1/24', note: '出口 1' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '10.0.12.2/24' },
      { device: 'R1', port: 'GigabitEthernet0/0/1', ip: '10.0.13.1/24', note: '出口 2' },
      { device: 'R3', port: 'GigabitEthernet0/0/0', ip: '10.0.13.3/24' },
      { device: 'R2', port: 'LoopBack0', ip: '2.2.2.2/32', note: '同一目的网段的两个出口' },
      { device: 'R3', port: 'LoopBack0', ip: '2.2.2.2/32', note: '与出口 1 相同的地址，用于观察选路' },
    ],
  ),

  // --------------------------------------------------------------- IP services
  'dhcp': lab(
    [['R1', 'AR2220'], ['SW1', 'S5700'],
      PC('PC1', 'dhcp', '255.255.255.0', '192.168.10.254'),
      PC('PC2', 'dhcp', '255.255.255.0', '192.168.10.254')],
    [
      ['PC1', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/1'],
      ['PC2', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/2'],
      ['SW1', 'GigabitEthernet0/0/23', 'R1', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '192.168.10.254/24', note: '地址池网关' },
      { device: 'R1', port: 'LoopBack0', ip: '1.1.1.1/32', note: 'router-id' },
    ],
  ),

  'dhcp-snooping': lab(
    [['SW1', 'S5700'], ['R1', 'AR2220'],
      PC('PC1', '192.168.10.1', '255.255.255.0', '192.168.10.254')],
    [
      ['PC1', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/1'],
      ['SW1', 'GigabitEthernet0/0/24', 'R1', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '192.168.10.254/24', note: 'DHCP 服务器' },
      { device: 'SW1', port: 'Vlanif10', ip: '192.168.10.253/24', note: '管理地址' },
    ],
  ),

  'nat': lab(
    [['R1', 'AR2220'], ['ISP', 'AR2220'],
      PC('PC1', '192.168.1.1', '255.255.255.0', '192.168.1.254')],
    [
      ['PC1', 'Ethernet0/0/1', 'R1', 'GigabitEthernet0/0/1'],
      ['R1', 'GigabitEthernet0/0/0', 'ISP', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/1', ip: '192.168.1.254/24', note: '内网网关' },
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '200.1.1.1/30', note: '公网侧（NAT outside）' },
      { device: 'ISP', port: 'GigabitEthernet0/0/0', ip: '200.1.1.2/30', note: '模拟运营商' },
      { device: 'ISP', port: 'LoopBack0', ip: '8.8.8.8/32', note: '模拟 Internet 目的地址' },
    ],
  ),

  'acl-filter': lab(
    [['R1', 'AR2220'], ['SW1', 'S5700'],
      PC('PC1', '192.168.10.1', '255.255.255.0', '192.168.10.254'),
      PC('PC2', '192.168.20.1', '255.255.255.0', '192.168.20.254')],
    [
      ['PC1', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/1'],
      ['PC2', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/2'],
      ['SW1', 'GigabitEthernet0/0/24', 'R1', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '192.168.10.254/24', note: 'PC1 网关，ACL 挂这里' },
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '192.168.20.253/24', note: '同接口从地址' },
    ],
  ),

  'qos-basics': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'],
      PC('PC1', '192.168.1.1', '255.255.255.0', '192.168.1.254')],
    [
      ['PC1', 'Ethernet0/0/1', 'R1', 'GigabitEthernet0/0/1'],
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/1', ip: '192.168.1.254/24', note: '入方向做流分类' },
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '10.0.12.1/24', note: '出方向做限速' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '10.0.12.2/24' },
    ],
  ),

  // --------------------------------------------------------------- reliability
  'vrrp-basics': lab(
    [['SW1', 'S5700'], ['SW2', 'S5700'], ['ACC', 'S5700'],
      PC('PC1', '192.168.10.1', '255.255.255.0', '192.168.10.254')],
    [
      ['PC1', 'Ethernet0/0/1', 'ACC', 'GigabitEthernet0/0/1'],
      ['ACC', 'GigabitEthernet0/0/23', 'SW1', 'GigabitEthernet0/0/1'],
      ['ACC', 'GigabitEthernet0/0/24', 'SW2', 'GigabitEthernet0/0/1'],
    ],
    [
      { device: 'SW1', port: 'Vlanif10', ip: '192.168.10.252/24', note: 'VRRP 主，虚拟地址 .254' },
      { device: 'SW2', port: 'Vlanif10', ip: '192.168.10.253/24', note: 'VRRP 备' },
      { device: 'SW1', port: 'Vlanif100', ip: '10.0.100.1/24', note: '上行互联' },
      { device: 'SW2', port: 'Vlanif100', ip: '10.0.100.2/24', note: '上行互联' },
    ],
  ),

  'bfd-fast-convergence': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'], ['R3', 'AR2220']],
    [
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
      ['R2', 'GigabitEthernet0/0/1', 'R3', 'GigabitEthernet0/0/0'],
      ['R1', 'GigabitEthernet0/0/1', 'R3', 'GigabitEthernet0/0/1'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '10.0.12.1/24' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '10.0.12.2/24' },
      { device: 'R2', port: 'GigabitEthernet0/0/1', ip: '10.0.23.2/24' },
      { device: 'R3', port: 'GigabitEthernet0/0/0', ip: '10.0.23.3/24' },
      { device: 'R1', port: 'GigabitEthernet0/0/1', ip: '10.0.13.1/24' },
      { device: 'R3', port: 'GigabitEthernet0/0/1', ip: '10.0.13.3/24' },
      { device: 'R1', port: 'LoopBack0', ip: '1.1.1.1/32' },
      { device: 'R3', port: 'LoopBack0', ip: '3.3.3.3/32' },
    ],
  ),

  'dual-homed-isp': lab(
    [['R1', 'AR2220'], ['ISP1', 'AR2220'], ['ISP2', 'AR2220'],
      PC('PC1', '192.168.1.1', '255.255.255.0', '192.168.1.254')],
    [
      ['PC1', 'Ethernet0/0/1', 'R1', 'GigabitEthernet0/0/2'],
      ['R1', 'GigabitEthernet0/0/0', 'ISP1', 'GigabitEthernet0/0/0'],
      ['R1', 'GigabitEthernet0/0/1', 'ISP2', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/2', ip: '192.168.1.254/24', note: '内网' },
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '200.1.1.1/30', note: 'ISP1' },
      { device: 'ISP1', port: 'GigabitEthernet0/0/0', ip: '200.1.1.2/30' },
      { device: 'R1', port: 'GigabitEthernet0/0/1', ip: '201.1.1.1/30', note: 'ISP2' },
      { device: 'ISP2', port: 'GigabitEthernet0/0/0', ip: '201.1.1.2/30' },
      { device: 'ISP1', port: 'LoopBack0', ip: '8.8.8.8/32', note: '仅 ISP1 宣告，用于观察回程选路' },
    ],
  ),

  'firewall-zones': lab(
    [['FW1', 'USG6000V'], ['R-TRUST', 'AR2220'], ['R-UNTRUST', 'AR2220'],
      { name: 'SRV1', model: 'Server' }],
    [
      ['R-TRUST', 'GigabitEthernet0/0/0', 'FW1', 'GigabitEthernet1/0/0'],
      ['FW1', 'GigabitEthernet1/0/1', 'R-UNTRUST', 'GigabitEthernet0/0/0'],
      ['FW1', 'GigabitEthernet1/0/2', 'SRV1', 'Ethernet0/0/1'],
    ],
    [
      { device: 'R-TRUST', port: 'GigabitEthernet0/0/0', ip: '10.1.1.254/24', note: 'trust 侧（接防火墙）' },
      { device: 'FW1', port: 'GigabitEthernet1/0/0', ip: '10.1.1.1/24', note: 'trust 区域' },
      { device: 'FW1', port: 'GigabitEthernet1/0/1', ip: '200.1.1.1/24', note: 'untrust 区域' },
      { device: 'R-UNTRUST', port: 'GigabitEthernet0/0/0', ip: '200.1.1.2/24', note: '外网侧' },
      { device: 'FW1', port: 'GigabitEthernet1/0/2', ip: '10.1.40.1/24', note: 'dmz 区域' },
      { device: 'SRV1', port: 'Ethernet0/0/1', ip: '10.1.40.10/24', note: '对外发布的服务器' },
    ],
  ),

  'firewall-hrp': lab(
    [['FW1', 'USG6000V'], ['FW2', 'USG6000V'], ['R-UP', 'AR2220'], ['R-DOWN', 'AR2220']],
    [
      ['R-UP', 'GigabitEthernet0/0/0', 'FW1', 'GigabitEthernet1/0/0'],
      ['R-UP', 'GigabitEthernet0/0/1', 'FW2', 'GigabitEthernet1/0/0'],
      ['FW1', 'GigabitEthernet1/0/1', 'R-DOWN', 'GigabitEthernet0/0/0'],
      ['FW2', 'GigabitEthernet1/0/1', 'R-DOWN', 'GigabitEthernet0/0/1'],
      ['FW1', 'GigabitEthernet1/0/2', 'FW2', 'GigabitEthernet1/0/2'],
    ],
    [
      { device: 'FW1', port: 'GigabitEthernet1/0/0', ip: '10.1.250.1/24', note: 'VRRP 组 350，虚拟 .253' },
      { device: 'FW2', port: 'GigabitEthernet1/0/0', ip: '10.1.250.2/24', note: '备机同组' },
      { device: 'FW1', port: 'GigabitEthernet1/0/1', ip: '10.1.249.1/24', note: 'VRRP 组 349，虚拟 .254' },
      { device: 'FW2', port: 'GigabitEthernet1/0/1', ip: '10.1.249.2/24' },
      { device: 'FW1', port: 'GigabitEthernet1/0/2', ip: '10.1.252.1/24', note: 'HRP 心跳，直连' },
      { device: 'FW2', port: 'GigabitEthernet1/0/2', ip: '10.1.252.2/24' },
      { device: 'R-UP', port: 'GigabitEthernet0/0/0', ip: '10.1.250.10/24', note: '外网侧' },
      { device: 'R-DOWN', port: 'GigabitEthernet0/0/0', ip: '10.1.249.10/24', note: '内网侧' },
    ],
  ),

  // ------------------------------------------------------------------- multicast
  'multicast-pim-sm': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'], ['R3', 'AR2220'],
      PC('SRC', '192.168.2.100', '255.255.255.0', '192.168.2.254'),
      PC('RCV', '192.168.3.100', '255.255.255.0', '192.168.3.254')],
    [
      ['SRC', 'Ethernet0/0/1', 'R2', 'GigabitEthernet0/0/1'],
      ['RCV', 'Ethernet0/0/1', 'R3', 'GigabitEthernet0/0/1'],
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
      ['R1', 'GigabitEthernet0/0/1', 'R3', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'LoopBack0', ip: '1.1.1.1/32', note: '候选 RP（静态 RP 时指向它）' },
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '10.0.12.1/24' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '10.0.12.2/24' },
      { device: 'R1', port: 'GigabitEthernet0/0/1', ip: '10.0.13.1/24' },
      { device: 'R3', port: 'GigabitEthernet0/0/0', ip: '10.0.13.3/24' },
      { device: 'R2', port: 'GigabitEthernet0/0/1', ip: '192.168.2.254/24', note: '组播源网段' },
      { device: 'R3', port: 'GigabitEthernet0/0/1', ip: '192.168.3.254/24', note: '接收者网段' },
    ],
  ),

  // ----------------------------------------------------------------------- MPLS
  'mpls-basic': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'], ['R3', 'AR2220'], ['R4', 'AR2220']],
    [
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
      ['R2', 'GigabitEthernet0/0/1', 'R3', 'GigabitEthernet0/0/0'],
      ['R3', 'GigabitEthernet0/0/1', 'R4', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'LoopBack0', ip: '1.1.1.1/32', note: 'LSR-ID' },
      { device: 'R2', port: 'LoopBack0', ip: '2.2.2.2/32' },
      { device: 'R3', port: 'LoopBack0', ip: '3.3.3.3/32' },
      { device: 'R4', port: 'LoopBack0', ip: '4.4.4.4/32' },
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '10.0.12.1/24' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '10.0.12.2/24' },
      { device: 'R2', port: 'GigabitEthernet0/0/1', ip: '10.0.23.2/24' },
      { device: 'R3', port: 'GigabitEthernet0/0/0', ip: '10.0.23.3/24' },
      { device: 'R3', port: 'GigabitEthernet0/0/1', ip: '10.0.34.3/24' },
      { device: 'R4', port: 'GigabitEthernet0/0/0', ip: '10.0.34.4/24' },
    ],
  ),

  'mpls-l3vpn': lab(
    [['PE1', 'AR2220'], ['P', 'AR2220'], ['PE2', 'AR2220'], ['CE1', 'AR2220'], ['CE2', 'AR2220']],
    [
      ['CE1', 'GigabitEthernet0/0/0', 'PE1', 'GigabitEthernet0/0/1'],
      ['PE1', 'GigabitEthernet0/0/0', 'P', 'GigabitEthernet0/0/0'],
      ['P', 'GigabitEthernet0/0/1', 'PE2', 'GigabitEthernet0/0/0'],
      ['PE2', 'GigabitEthernet0/0/1', 'CE2', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'PE1', port: 'LoopBack0', ip: '1.1.1.1/32', note: 'MP-BGP 的 router-id' },
      { device: 'P', port: 'LoopBack0', ip: '2.2.2.2/32' },
      { device: 'PE2', port: 'LoopBack0', ip: '3.3.3.3/32' },
      { device: 'PE1', port: 'GigabitEthernet0/0/0', ip: '10.0.12.1/24', note: '骨干' },
      { device: 'P', port: 'GigabitEthernet0/0/0', ip: '10.0.12.2/24' },
      { device: 'P', port: 'GigabitEthernet0/0/1', ip: '10.0.23.2/24' },
      { device: 'PE2', port: 'GigabitEthernet0/0/0', ip: '10.0.23.3/24' },
      { device: 'PE1', port: 'GigabitEthernet0/0/1', ip: '192.168.1.1/24', note: 'VPN 实例 vrf-a' },
      { device: 'CE1', port: 'GigabitEthernet0/0/0', ip: '192.168.1.10/24' },
      { device: 'PE2', port: 'GigabitEthernet0/0/1', ip: '192.168.1.2/24', note: '同一地址空间，站点隔离' },
      { device: 'CE2', port: 'GigabitEthernet0/0/0', ip: '192.168.1.20/24' },
    ],
  ),

  // ------------------------------------------------------------------ security
  'ipsec-vpn': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'],
      PC('PC1', '192.168.1.1', '255.255.255.0', '192.168.1.254'),
      PC('PC2', '192.168.2.1', '255.255.255.0', '192.168.2.254')],
    [
      ['PC1', 'Ethernet0/0/1', 'R1', 'GigabitEthernet0/0/1'],
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
      ['R2', 'GigabitEthernet0/0/1', 'PC2', 'Ethernet0/0/1'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/1', ip: '192.168.1.254/24', note: '私网侧' },
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '200.1.1.1/24', note: '公网侧' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '200.1.1.2/24', note: '公网侧' },
      { device: 'R2', port: 'GigabitEthernet0/0/1', ip: '192.168.2.254/24', note: '私网侧' },
    ],
  ),

  'aaa-local': lab(
    [['R1', 'AR2220'],
      { name: 'ADMIN', model: 'PC', ip: '192.168.1.100', mask: '255.255.255.0', gateway: '192.168.1.254' }],
    [
      ['ADMIN', 'Ethernet0/0/1', 'R1', 'GigabitEthernet0/0/1'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/1', ip: '192.168.1.254/24', note: '管理网段' },
    ],
  ),

  'network-management': lab(
    [['R1', 'AR2220'], ['SW1', 'S5700'],
      { name: 'NMS', model: 'PC', ip: '10.1.30.100', mask: '255.255.255.0', gateway: '10.1.30.254' }],
    [
      ['NMS', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/1'],
      ['SW1', 'GigabitEthernet0/0/24', 'R1', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '10.1.30.254/24', note: 'NMS 网段' },
      { device: 'R1', port: 'LoopBack0', ip: '1.1.1.1/32', note: '设备管理地址' },
      { device: 'SW1', port: 'Vlanif30', ip: '10.1.30.2/24', note: '设备管理地址' },
    ],
  ),

  'ipv6': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220']],
    [
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '2001:db8:12::1/64', note: 'IPv6 互联' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '2001:db8:12::2/64' },
      { device: 'R1', port: 'LoopBack0', ip: '2001:db8:1::1/128' },
      { device: 'R2', port: 'LoopBack0', ip: '2001:db8:2::2/128' },
    ],
  ),

  'isis-multi-level': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'], ['R3', 'AR2220'], ['R4', 'AR2220']],
    [
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
      ['R2', 'GigabitEthernet0/0/1', 'R3', 'GigabitEthernet0/0/0'],
      ['R2', 'GigabitEthernet0/0/2', 'R4', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '10.0.12.1/24', note: 'level-1' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '10.0.12.2/24', note: 'level-1-2' },
      { device: 'R2', port: 'GigabitEthernet0/0/1', ip: '10.0.23.2/24', note: 'level-1' },
      { device: 'R3', port: 'GigabitEthernet0/0/0', ip: '10.0.23.3/24', note: 'level-1' },
      { device: 'R2', port: 'GigabitEthernet0/0/2', ip: '10.0.24.2/24', note: 'level-2' },
      { device: 'R4', port: 'GigabitEthernet0/0/0', ip: '10.0.24.4/24', note: 'level-2' },
      { device: 'R1', port: 'LoopBack0', ip: '1.1.1.1/32' },
      { device: 'R3', port: 'LoopBack0', ip: '3.3.3.3/32' },
      { device: 'R4', port: 'LoopBack0', ip: '4.4.4.4/32' },
    ],
  ),

  // -------------------------------------------------------------- comprehensive
  'campus-network': lab(
    [
      ['CORE1', 'S5700'], ['CORE2', 'S5700'],
      ['ACC1', 'S5700'], ['ACC2', 'S5700'],
      ['EDGE1', 'AR2220'], ['EDGE2', 'AR2220'], ['FW1', 'USG6000V'],
      ['SRV-SW', 'S5700'], { name: 'SRV1', model: 'Server' },
      PC('PC1', '10.1.10.1', '255.255.255.0', '10.1.10.254'),
      PC('PC2', '10.1.20.1', '255.255.255.0', '10.1.20.254'),
    ],
    [
      ['CORE1', 'GigabitEthernet0/0/23', 'CORE2', 'GigabitEthernet0/0/23'],
      ['CORE1', 'GigabitEthernet0/0/24', 'CORE2', 'GigabitEthernet0/0/24'],
      ['CORE1', 'GigabitEthernet0/0/1', 'ACC1', 'GigabitEthernet0/0/23'],
      ['CORE2', 'GigabitEthernet0/0/1', 'ACC1', 'GigabitEthernet0/0/24'],
      ['CORE1', 'GigabitEthernet0/0/2', 'ACC2', 'GigabitEthernet0/0/23'],
      ['CORE2', 'GigabitEthernet0/0/2', 'ACC2', 'GigabitEthernet0/0/24'],
      ['ACC1', 'GigabitEthernet0/0/1', 'PC1', 'Ethernet0/0/1'],
      ['ACC2', 'GigabitEthernet0/0/1', 'PC2', 'Ethernet0/0/1'],
      ['CORE1', 'GigabitEthernet0/0/3', 'EDGE1', 'GigabitEthernet0/0/0'],
      ['CORE2', 'GigabitEthernet0/0/3', 'EDGE2', 'GigabitEthernet0/0/0'],
      ['EDGE1', 'GigabitEthernet0/0/1', 'FW1', 'GigabitEthernet1/0/0'],
      ['EDGE2', 'GigabitEthernet0/0/1', 'FW1', 'GigabitEthernet1/0/1'],
      ['FW1', 'GigabitEthernet1/0/2', 'SRV-SW', 'GigabitEthernet0/0/1'],
      ['SRV-SW', 'GigabitEthernet0/0/2', 'SRV1', 'Ethernet0/0/1'],
    ],
    [
      { device: 'CORE1', port: 'Vlanif10', ip: '10.1.10.252/24', note: 'PC 网段网关（VRRP 主）' },
      { device: 'CORE2', port: 'Vlanif10', ip: '10.1.10.253/24', note: 'VRRP 备' },
      { device: 'CORE1', port: 'Vlanif20', ip: '10.1.20.252/24' },
      { device: 'CORE2', port: 'Vlanif20', ip: '10.1.20.253/24' },
      { device: 'CORE1', port: 'Vlanif31', ip: '10.1.31.1/24', note: '设备管理网段' },
      { device: 'CORE2', port: 'Vlanif31', ip: '10.1.31.2/24' },
      { device: 'EDGE1', port: 'GigabitEthernet0/0/0', ip: '10.1.31.11/24', note: '出口到核心' },
      { device: 'EDGE2', port: 'GigabitEthernet0/0/0', ip: '10.1.31.12/24' },
      { device: 'EDGE1', port: 'GigabitEthernet0/0/1', ip: '10.1.250.1/24', note: '出口到防火墙（内外两段）' },
      { device: 'EDGE2', port: 'GigabitEthernet0/0/1', ip: '10.1.250.2/24' },
      { device: 'FW1', port: 'GigabitEthernet1/0/0', ip: '10.1.249.1/24', note: 'trust 区域' },
      { device: 'FW1', port: 'GigabitEthernet1/0/1', ip: '10.1.250.254/24', note: 'untrust 区域' },
      { device: 'FW1', port: 'GigabitEthernet1/0/2', ip: '10.1.40.1/24', note: 'dmz 区域' },
      { device: 'SRV1', port: 'Ethernet0/0/1', ip: '10.1.40.10/24', note: '对外发布服务器' },
    ],
    {
      CORE1: [140, 90], CORE2: [420, 90],
      ACC1: [60, 300], ACC2: [500, 300],
      PC1: [20, 470], PC2: [560, 470],
      EDGE1: [140, 220], EDGE2: [420, 220],
      FW1: [660, 220], 'SRV-SW': [860, 220], SRV1: [860, 380],
    },
  ),

  // ------------------------------------------------- the rest of the catalogue
  // Every scenario ships a blueprint so `ensp preset <id> --topo` never dead-ends.
  // These are built from the device counts already stated in each scenario's
  // `devices` field, kept deliberately small: they exist to remove the drawing
  // and the IP arithmetic, not to preconfigure anything.

  'super-vlan': lab(
    [['SW1', 'S5700'],
      PC('PC1', '192.168.10.1', '255.255.255.0', '192.168.10.254'),
      PC('PC2', '192.168.20.1', '255.255.255.0', '192.168.20.254'),
      PC('PC3', '192.168.20.2', '255.255.255.0', '192.168.20.254')],
    [
      ['PC1', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/1'],
      ['PC2', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/2'],
      ['PC3', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/3'],
    ],
    [
      { device: 'SW1', port: 'Vlanif10', ip: '192.168.10.254/24', note: 'super-VLAN 网关' },
      { device: 'SW1', port: 'Vlanif20', ip: '192.168.20.254/24', note: 'sub-VLAN 20' },
      { device: 'SW1', port: 'Vlanif30', ip: '192.168.30.254/24', note: 'sub-VLAN 30' },
    ],
  ),

  'rip': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'], ['R3', 'AR2220'],
      PC('PC1', '192.168.1.1', '255.255.255.0', '192.168.1.254'),
      PC('PC2', '192.168.3.1', '255.255.255.0', '192.168.3.254')],
    [
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
      ['R2', 'GigabitEthernet0/0/1', 'R3', 'GigabitEthernet0/0/0'],
      ['R1', 'GigabitEthernet0/0/1', 'PC1', 'Ethernet0/0/1'],
      ['R3', 'GigabitEthernet0/0/1', 'PC2', 'Ethernet0/0/1'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '10.0.12.1/24', note: '互联 R2' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '10.0.12.2/24' },
      { device: 'R2', port: 'GigabitEthernet0/0/1', ip: '10.0.23.2/24', note: '互联 R3' },
      { device: 'R3', port: 'GigabitEthernet0/0/0', ip: '10.0.23.3/24' },
      { device: 'R1', port: 'GigabitEthernet0/0/1', ip: '192.168.1.254/24', note: 'PC1 网关' },
      { device: 'R3', port: 'GigabitEthernet0/0/1', ip: '192.168.3.254/24', note: 'PC2 网关' },
    ],
  ),

  'ospf-lsa-types': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'], ['R3', 'AR2220'], ['R4', 'AR2220']],
    [
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
      ['R2', 'GigabitEthernet0/0/1', 'R3', 'GigabitEthernet0/0/0'],
      ['R3', 'GigabitEthernet0/0/1', 'R4', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '10.0.12.1/24', note: 'area 1' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '10.0.12.2/24' },
      { device: 'R2', port: 'GigabitEthernet0/0/1', ip: '10.0.23.2/24', note: 'area 0' },
      { device: 'R3', port: 'GigabitEthernet0/0/0', ip: '10.0.23.3/24' },
      { device: 'R3', port: 'GigabitEthernet0/0/1', ip: '10.0.34.3/24', note: 'area 2 / stub' },
      { device: 'R4', port: 'GigabitEthernet0/0/0', ip: '10.0.34.4/24' },
      { device: 'R1', port: 'LoopBack0', ip: '1.1.1.1/32', note: 'Type-1 观察点' },
      { device: 'R2', port: 'LoopBack0', ip: '2.2.2.2/32', note: 'ABR' },
      { device: 'R3', port: 'LoopBack0', ip: '3.3.3.3/32', note: 'ABR' },
      { device: 'R4', port: 'LoopBack0', ip: '4.4.4.4/32', note: 'ASBR 外部路由' },
    ],
  ),

  'ospf-troubleshooting': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'], ['R3', 'AR2220']],
    [
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
      ['R2', 'GigabitEthernet0/0/1', 'R3', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '10.0.12.1/24', note: '故意配错 area 做排障' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '10.0.12.2/24' },
      { device: 'R2', port: 'GigabitEthernet0/0/1', ip: '10.0.23.2/24' },
      { device: 'R3', port: 'GigabitEthernet0/0/0', ip: '10.0.23.3/24' },
      { device: 'R2', port: 'LoopBack0', ip: '2.2.2.2/32', note: 'router-id 冲突观察点' },
      { device: 'R3', port: 'LoopBack0', ip: '2.2.2.2/32' },
    ],
  ),

  'bgp-attributes': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'], ['R3', 'AR2220'], ['R4', 'AR2220']],
    [
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
      ['R1', 'GigabitEthernet0/0/1', 'R3', 'GigabitEthernet0/0/0'],
      ['R2', 'GigabitEthernet0/0/1', 'R4', 'GigabitEthernet0/0/0'],
      ['R3', 'GigabitEthernet0/0/1', 'R4', 'GigabitEthernet0/0/1'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '10.0.12.1/24', note: 'AS 100 双出口' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '10.0.12.2/24', note: 'AS 200' },
      { device: 'R1', port: 'GigabitEthernet0/0/1', ip: '10.0.13.1/24' },
      { device: 'R3', port: 'GigabitEthernet0/0/0', ip: '10.0.13.3/24', note: 'AS 300' },
      { device: 'R2', port: 'GigabitEthernet0/0/1', ip: '10.0.24.2/24' },
      { device: 'R4', port: 'GigabitEthernet0/0/0', ip: '10.0.24.4/24', note: 'AS 400 选路观察点' },
      { device: 'R3', port: 'GigabitEthernet0/0/1', ip: '10.0.34.3/24' },
      { device: 'R4', port: 'GigabitEthernet0/0/1', ip: '10.0.34.4/24' },
    ],
  ),

  'bgp-aggregation': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'], ['R3', 'AR2220']],
    [
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
      ['R2', 'GigabitEthernet0/0/1', 'R3', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '10.0.12.1/24', note: 'AS 100，发布明细' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '10.0.12.2/24', note: 'AS 200，做聚合' },
      { device: 'R2', port: 'GigabitEthernet0/0/1', ip: '10.0.23.2/24' },
      { device: 'R3', port: 'GigabitEthernet0/0/0', ip: '10.0.23.3/24', note: 'AS 300，验证 AS_PATH' },
      { device: 'R1', port: 'LoopBack0', ip: '10.10.1.1/24', note: '聚合前明细 1' },
      { device: 'R1', port: 'LoopBack1', ip: '10.10.2.1/24', note: '聚合前明细 2' },
      { device: 'R1', port: 'LoopBack2', ip: '10.10.3.1/24', note: '聚合前明细 3' },
    ],
  ),

  'bgp-troubleshooting': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'], ['R3', 'AR2220']],
    [
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
      ['R2', 'GigabitEthernet0/0/1', 'R3', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '10.0.12.1/24', note: 'AS 100' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '10.0.12.2/24', note: 'AS 200' },
      { device: 'R2', port: 'GigabitEthernet0/0/1', ip: '10.0.23.2/24' },
      { device: 'R3', port: 'GigabitEthernet0/0/0', ip: '10.0.23.3/24', note: 'AS 300' },
      { device: 'R1', port: 'LoopBack0', ip: '1.1.1.1/32', note: 'TCP 179 源地址' },
      { device: 'R3', port: 'LoopBack0', ip: '3.3.3.3/32' },
    ],
  ),

  'stack-istack': lab(
    [['SW1', 'S5700'], ['SW2', 'S5700'], ['SW3', 'S5700'],
      PC('PC1', '192.168.10.1', '255.255.255.0', '192.168.10.254'),
      PC('PC2', '192.168.10.2', '255.255.255.0', '192.168.10.254')],
    [
      ['SW1', 'GigabitEthernet0/0/1', 'SW2', 'GigabitEthernet0/0/1'],
      ['SW2', 'GigabitEthernet0/0/2', 'SW3', 'GigabitEthernet0/0/1'],
      ['PC1', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/23'],
      ['PC2', 'Ethernet0/0/1', 'SW3', 'GigabitEthernet0/0/23'],
    ],
    [
      { device: 'SW1', port: 'Vlanif10', ip: '192.168.10.251/24', note: '堆叠主，唯一管理地址' },
      { device: 'SW2', port: 'Vlanif10', ip: '192.168.10.252/24', note: '堆叠备' },
      { device: 'SW3', port: 'Vlanif10', ip: '192.168.10.253/24', note: '接入设备' },
    ],
  ),

  // PPP and HDLC need real serial ports: an AR2220 rejects `link-protocol ppp` on a
  // GE port with an empty error, so that path cannot be configured at all. The
  // `Router` model carries four Serial ports out of the box, which is what this
  // scenario is about, so both links ride Serial0/0/0 and Serial0/0/1.
  'ppp-hdlc': lab(
    [['R1', 'Router'], ['R2', 'Router']],
    [['R1', 'Serial0/0/0', 'R2', 'Serial0/0/0'],
      ['R1', 'Serial0/0/1', 'R2', 'Serial0/0/1']],
    [
      { device: 'R1', port: 'Serial0/0/0', ip: '10.0.12.1/30', note: 'link-protocol ppp + CHAP' },
      { device: 'R2', port: 'Serial0/0/0', ip: '10.0.12.2/30' },
      { device: 'R1', port: 'Serial0/0/1', ip: '10.0.13.1/30', note: 'link-protocol hdlc 对照' },
      { device: 'R2', port: 'Serial0/0/1', ip: '10.0.13.2/30' },
    ],
  ),

  'arp-security': lab(
    [['SW1', 'S5700'],
      PC('PC1', '192.168.10.1', '255.255.255.0', '192.168.10.254'),
      PC('PC2', '192.168.10.2', '255.255.255.0', '192.168.10.254'),
      PC('PC3', '192.168.10.3', '255.255.255.0', '192.168.10.254')],
    [
      ['PC1', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/1'],
      ['PC2', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/2'],
      ['PC3', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/3'],
    ],
    [
      { device: 'SW1', port: 'Vlanif10', ip: '192.168.10.254/24', note: '网关兼 DHCP Snooping 设备' },
    ],
  ),

  'wlan-basic': lab(
    [['AC', 'AC6005'], ['AP1', 'AP6050'], ['SW1', 'S5700'],
      PC('PC1', '192.168.50.101', '255.255.255.0', '192.168.50.254')],
    [
      ['SW1', 'GigabitEthernet0/0/1', 'AC', 'GigabitEthernet0/0/1'],
      ['SW1', 'GigabitEthernet0/0/2', 'AP1', 'GigabitEthernet0/0/1'],
      ['SW1', 'GigabitEthernet0/0/3', 'PC1', 'Ethernet0/0/1'],
    ],
    [
      { device: 'AC', port: 'Vlanif100', ip: '192.168.100.1/24', note: 'CAPWAP 源与管理' },
      { device: 'AC', port: 'Vlanif50', ip: '192.168.50.254/24', note: '业务网关' },
      { device: 'SW1', port: 'Vlanif100', ip: '192.168.100.254/24', note: 'AP 管理网段' },
    ],
  ),

  'ospfv3-ipv6': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'], ['R3', 'AR2220']],
    [
      ['R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0'],
      ['R2', 'GigabitEthernet0/0/1', 'R3', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '2001:db8:12::1/64', note: 'OSPFv3 area 0' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '2001:db8:12::2/64' },
      { device: 'R2', port: 'GigabitEthernet0/0/1', ip: '2001:db8:23::2/64' },
      { device: 'R3', port: 'GigabitEthernet0/0/0', ip: '2001:db8:23::3/64' },
      { device: 'R3', port: 'LoopBack0', ip: '2001:db8:3::3/128', note: 'router-id 用 IPv4 地址' },
    ],
  ),

  'spine-leaf-vxlan': lab(
    [['SPINE1', 'S5700'], ['SPINE2', 'S5700'], ['LEAF1', 'S5700'], ['LEAF2', 'S5700'],
      PC('PC1', '192.168.10.1', '255.255.255.0', '192.168.10.254'),
      PC('PC2', '192.168.10.2', '255.255.255.0', '192.168.10.254')],
    [
      ['LEAF1', 'GigabitEthernet0/0/23', 'SPINE1', 'GigabitEthernet0/0/1'],
      ['LEAF1', 'GigabitEthernet0/0/24', 'SPINE2', 'GigabitEthernet0/0/1'],
      ['LEAF2', 'GigabitEthernet0/0/23', 'SPINE1', 'GigabitEthernet0/0/2'],
      ['LEAF2', 'GigabitEthernet0/0/24', 'SPINE2', 'GigabitEthernet0/0/2'],
      ['LEAF1', 'GigabitEthernet0/0/1', 'PC1', 'Ethernet0/0/1'],
      ['LEAF2', 'GigabitEthernet0/0/1', 'PC2', 'Ethernet0/0/1'],
    ],
    [
      { device: 'SPINE1', port: 'LoopBack0', ip: '10.0.255.11/32', note: 'BGP 邻居 / VTEP 源' },
      { device: 'SPINE2', port: 'LoopBack0', ip: '10.0.255.12/32' },
      { device: 'LEAF1', port: 'LoopBack0', ip: '10.0.255.21/32', note: 'VTEP' },
      { device: 'LEAF2', port: 'LoopBack0', ip: '10.0.255.22/32' },
      { device: 'LEAF1', port: 'Vlanif10', ip: '192.168.10.252/24', note: '分布式网关' },
      { device: 'LEAF2', port: 'Vlanif10', ip: '192.168.10.253/24' },
    ],
  ),

  'ipsec-gre-tunnel': lab(
    [['R1', 'AR2220'], ['R2', 'AR2220'], ['ISP', 'AR2220']],
    [
      ['R1', 'GigabitEthernet0/0/0', 'ISP', 'GigabitEthernet0/0/0'],
      ['ISP', 'GigabitEthernet0/0/1', 'R2', 'GigabitEthernet0/0/0'],
    ],
    [
      { device: 'R1', port: 'GigabitEthernet0/0/0', ip: '100.1.1.1/30', note: '公网侧' },
      { device: 'ISP', port: 'GigabitEthernet0/0/0', ip: '100.1.1.2/30' },
      { device: 'ISP', port: 'GigabitEthernet0/0/1', ip: '100.2.2.2/30' },
      { device: 'R2', port: 'GigabitEthernet0/0/0', ip: '100.2.2.1/30' },
      { device: 'R1', port: 'Tunnel0/0/0', ip: '10.1.1.1/24', note: 'GRE over IPsec' },
      { device: 'R2', port: 'Tunnel0/0/0', ip: '10.1.1.2/24' },
    ],
  ),

  'wlan-roaming': lab(
    [['AC', 'AC6005'], ['SW1', 'S5700'], ['SW2', 'S5700'],
      ['AP1', 'AP6050'], ['AP2', 'AP6050'],
      PC('PC1', '192.168.50.101', '255.255.255.0', '192.168.50.254')],
    [
      ['SW1', 'GigabitEthernet0/0/1', 'AC', 'GigabitEthernet0/0/1'],
      ['SW1', 'GigabitEthernet0/0/2', 'SW2', 'GigabitEthernet0/0/1'],
      ['SW1', 'GigabitEthernet0/0/3', 'AP1', 'GigabitEthernet0/0/1'],
      ['SW2', 'GigabitEthernet0/0/2', 'AP2', 'GigabitEthernet0/0/1'],
    ],
    [
      { device: 'AC', port: 'Vlanif100', ip: '192.168.100.1/24', note: 'CAPWAP 源' },
      { device: 'AC', port: 'Vlanif50', ip: '192.168.50.254/24', note: '业务网关（漫游域）' },
      { device: 'SW1', port: 'Vlanif100', ip: '192.168.100.252/24' },
      { device: 'SW2', port: 'Vlanif100', ip: '192.168.100.253/24' },
    ],
  ),
}

/** Scenario ids that ship a topology blueprint. */
export const LAB_IDS = Object.keys(LABS)

/** Whether a blueprint exists for this scenario. */
export function hasLab(id) {
  return Object.prototype.hasOwnProperty.call(LABS, id)
}

/**
 * Build a topology for a scenario blueprint.
 *
 * @param {string} id - scenario id
 * @param {{firstComPort?: number}} [options]
 * @returns {object} topology object ready for `writeTopology`
 */
export function buildScenarioTopology(id, { firstComPort = 2000 } = {}) {
  const spec = LABS[id]
  if (!spec) throw new Error(`no topology blueprint for scenario "${id}"; available: ${LAB_IDS.join(', ')}`)

  const builder = buildTopology({ firstComPort })
  for (const entry of spec.devices) {
    const [name, model] = Array.isArray(entry) ? entry : [entry.name, entry.model]
    // `ip: 'dhcp'` means the host should ask for an address instead of carrying a
    // static one; eNSP expresses that with -simpc_dhcp_state rather than an address.
    const options = Array.isArray(entry)
      ? {}
      : entry.ip === 'dhcp'
        ? { pc: { dhcp: true } }
        : entry.ip
          ? { pc: { ip: entry.ip, mask: entry.mask, gateway: entry.gateway } }
          : {}
    builder.add(name, model, options)
  }
  for (const [aName, aPort, bName, bPort] of spec.links) {
    builder.link(aName, aPort, bName, bPort)
  }

  const topo = builder.finish()
  autoLayout(topo)

  // Blueprints with hand-placed coordinates keep them; the grid is only ever a
  // fallback for the ones that do not care about layout.
  if (spec.positions) {
    for (const device of topo.devices) {
      const at = spec.positions[device.name]
      if (at) {
        device.x = at[0]
        device.y = at[1]
      }
    }
  }

  topo.meta = { scenario: id }
  return topo
}

/**
 * Addressing plan for a blueprint, as plain rows for display.
 *
 * @param {string} id
 * @returns {{device: string, port: string, ip: string, note: string}[]}
 */
export function labAddressing(id) {
  const spec = LABS[id]
  if (!spec) return []
  return spec.addressing.map((row) => ({ note: '', ...row }))
}

/** Device summary for a blueprint, e.g. `CORE1 (S5700)`. */
export function labDevices(id) {
  const spec = LABS[id]
  if (!spec) return []
  return spec.devices.map((entry) =>
    Array.isArray(entry) ? `${entry[0]} (${entry[1]})` : `${entry.name} (${entry.model})`,
  )
}

/**
 * Model names used by a blueprint, deduplicated.
 *
 * @param {string} id scenario id
 * @returns {string[]}
 */
export function labModels(id) {
  const spec = LABS[id]
  if (!spec) return []
  return [
    ...new Set(spec.devices.map((entry) => (Array.isArray(entry) ? entry[1] : entry.model))),
  ]
}
