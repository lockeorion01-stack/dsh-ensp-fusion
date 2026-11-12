# 开发与贡献

完整源码要求Node.js20及以上，安装使用锁文件：

```powershell
npm ci --ignore-scripts
npm test
npm run check:plugin
npm run test:package
npm run check:release
git diff --check
```

`test:package`需要本机npm缓存和tar，验证离线干净安装及打包入口。GUI实测依赖Windows/eNSP环境，不由这些检查自动启动。`check:plugin`使用注册契约检查，不表示完整DSH宿主已运行。

## 修改约定

- DSH/MCP/CLI共用工具实现；变更参数同步更新schema、示例、相关测试及文档。
- 配置前只读探查，正式变更使用预览、日志与显式恢复；不猜反向命令，不把未知状态判通过。
- 保留原始失败，不用最后一次成功覆盖；软件、设备、业务与恢复分别报告。
- 实验放在仓库外独立工作区，凭据使用被忽略的本地配置；设备原始配置、pcap、截图和磁盘不随贡献提交。
- 历史报告记录当轮情况；当前状态维护[已知问题](docs/KNOWN-ISSUES.zh-CN.md)和[验收摘要](docs/TOTAL-ACCEPTANCE.zh-CN.md)。
- 新增或修复写入[更新日志](CHANGELOG.md)，保留所有上游许可证及来源声明。

提交说明描述具体问题、修改后的行为、验证结果和未解决限制。涉及凭据或私有拓扑的故障，先本地脱敏再分享，不直接粘贴原始配置或截图。GitHub准备流程见[发布指南](docs/GITHUB-RELEASE.zh-CN.md)。
