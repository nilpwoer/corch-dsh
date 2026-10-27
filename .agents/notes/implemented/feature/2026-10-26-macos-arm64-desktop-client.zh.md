# Agent Note: macOS ARM64 桌面客户端

Status: implemented

[English](2026-10-26-macos-arm64-desktop-client.md) | 中文

## Problem

Windows 桌面压缩包无法在 Apple 芯片上运行。macOS 包必须包含 ARM64 Electron、Node 和原生依赖，同时不能把可写配置数据放进应用程序包。

## Decision

`package:mac` 使用固定版本的 Electron 44.7.2 和 Node 24.18.0 ARM64 压缩包组装 `Corch DSH.app`。冻结工作区安装会为 `darwin/arm64` 解析并重建原生依赖，在 Intel macOS 打包主机上也如此。包清单只允许解析后仍位于应用程序包内的 Electron 框架符号链接，并记录每个常规载荷文件。默认打包施加临时签名，供内部发布。若同时提供 Developer ID Application 证书名称和 `notarytool` 钥匙串配置文件，则启用 hardened runtime 签名、公证、票据装订和 Gatekeeper 评估。

桌面模块解析和包内路径检查比较规范化后的文件系统路径，因此 macOS 的 `/var` 与 `/private/var` 别名不会误判配置导入或打包文件。

随包主进程运行内置的 `node/bin/node`。默认数据目录为 `~/Library/Application Support/Corch DSH`；绝对路径的 `--data-dir` 可以覆盖它。后端使用独立的 POSIX 进程组，因而超时清理只终止桌面端自己拥有的进程组并等待其退出。

## Alternatives considered

**仅支持 Rosetta 的 Intel 应用**不能提供原生 Apple 芯片客户端或 ARM64 原生扩展。**在 Windows 便携布局外包一层 macOS 外壳**会在应用程序包旁写入数据，且与正常 macOS 应用权限冲突。**使用 Electron 内置 Node 运行后端**会要求原生扩展匹配 Electron ABI，而非受支持的 Node 运行时。

## Consequences

发布仍是包含已公布 SHA256 的完整 ZIP，不提供更新器。临时签名更新后，内部用户在首次启动时可能需要通过访达确认，也可能收到钥匙串访问请求。macOS 验收必须使用独立数据目录启动实际打包的 ARM64 可执行文件，核验由钥匙串保护的发布凭据，并核验后端随应用退出。
