# Worker 输入补丁运维

[English](worker-ime-hotfix.md) | 中文

portal 在启动时将 `practice-expert-worker.js` 读入内存。只替换版本目录文件不会更新运行中的响应。无重启补丁复用现有 Nginx `conf.d` 挂载，仅将 `teaching-worker.portal.locations.inc` 中的 `location = /practice-expert-worker.js` 改为隐藏配置子目录下带版本的公开脚本别名。不创建目录别名或额外公开路由。Worker 版本、服务配置、账号权限、会话和题包保持不变。

部署前在 Nginx `conf.d` 外备份原桥接脚本和路由 include，记录哈希与 Worker PID，确认精确路由只出现一次。保留该路由以外的所有字节。替代响应须使用带 UTF-8 的 JavaScript MIME 和 `Cache-Control: no-store`，并保留已有安全响应头。检查 Nginx 容器可读取文件，运行 `nginx -t` 后平滑 reload。失败时恢复原 include，验证并 reload。核对公网 HTTPS 脚本哈希与测试产物、页面和 SPA 别名、API 鉴权、健康状态和未变化的 Worker PID。在私有部署回执中保留备份路径和已部署哈希。

**下次完整 Worker 升级时撤销覆盖：**先部署包含输入修复的版本，核对上游脚本与新版本产物，再仅将静态脚本路由恢复为常规代理定义。备份只作参考，不要用整个旧 include 覆盖更新后的其他路由。运行 `nginx -t` 并 reload，确认公网脚本来自新版本。确认无配置引用后再删除不用的版本脚本；回退备份按部署策略保留。如果不撤销 alias，会遮蔽以后版本对桥接脚本的修改。

立即回退时，从对应备份恢复原脚本路由并验证、reload Nginx；Worker 仍持有原桥接脚本。正常刷新会请求 no-store 脚本；对已经打开的页面可按 Ctrl+F5 强制刷新。不要为此修复清除浏览器站点数据或访谈草稿。

从仓库根目录运行 `node worker/tests/worker-input.browser.mjs`，必要时用 `PORTAL_TEST_CHROMIUM` 指定已安装的兼容 Chromium/Edge。它启动隔离无头浏览器，提供合成会话数据，阻止其他来源请求。组合输入和粘贴使用模拟 DOM 事件，不等同于 Windows 原生输入法或剪贴板验收。它不会向生产提交回答或模型任务。
