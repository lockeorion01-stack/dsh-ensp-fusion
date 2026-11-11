
# dsh-ensp

面向华为 eNSP 的自动化工具：生成拓扑、启动设备、逐条下发配置并核对每条命令的结果。

- 生成 eNSP 可直接打开的 `.topo` 文件，支持内置场景与自定义设备、链路
- 自动定位工具栏按钮完成设备启停，启动后按设备逐一确认就绪，窗口随即最小化
- 逐条下发配置，任一命令出错即中断并回报行号、命令与设备原始输出
- 内置 23 个场景预设，覆盖 VLAN、STP、路由、BGP、NAT、ACL、IPsec、IPv6、WLAN、IS-IS 等主题
- 提供 CLI、MCP Server 与 DeepSeek Harness 插件三种调用方式

向下翻页后点击“包含的组件”内的“dsh-ensp>”进入设置界面。

完整说明见 [仓库文档](https://github.com/lizi600jin/dsh-ensp#readme)。
