# GitHub 提交与分发指南

当前源码版本 **1.1.3**，支持 **DSH 0.2.2-rc.1、0.2.2-rc.3**。本轮包含执行日志问题修复、可靠性加固和 rc.3 兼容修复；版本变更见 [1.1.3 说明](releases/1.1.3.zh-CN.md)，整体介绍见 [README](../README.md)。

GitHub 源码、GitHub Release 和 npm 是独立分发渠道。既有 `v1.1.0` 预发布保留历史内容，其旧 SDK 声明会被当前宿主拦截；1.1.2 的单 rc.1 声明也不适用于 rc.3。1.1.3 安装应使用对应仓库源码生成的包；npm 尚未发布，源码推送不会自动发布 npm，也不会更新已有 Release 附件。

## 本轮提交范围

| 内容 | 对应文件 |
| --- | --- |
| 项目介绍 | [README](../README.md)：用途、兼容性、快速开始、三种入口、19 工具及验证范围 |
| 执行可靠性 | 冻结参数、失败外层、状态证据、CLI 视图/问答及 GUI 单位预检；插件升级至 1.1.3 并适配 DSH rc.3 |
| 证据工具 | 工程配置检查点、控制台日志诊断、脱敏会话导出及加载指纹 |
| 真实宿主检查 | 完整源码中的 `scripts/check-dsh-host.mjs` 及 `test/dsh-sdk.test.mjs` |
| 升级与维护 | [部署手册](DEPLOYMENT.zh-CN.md)、[贡献指南](../CONTRIBUTING.md)、[更新日志](../CHANGELOG.md)与[补丁说明](releases/1.1.3.zh-CN.md) |
| 验收状态 | [验收摘要](TOTAL-ACCEPTANCE.zh-CN.md)与[已知问题](KNOWN-ISSUES.zh-CN.md)：补充宿主服务验证，保留设备业务失败 |

本次软件验证通过 308 项 Node 测试、24 项 MCP 冒烟、插件检查及目标 DSH 的隔离宿主服务检查。文档链接、候选文件、离线干净安装和包内容在提交前重新检查，数量以当次工具输出为准。三台 USG 已完成真实 VRP、配置保存及同路径关闭重开回读，选定关键项 39/39/23 匹配；后续桌面安装副本已同步，并以运行中工具的加载路径和构建指纹确认，见 [部署核验](releases/1.1.3.zh-CN.md#后续部署核验)。该配置验收不能作为“园区总验收通过”的发布结论，见[本轮记录](USG-REOPEN-ACCEPTANCE-20261114.zh-CN.md)。

## 提交前检查

在完整源码目录执行：

```powershell
git status --short
git diff --stat
npm test
npm run check:plugin
npm run check:dsh
npm run test:package
npm run check:release
git diff --check
```

`check:dsh` 需要已安装的目标 DSH 桌面版；`test:package` 需要本机 npm 缓存和 tar。宿主服务检查不打开 eNSP、不修改 profile、不发起模型请求。完整桌面模型会话及园区业务需独立验收。

审阅已跟踪差异和未跟踪文件。`git diff --stat` 不包含新增未跟踪文件，不能单凭统计决定暂存范围。认证计划、设备运行配置、原始报告及抓包、磁盘镜像、宿主配置、`.env` 和 `*.local.*` 留在本地。通用示例、脱敏最小夹具及许可证随项目保留。

## 提交与推送

先核对远端和分支，再获取远端状态：

```powershell
git remote -v
git branch --show-current
git fetch origin
git rev-list --left-right --count HEAD...origin/main
```

只暂存本次已审阅文件，检查 `git diff --cached`，再创建提交。本轮建议提交说明：

```text
fix: support DSH rc.3 and harden eNSP execution and persistence

Add project checkpoints, console diagnostics and sanitized session export.
Guard GUI units, CLI views and explicit interactions; add credential references.
Support DSH rc.1/rc.3 and inspect appended flash archives and custom USG configs.
Document three-USG save/reopen acceptance and unresolved campus business failures.
```

获得推送授权后，执行普通快进推送：

```powershell
git push origin main
git ls-remote origin refs/heads/main
git status --short --branch
```

比较远端返回的提交与本地 HEAD。遇到远端新提交时先获取并审阅、解决分歧，再重跑受影响检查；不强制推送，不覆盖已有标签或他人修改。

## 安装包与 Release

从完整源码生成分发包：

```powershell
npm pack --ignore-scripts
```

1.1.3 对应文件为 `dsh-ensp-fusion-1.1.3.tgz`。压缩包被 Git 忽略，不作为源码提交；使用方式见[升级说明](releases/1.1.3.zh-CN.md)。维护检查脚本不随运行包分发。

如需单独创建 GitHub Release，应使用新的版本标签、经过核对的提交及对应包，保留既有 `v1.1.0` 标签；发布正文采用本版说明，并标记预发布/实验性质。软件测试通过和园区业务 FAIL 需同时呈现，不能宣称全部设备缺陷修复或最大容量认证通过。源码推送不替代 Release 或 npm 发布操作。

## 检查范围

`npm run check:release` 离线核对 package/锁文件版本、仓库内相对链接、必需文档、候选 Git 文件、包内容和忽略规则，并扫描有限的高置信度凭据特征。该检查不进行网络操作，不检查 Git 完整历史、依赖漏洞或设备业务；最终差异仍需人工审阅。
