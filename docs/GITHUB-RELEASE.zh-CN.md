# GitHub 提交与分发指南

当前源码候选为 **1.1.6**。DSH 兼容声明覆盖 0.2.2-rc.1、rc.3 和 rc.5。源码推送、创建 GitHub Release 和发布 npm 包分别执行。

## 发布说明应包含的内容

- 1.1.6 修正设备名居中占位、端口文字与连线、编号底框和画布边缘的检查。自 1.1.5 起，插件提供绘图技能、批量 CLI 默认参数继承及按原始 ID 筛选后脱敏的日志导出。[版本说明](releases/1.1.6.zh-CN.md)
- 候选通过 371 项 Node 测试及 24 项 MCP 冒烟。DSH rc.5 隔离宿主注册了 19 个工具和 3 个技能。桌面用户可用 `ensp_status` 核实本次会话实际加载的构建。[部署手册](DEPLOYMENT.zh-CN.md)
- 21 台设备、29 条链路的样本从 172 处静态冲突降至 0 处，写盘回读和当次视口截图均已核对。园区业务总验收仍为 **FAIL**。[已知问题](KNOWN-ISSUES.zh-CN.md)

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

只暂存本次已审阅文件，检查 `git diff --cached`，再创建描述实际变更的提交。

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

1.1.6 对应文件为 `dsh-ensp-fusion-1.1.6.tgz`。上述命令在当前目录生成安装包，可在 DSH 插件管理中选择该文件。本地绘图回归留存的候选位于 `test-results/1.1.6-drawing/dsh-ensp-fusion-1.1.6.tgz`。安装后按[部署手册](DEPLOYMENT.zh-CN.md)核对实际加载版本。

如需单独创建 GitHub Release，应使用新的版本标签、经过核对的提交及对应包，保留既有 `v1.1.0` 标签；发布正文采用本版说明，并标记预发布/实验性质。软件测试通过和园区业务 FAIL 需同时呈现，不能宣称全部设备缺陷修复或最大容量认证通过。源码推送不替代 Release 或 npm 发布操作。

## 检查范围

`npm run check:release` 离线核对 package/锁文件版本、仓库内相对链接、必需文档、候选 Git 文件、包内容和忽略规则，并扫描有限的高置信度凭据特征。该检查不进行网络操作，不检查 Git 完整历史、依赖漏洞或设备业务；最终差异仍需人工审阅。
