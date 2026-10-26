# Windows 版 Corch DSH 桌面客户端

[English](README.md) | 中文

桌面启动直接从随包运行库解析内置插件，不在 `data` 中创建符号链接或目录联接，不需要管理员权限或 Windows 开发者模式。替换程序时保留原有 `data` 文件夹，即使此前启动失败也不应删除它。已有配置清单、补丁、凭据、会话和额外插件目录会保留。


本地工作台的复制按钮可以向剪贴板写入链接和访谈口令，网页不会获得剪贴板读取权限。


## 使用便携客户端

需要 Windows10/11 x64。把 ZIP 完整解压到可写目录，双击 **Corch DSH.exe**。包内包含 Node.js、Electron、Web 界面、专家访谈插件和已打补丁的 better-sidebar 提供器；启动时不安装系统组件，也不通过 pnpm 下载依赖。

客户端在可执行文件旁创建独立 `data` 目录，保存 Electron 浏览器配置、DSH 设置和凭据、会话、工作目录及日志。替换程序时保留这个目录。目录内含私人数据，请勿随故障报告上传。不要让多个副本同时使用同一数据目录。`Corch DSH.exe --data-dir C:\absolute\private-folder` 可指定独立配置目录；不要指向现有浏览器目录或 DSH_HOME。

在模型设置中通过现有模型与凭据服务配置生成问题包使用的模型。访谈设置另行配置 Worker 地址及其管理端创建的发布 API Key；已部署服务地址为 `https://114.132.201.209`。原生进程使用当前 Windows 账户的系统加密保存 Key，只向固定上传接口发送 Authorization 请求头；不向远端页面提供读取 Key 的接口，不使用浏览器持久化、URL、分享链接或日志保存 Key。点击「发布并打开 SPA」立即上传并打开访谈，无需额外确认或管理员登录。授权缺失、过期或撤销时，行内错误提供设置入口。Worker 与 HTTPS 反代都必须支持 `/publish/api/`。

关闭客户端会停止它自己的本机后端，不影响其他 DSH 安装或服务。HTTP 只监听 `127.0.0.1`，首次启动由系统分配端口，随后保留端口以维持浏览器存储。若其他程序占用该端口，客户端会记录启动失败，不接管或关闭该程序。启动日志位于 `data/backend.log`；启动失败会写入 `data/startup-error.txt`。麦克风授权需要原生确认；真实硬件和模型质量仍需单独验收。

应用未签名，没有自动更新功能。Windows 可能显示未知发布者或 SmartScreen 提示。包内保留 Electron 和 Node 上游许可。请从维护者取得完整更新包，并在解压前核对公布的 SHA256。

## 构建参考

使用 Windows x64、受支持的 Node.js、pnpm11.7.0 和 Windows PowerShell/tar。先运行仓库正常构建，再执行：

```powershell
pnpm --filter @polus-ai/corch-dsh-desktop run package:win --out C:\build\Corch-DSH
```

输出目录必须不存在。打包器核验固定版本的官方 Electron44.7.2 和 Node24.18.0 压缩包，在仓库私有 `.tmp` 目录下、输出目录之外的仅含发布文件的工作区镜像中按冻结 pnpm 锁文件安装生产依赖，再将工作区包物化到便携闭包。载荷检查拒绝符号链接、私人配置、源码映射及编译状态。打包器产出 ZIP、SHA256 和逐文件构建清单。包内排除包管理器生成的启动脚本、安装元数据和调试路径注释，避免携带构建机路径。`--cache` 指定压缩包缓存；`--closure` 可提供已核验的冻结桌面闭包以离线组装。该选项仍检查必要构建产物并扫描载荷；维护者需保证闭包与源码、锁文件匹配。

`node --test apps/desktop/policy.test.mjs apps/desktop/publisher.test.mjs apps/desktop/publisher-vault.test.mjs` 检查弹窗限制、环境隔离及导航。桌面验收必须以独立数据目录启动实际打包的可执行文件，加载真实插件，检查模型设置页和隔离 Worker 发布握手，并核验后端关闭。回环提供商测试只证明请求路由和凭据连接，不代表真实模型质量或麦克风验收。

[桌面设计记录](../../.agents/notes/implemented/feature/2026-10-14-windows-desktop-client.zh.md) 说明生命周期与打包取舍。桌面不新增模型提示词或工具行为，这些效果由现有 bundle 负责。
