
# dsh-ensp

Automation for Huawei eNSP: generate topologies, boot devices, push configuration line by line and verify every command's result.

- Generates `.topo` files eNSP opens directly, from built-in scenarios or custom devices and links
- Locates the toolbar buttons to start and stop devices, confirms each one individually, then minimises the window
- Pushes configuration one command at a time; the first error aborts the batch and reports the line, the command and the device's raw output
- Ships 23 scenario presets covering VLAN, STP, routing, BGP, NAT, ACL, IPsec, IPv6, WLAN and IS-IS
- Usable as a CLI, an MCP server, or a DeepSeek Harness plugin

Scroll down and open "dsh-ensp>" under the included components to reach its settings.

Full documentation: [repository](https://github.com/lizi600jin/dsh-ensp#readme).
