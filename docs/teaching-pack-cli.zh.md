# 题包命令行工具

[English](teaching-pack-cli.md) | 中文

仓库命令 `pnpm teaching-pack --host http://127.0.0.1:3082/ --request /absolute/request.json --output /absolute/new-output-directory` 通过现有 DSH Web Host 生成题包。`node --import tsx/esm scripts/teaching-pack.ts` 可直接启动同一源码入口，跳过包管理器启动。Host 必须已配置 DeepSeek 默认模型，并自行管理凭据；CLI 不读取凭据文件、不修改默认模型，也不接管已有会话。

请求包含 `fieldnoteId`（唯一且 URL 安全的测试标识）、`goal`、`questionCount`（3–100）、明确的 `profile` 字段、非空 `sources`（含 `id/title/markdown/version`），以及含 `scope/maxFollowups` 的 `interviewPolicy`。输入应来自真实任务要求：明确标注合成角色，仅提供已授权材料，不在请求中放入密钥或密码。CLI 不读取浏览器自定义提示词和参考池，而是显式使用仓库方法模板和提供的材料。引用说明问题设计依据，不代表受访者回答。

CLI 创建新会话，检查其当前 DeepSeek 路由，提交提示词，并等待该会话的完整回合结束。解析、编号、来源校验、来源元数据和导出逻辑与工作台共用。模型输出无效时失败，不用替代问题补齐。新建且不可覆盖的输出目录保留请求、渲染后的提示词、真实会话标识、模型原文、非敏感证据和 `publication.json`。题包文件包含邀请码，应保持目录私有并通过已授权 SSH 连接传输。标准输出不包含邀请码或可用于枚举短码的整包摘要。`--timeout-ms` 限制等待生成的时间，超时只取消本次新会话。

在 Worker 主机运行 `teaching-worker import-pack --file /private/publication.json --packs-dir /authorized/packs --key TEST-unique-v1 --max-bytes 1048576 --require-invitation --dry-run` 可只校验、不写入。容量限制必须使用部署实际配置值。去掉 `--dry-run` 后使用与管理端上传相同的解析和原子不可覆盖发布操作。重复导入相同内容具有幂等性；同键不同内容会失败。命令使用已有操作系统目录权限，不加载服务配置、不连接数据库、不启动监听。独立构建的工具可以完成导入，无需替换或重启运行中的服务。

导入后应通过已配置的参与者入口和匿名访问保护验证发布键。CLI 生成和本机导入不构成浏览器界面、麦克风、受访者答题、追问模型或报告流水线验收。
