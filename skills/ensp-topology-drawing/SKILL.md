---
name: ensp-topology-drawing
description: Create or refine editable native eNSP topology layouts and resolve overlapping device names, interface labels, link annotations and layer titles using dsh-ensp-fusion. Use for drawing, reference reproduction, canvas layout or label collision requests.
---

# eNSP 原生拓扑绘图与标注避让

交付可编辑的原生拓扑及已核对的图面。只有方案请求时输出方案；现有工程美化、参考图复刻和新建拓扑分别处理。已有网络的绘图请求不自动扩大到设备配置或启停。

## 布局前

- 从实际输入取得设备 UUID/名称/型号/MAC/console 端口、接口/slot 声明、每个链路接口对、终端 settings 和配置资产关联，建立语义基线。
- 忠实复刻要同时记录网络语义和视觉元素；原图遮挡或型号/接口不支持的部分明确列出，不为了画得下删链或改网关。
- ensp_build 用于新拓扑。现有工程排版保留身份和关联，输出可审阅的新候选；绘图本身不需要 start_all。
- 对输入文件调用 `ensp_topo`，先用 `layout-inspect` 读取冲突与未识别几何，再用 `layout-preview` 查看移动提议。两者均只读。
- 用 `layout-apply` 输出新副本，例如 `{"action":"layout-apply","topology_path":"campus.topo","out_path":"campus.labels.topo"}`。工具保留设备位置和原生连线端点，只在附近移动标签。编号底框具有唯一匹配时随文字一起移动。
- 在输出文件上再次执行 `layout-inspect`，核对 `layout.after.count`、`unsupported` 和 `semanticHash`。工具估算字体和端口占位，`nativeVisualVerified` 在离线阶段为 false。

## 布局与避让

按实际连接关系分层，先安排高出度的核心/汇聚节点，再放接入与终端。为每层标题保留独立留白，为高密节点预留端口区域。

图标、设备名、原生端口文字、编号框、网段文字、分层标题分别建立占位框。只检查前景冲突，背景色块有意包围设备不算错误。详细规则见 [layout-rules.md](references/layout-rules.md)。

每个标签绑定对应设备、接口或链路身份，再选择附近可用位置。移动带底色编号时文字与框同步；不能将服务器网段文字放到无关核心连线上。

优先局部错位、增加层距或扩大画布。必要交叉保持连接关系可辨，聚合链路保留各自接口对。不通过隐藏文字、删设备/链路或缩小到不可读来消除重叠。

改动坐标时同步检查名称位置和每条线两端锚点。工程坐标、截图像素和物理点击坐标分开，按实际 DPI、缩放、滚动和画布原点换算。不能把一个固定屏幕坐标当成所有窗口都适用。

## 原生文件

先读本机已有样例和工程结构，再使用已验证的 shape/txttip/几何字段。未知属性与节点保留；缺少封装 API 不等于格式不支持。

保留实际编码。转换确有必要时严格编码、回读逐项比对中文；不能用 errors=replace/ignore 掩盖丢字。font/charset 与实际渲染都需核对。

几何候选输出后比较语义基线，UUID、MAC、console、slot/接口、链路接口对、终端地址与配置关联不得因排版改变。仅网络结构任务明确要求改变的内容可另列语义变更。

## 验证与局部修正

先做静态碰撞与语义差异检查，再在本次授权范围内核对 eNSP 原生显示。若当前工具不能解析某类原生端口文字，保留未验证项，不能凭预览判为无重叠。

预览和回读完成后，核对原生窗口中已移动的标注位置与候选一致。用户截图出现多处遮挡时，逐区检查核心、汇聚、接入、出口和服务器区，并检查画布边缘的文字裁切。

记录候选哈希、截图时间、视口/缩放、设备身份；同时检查完整图与高密区域。新图片与前图完全相同不能证明位置变了，结合实际设备锚点和视口判断。

截图后按冲突对象局部修正，建议默认至多 3 轮。连续无改善时停止重复点击，保留剩余问题与能力限制。保存确认、模态框或回读未确认时沿用当前保存策略，不能将 GUI 投递成功当成图面已验收。

输出修改内容、语义差异结果、未解决重叠和最终证据路径。图面检查、工程持久化和网络业务结果分别记录；旧版配置或 ping 截图不证明新布局之后的运行状态。
