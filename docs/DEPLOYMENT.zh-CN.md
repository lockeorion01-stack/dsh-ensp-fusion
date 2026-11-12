# 部署与运维手册

本手册面向从本地源码部署插件的开发者，依据当前仓库实现编写。项目不是 eNSP 安装器，不承诺所有宿主、虚拟化平台或设备固件版本兼容。

## 1. 环境与依赖

| 使用能力 | 必需条件 |
| --- | --- |
| 全部入口 | Node.js >=20、npm、完整源码及对应锁文件 |
| 离线拓扑和计划 | 有效输入文件、存在且可写的输出父目录 |
| 控制台配置 | 设备已启动、TCP控制台端口可达、正确凭据 |
| GUI | Windows交互桌面、可运行的eNSP、Python、pywin32、Pillow、匹配权限 |
| Word报告 | 文档解释器安装python-docx |
| eNSP设备 | 用户自行准备匹配的虚拟化依赖、设备镜像和磁盘 |

不同eNSP版本需要分别验证。先确认目标设备能够手工启动，再排查插件。Node跨平台不意味着Windows GUI能力也跨平台。

Python依赖应使用实际配置的解释器安装，避免pip指向另一环境：

```powershell
$Python = 'C:/path/to/python.exe' # 替换为实际路径
& $Python -m pip install pywin32 Pillow python-docx
& $Python -c "import win32gui; from PIL import Image; import docx; print('OK')"
```

仅使用离线拓扑时不需要GUI依赖。`requirements-windows.lock.txt` 固定本机 CPython3.13.12 的已验证依赖组合，可用同一解释器 `-m pip install -r requirements-windows.lock.txt` 安装；其他Python版本仍需单独验证。离线机器应提前准备匹配安装包和Node缓存。

执行只读环境检查：`node bin/ensp-fusion-doctor.mjs --python C:/path/to/python.exe`。可通过 `--ensp`、`--vbox` 指定本机程序路径。检查输出Node/Python/依赖版本、缺失项、锁定版本差异及VirtualBox版本；版本差异单列报告，不自动安装或修改环境。环境检查通过不代表已提权、镜像已注册、设备能启动或业务已通过。统一正式验收见 [ACCEPTANCE-RUNNER.zh-CN.md](ACCEPTANCE-RUNNER.zh-CN.md)。

## 2. 源码部署与工作区

```powershell
$Plugin = 'C:/tools/dsh-ensp-fusion'
$Workspace = 'C:/labs/ensp'
New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
Set-Location $Plugin
npm ci --ignore-scripts
node bin/ensp-fusion.mjs tools
```

tools应输出16个工具。即使只用MCP/CLI，也要安装本包的Node依赖，包括@deepseek-ai/dsh-tools与@deepseek-ai/schemastery；不要求启动DSH应用，但不能只复制入口JS。

npm 包 `dsh-ensp-fusion@1.1.0` 已发布（GitHub 侧为预发布 Release）；部署既可用完整源码，也可从 npm 安装。不要把 npm publish 当部署流程。分发包的files清单不包含完整开发脚本、测试和锁文件；npm test、check:plugin等维护命令应在完整源码工程运行。

插件代码和实验工作区分离。topo必须与配套GUID设备目录一起迁移。运行中的eNSP不会自动切换文件路径；迁移后应从新路径重开，检查服务目录和保存状态，不能在仍引用旧路径的窗口继续保存。迁移时由实验维护者决定何时保存、停止与重开。

## 3. MCP接入

将以下示例放入客户端实际使用的MCP配置位置，替换Python路径。不同客户端的外层配置结构可能不同。

```json
{
  "mcpServers": {
    "ensp-fusion": {
      "command": "node",
      "args": [
        "C:/tools/dsh-ensp-fusion/bin/dsh-ensp-mcp.mjs",
        "--workspace", "C:/labs/ensp",
        "--mode", "job",
        "--python", "C:/path/to/python.exe",
        "--docs-python", "C:/path/to/python.exe"
      ]
    }
  }
}
```

客户端找不到node时，将command改为node.exe绝对路径。修改配置后重新加载MCP服务。此入口为stdio，不是HTTP服务器；标准输入/输出承载JSON-RPC，日志走stderr。直接在终端启动后等待输入通常是正常现象。

| 参数 | 默认与用途 |
| --- | --- |
| --workspace | ENSP_MCP_WORKSPACE环境变量，否则cwd；相对路径基准及工作区边界 |
| --python | GUI桥解释器 |
| --docs-python | 文档解释器，可以与GUI相同 |
| --mode job | 默认，每批启动一个提权侧车 |
| --mode serve | 复用常驻提权侧车，需维护生命周期 |
| --no-restrict | 关闭工作区路径限制，正常部署通常不需要 |
| --help / --version | 查看参数或版本 |

MCP入口没有--timeout或--ensp-executable参数，不能把DSH字段直接作为命令行选项。GUI批次可使用工具timeout_ms；配置API另有timeoutMs。

1.1.0 初始化后应列出16工具。资源ensp://workspace、ensp://topology/current可供读取。后者是最近成功ensp_topo action:list的快照，拓扑变更后需重新list。新增服务验收与兼容性说明见 REMAINING-MODULES.zh-CN.md。

## 4. DSH接入

在现有profile合并下列片段，保留其他依赖和bundle：

```json
{
  "dependencies": {
    "dsh-ensp-fusion": "link:C:/tools/dsh-ensp-fusion"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-ensp-fusion"]
    }
  }
}
```

