# 来源与变更记录

- 基础GUI、控制台、拓扑编辑、文档工具来自ENSPLB增强实现，其基线为YunoSeng/dsh-ensp；保留LICENSE-MIT。
- 拓扑构建、解析和场景模块来自lizi600jin/dsh-ensp，来源地址https://github.com/lizi600jin/dsh-ensp；保留upstream/lizi600jin/LICENSE。
- 融合版新增统一注册、融合工具适配、通用CLI和测试；按实际兼容性需求修改控制台、桥接和设备模型逻辑。上游说明文档已移除特定机器的性能记录。
- 项目整体使用GPL-3.0-or-later，根目录LICENSE为完整许可；原MIT代码保留对应声明。
- 来源署名和许可证不属于部署者的个人信息，随分发包保留。

源码设计见docs/ANALYSIS.zh-CN.md。插件不包含维护者的本机源码审计快照、实验记录或宿主配置。

## 原项目署名与许可

本项目 dsh-ensp-fusion 包含对 **lizi600jin** 所著 **dsh-ensp** 的代码复用与修改。
原项目仓库：[https://github.com/lizi600jin/dsh-ensp](https://github.com/lizi600jin/dsh-ensp)。
原项目采用 **GPL-3.0-or-later**，完整许可证保留于 [upstream/lizi600jin/LICENSE](upstream/lizi600jin/LICENSE)。
基础实现另包含经 ENSPLB 增强实现继承的 **YunoSeng/dsh-ensp** 代码，其原始 MIT 声明保留于 [LICENSE-MIT](LICENSE-MIT)。
融合版整体采用 [GPL-3.0-or-later](LICENSE)。请在源码与随附文档的再分发中保留本来源记录、原有版权和许可声明。

## 本次文档修改

2026-11-14：在项目介绍开头明确二次开发与来源关系，补充原作者、原项目名称、仓库链接、各来源的复用范围及 GPL 再分发说明；同步完善本文件。未更改任何许可证正文或原有版权声明。
