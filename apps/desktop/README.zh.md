# Corch DSH 桌面客户端

[English](README.md) | 中文

桌面端启动时直接从便携运行库解析内置插件，不在数据目录中创建符号链接或目录联接。替换程序时保留原有数据目录，即使此前启动失败也不应删除它。已有配置清单、补丁、凭据、会话和额外插件目录会保留。


本地工作台的复制按钮可以向剪贴板写入链接和访谈口令，网页不会获得剪贴板读取权限。


## 使用便携客户端

受支持的构建目标为 Windows 10/11 x64，以及运行 macOS 13.5 或更高版本的 Apple 芯片设备。启动 **Corch DSH.exe** 或 **Corch DSH.app** 前须完整解压 ZIP。包内包含 Node.js、Electron、Web 界面、专家访谈插件和已打补丁的 better-sidebar 提供器；启动时不安装系统组件，也不通过 pnpm 下载依赖。

Windows 在可执行文件旁创建 `data`；macOS 将数据保存到 `~/Library/Application Support/Corch DSH`。该目录包含 Electron 浏览器配置、DSH 设置与凭据、会话、工作目录和日志。替换程序时应保留它；目录内含私人数据，请勿随故障报告上传。不要让多个副本同时使用同一数据目录。`--data-dir <绝对路径>` 可指定独立配置；不要指向现有浏览器目录或 DSH_HOME。

在模型设置中通过现有模型与凭据服务配置生成问题包使用的模型。访谈设置另行配置 Worker 地址及其管理端创建的发布 API Key；已部署服务地址为 `https://114.132.201.209`。原生进程使用当前系统账户的系统加密保存 Key，只向固定上传接口发送 Authorization 请求头；不向远端页面提供读取 Key 的接口，不使用浏览器持久化、URL、分享链接或日志保存 Key。点击「发布并打开 SPA」立即上传并打开访谈，无需额外确认或管理员登录。授权缺失、过期或撤销时，行内错误提供设置入口。Worker 与 HTTPS 反代都必须支持 `/publish/api/`。

关闭客户端会停止它自己的本机后端，不影响其他 DSH 安装或服务。HTTP 只监听 `127.0.0.1`，首次启动由系统分配端口，随后保留端口以维持浏览器存储。若其他程序占用该端口，客户端会记录启动失败，不接管或关闭该程序。启动日志位于 `data/backend.log`；启动失败会写入 `data/startup-error.txt`。麦克风授权需要原生确认；真实硬件和模型质量仍需单独验收。

Windows 可执行文件未签名。macOS 默认使用临时签名供内部发布。首次启动时，访达可能要求每位用户选择「打开」；更新后钥匙串也可能再次请求访问。两个版本都没有自动更新功能。包内保留 Electron 和 Node 上游许可。请从维护者取得完整更新包，并在解压前核对公布的 SHA256。

## 构建参考

使用受支持的 Node.js 和 pnpm 11.7.0。先运行仓库正常构建，再在目标系统执行打包：

```powershell
pnpm --filter @polus-ai/corch-dsh-desktop run package:win --out C:\build\Corch-DSH
```

```sh
pnpm --filter @polus-ai/corch-dsh-desktop run package:mac -- --out /tmp/Corch-DSH-arm64.app
```

Windows 打包需要 Windows x64；macOS 打包固定生成 ARM64 产物，并支持两种 macOS 主机架构。输出目录必须不存在。默认命令施加并验证临时签名，供内部发布。当具备 Developer ID Application 证书和 `notarytool` 钥匙串配置文件时，同时提供 `--sign-identity 'Developer ID Application: Organization (TEAMID)' --notary-profile corch-dsh-notary`；打包器将以 hardened runtime 签名、提交公证、装订已接受的公证票据并评估结果。打包器核验固定版本的官方 Electron 44.7.2 和 Node 24.18.0 压缩包，在仅含发布文件的工作区镜像中按冻结 pnpm 锁文件安装目标平台生产依赖，再将工作区包物化到便携闭包。载荷检查拒绝私人配置，以及 Electron macOS 框架包之外的链接。打包器产出 ZIP、SHA256 和逐文件构建清单。包管理器生成的启动脚本、源码映射、编译状态和生成的调试路径注释不会进入载荷。`--cache` 指定压缩包缓存；`--closure` 可提供已核验的冻结桌面闭包用于离线组装。维护者必须提供与源码、锁文件和目标平台匹配的闭包。

`node --test apps/desktop/policy.test.mjs apps/desktop/publisher.test.mjs apps/desktop/publisher-vault.test.mjs` 检查弹窗限制、环境隔离及导航。桌面验收必须以独立数据目录启动实际打包的可执行文件，加载真实插件，检查模型设置页和隔离 Worker 发布握手，并核验后端关闭。回环提供商测试只证明请求路由和凭据连接，不代表真实模型质量或麦克风验收。

[Windows 桌面决策](../../.agents/notes/implemented/feature/2026-10-14-windows-desktop-client.zh.md)与[macOS ARM64 决策](../../.agents/notes/implemented/feature/2026-10-26-macos-arm64-desktop-client.zh.md)记录生命周期和打包取舍。桌面端不新增模型提示词或工具行为，这些效果由现有 bundle 负责。