用宿主实际采用的包管理流程解析link依赖，再重新加载或重启。不同包管理器的link协议支持不能混用。仓库没有一个适用所有DSH安装的profile绝对路径，不应覆盖猜测的位置。宿主需要tools、skills、systemPrompt注入服务。

cordis.patch.yml中的插件name为dsh-ensp-fusion，id为ensp-fusion。配置示例：

```yaml
- insert:
    - id: ensp-fusion
      name: dsh-ensp-fusion
      config:
        pythonExecutable: C:/path/to/python.exe
        docsPythonExecutable: C:/path/to/python.exe
        mode: job
        timeoutMs: 180000
        restrictToWorkspace: true
```

base.js还定义enspExecutable（默认C:/Program Files/Huawei/eNSP/eNSP_Client.exe）、registerSkill、injectPrompt等。插件字段不等于MCP命令行参数。DSH工作区来自宿主会话，应确认指向实验目录。旧插件有同名工具，同一profile应避免与融合版同时启用。

## 5. CLI和离线任务

从源码目录执行，输出路径必须是新的：

```powershell
node bin/ensp-fusion.mjs tools
node bin/ensp-fusion.mjs scenarios ospf
node bin/ensp-fusion.mjs call ensp_build examples/build-router-pair.json $Workspace
node bin/dsh-ensp-lab.mjs generate --plan examples/lab-plan.json --out "$Workspace/generated-plan"
node bin/dsh-ensp-lab.mjs diagram --topology "$Workspace/router-pair.topo" --out "$Workspace/router-pair.mmd"
```

call的参数JSON相对shell当前目录读取；末尾workspace控制工具内部相对路径，因此示例从源码读取、输出进入实验目录。生成router-pair.topo不启动设备。已有文件会拒绝覆盖，应选新路径，不为通过命令删除现有实验。

generate中的topology相对计划文件解析，只接受严格JSON模板及简单变量，不是YAML/Jinja执行器；只复制topo，不打包外部磁盘。配置生成计划和只读验收计划不能混用。完整参数见bin/dsh-ensp-lab.mjs --help。

## 6. 权限和实际设备

eNSP高权限而调用方低权限时，窗口消息可能被UIPI拒绝。侧车通过ShellExecuteW(runas)请求提权；默认UAC可能每个job都需确认，serve可减少重复启动。不要把关闭UAC作为安装前提。拒绝授权应作为失败处理。

GUI依赖已解锁的交互桌面。锁屏、断开的远程会话、模态窗口、用户移动鼠标、窗口缩放均可能阻断操作。先检查ensp_status；保留expect和鼠标保护；不并行争用同一窗口。超时先检查现场，尤其不能重复打开密码或保存窗口。bmclick返回posted只表示投递，不代表业务完成。

端口开放后还需确认VRP提示符及版本。防火墙冷启动可能较慢，首次登录可能强制改密；就绪探针不执行改密。配置时按工具new_password约定处理，之后使用新密码。设备语法受固件版本限制，以failure.index、回显和当前视图为依据修复，不能盲目重放全部配置。

## 7. 故障排查

| 现象 | 检查与处理 |
| --- | --- |
| ERR_MODULE_NOT_FOUND | 源码根目录按锁文件npm ci，检查peer依赖，不只复制入口 |
| node找不到/版本不符 | 检查客户端PATH，必要时用node.exe绝对路径 |
| Python导入失败 | 用实际配置解释器执行-m pip和import测试 |
| 桥失败/1223 | 检查解释器、权限和是否拒绝UAC |
| another GUI operation is active | 等待事务并检查模态窗，不并行重放修改 |
| GUI_JOB_TIMEOUT/uncertain | 可能部分生效，先读取现场再恢复 |
| 无实例/旧截图 | 检查进程、最小化和桌面；恢复窗口可能占前台 |
| 无法自动开控制台 | 核对topology_path、保存的画布位置、缩放和可见范围；Server/Client查独立进程 |
| 端口开放但未就绪 | 区分启动中、authentication_required和错误凭据，不能一律重启 |
| CLI语法失败 | 看failure.index和设备视图，按固件修正；之前生效部分不自动回滚 |
| saved.ok=false | 区分实际失败与未确认，读startup及回显后决定重试 |
| 路径越界 | 校对工作区及相对路径，不优先关闭限制 |
| 输出已存在 | 检查现有产物或换新输出，不盲目覆盖 |
| 离线包测试安装失败 | 检查npm缓存及tar；缺缓存不等于插件逻辑错误 |
| 自检报告无法写入 | 默认写系统临时目录，可用ENSP_CHECK_OUTPUT指定，检查输出位置写权限 |
| 宿主找不到/重复工具 | 检查bundle、link解析、注入服务和旧插件，重新加载 |

## 8. 验收和交付

1. 源码：tools列出16项，npm test通过。
2. 分发：test:package验证临时打包、离线安装和CLI/MCP；不能证明设备启动。
3. 客户端：MCP初始化/工具列表或DSH实际调用成功。
4. 实机：专用实验验证就绪、配置、保存、协议与业务正反向断言。
5. 恢复：重开/重启后断言仍满足，才称恢复验收通过。

不能用上游或其他实验的结果替代当前部署验收。验收结果应在独立工作区留档，不将运行现场写入插件文档。

check:plugin在源码目录运行，报告默认写系统临时目录的dsh-ensp-fusion/plugin-check.json，可用ENSP_CHECK_OUTPUT指定。test:package使用离线安装，需已有npm缓存。分发前检查配置、截图和日志中的凭据并脱敏；不把实验设备数据加入插件安装包，保留来源许可证。


