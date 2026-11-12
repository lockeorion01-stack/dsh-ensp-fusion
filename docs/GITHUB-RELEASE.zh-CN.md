# GitHub 提交与发布准备

1.1.0 已于 2026-11-12 发布 GitHub 预发布 Release（tag `v1.1.0`）；npm 包 `dsh-ensp-fusion@1.1.0` 尚未发布。本文保留发布前的准备记录供追溯。

## 本轮准备内容

| 文件 | 用途 |
| --- | --- |
| [README](../README.md) | 项目入口、能力、安装、当前状态与文档导航 |
| [更新日志](../CHANGELOG.md) | 1.0.0至1.1.0的新增、修复和迁移汇总 |
| [1.1.0说明](releases/1.1.0.zh-CN.md) | 后续GitHub Release正文基础 |
| [已知问题](KNOWN-ISSUES.zh-CN.md) / [验收摘要](TOTAL-ACCEPTANCE.zh-CN.md) | 成功范围、失败项及未验证范围 |
| [贡献指南](../CONTRIBUTING.md) | 开发检查与修改约定 |
| `scripts/check-release.mjs`（完整源码内） | 离线核对版本、链接、候选文件、忽略规则和高置信度泄密特征 |

## 提交前检查

2026-11-12本次准备后的实际检查结果：291项Node测试、24项MCP冒烟全部通过，离线打包安装及插件检查通过；发布检查核对16份文档、60个仓库内相对链接、129个候选Git文件和90个打包文件，无命中问题；`git diff --check`通过。这些数量对应本轮快照，后续新增或修改文件应重新执行。此后已创建提交`6aee0f4`、标签`v1.1.0`并推送，且创建了预发布 Release。

在完整源码目录执行：

```powershell
git status --short
git diff --stat
npm test
npm run check:plugin
npm run test:package
npm run check:release
git diff --check
```

逐项检查未跟踪文件；`git diff --stat`不包含它们。确认新增lib、bin、test、docs及依赖清单均在预期范围。发布检查不执行暂存、提交或网络操作，不能证明不存在任何敏感信息，仍需审阅最终差异。

认证计划、`.env`和`*.local.*`配置、设备运行配置、实验报告及pcap、磁盘镜像、用户路径和宿主配置留在本地。脱敏的最小测试夹具和通用示例可提交。忽略规则不影响已跟踪文件，检查会同时核对已跟踪及未忽略的新文件。

## 后续提交与推送

先核对远端及分支：

```powershell
git remote -v
git branch --show-current
git status --short
```

按已审阅清单逐项暂存，检查`git diff --cached --stat`和`git diff --cached`，再创建提交。建议提交说明：

```text
feat: prepare 1.1.0 acceptance and recovery tooling

Add inspect/diagnose/LLDP/service checks and acceptance recovery CLI.
Harden CLI journaling, GUI targeting, topology encoding and evidence assessment.
Document validated scopes and unresolved cold ARP, throughput and TCP isolation failures.
```

后续收到推送指令时，先`git fetch origin`比较远端和本地，处理分歧后重跑相关检查，将已审阅提交推送到确认的分支。不强制推送、不覆盖远端，也不在准备阶段改动既有提交。

## 版本与Release口径

- package、锁文件、MCP版本保持一致，当前1.1.0；更新日志在发布完成后记录发布日期与范围。
- 软件检查通过与整体业务FAIL同时写入Release正文，不能宣传全园区建设完成、全部缺陷修复或USG最大性能已认证。
- 冷ARP、端到端吞吐和指定固件TCP隔离未解决时，如创建GitHub Release，应明确标记预发布/实验性质，并保留[已知问题](KNOWN-ISSUES.zh-CN.md)。
- 创建标签或Release前确认具体提交、版本和范围。源码推送不自动授权npm发布、设备上线或公开原始现场数据。

## 检查脚本边界

`npm run check:release`核对候选Git文件和打包清单，发现缺文档、仓库外相对链接、版本不一致、本地敏感文件、明显私钥/访问令牌或用户工作路径时退出失败。它是有限规则检查，不扫描远端或Git完整历史，不调用漏洞数据库，不判断设备业务。
