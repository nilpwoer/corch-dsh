# 结构版本 4 访问维护

[English](README.md) | 中文

本文说明在 [Worker 访问迁移](../../README.zh.md#schema-migration-and-rollback)中保护版本 3 数据的 Linux 操作工具。工具使用现有私有 YAML 和 MySQL 账号，不显示凭据、不创建管理员账号、不运行模型任务。SQL 备份包含私人数据和凭据，目录须为 `0700`、文件为 `0600`，并置于公开资源目录之外。

在 Worker 目录运行 `go build -o access-maint ./deploy/access-maint` 构建。各操作接受 `-config /data/teaching-worker/config.yaml -backup /data/teaching-worker/deploy-backups/access-<唯一名称>`；`-mysql-container` 选择既有 MySQL 容器，默认 `mysql`。数据库必须仅含 Worker 的 `tw_` 表。生产中不得使用 `-isolated`，该参数仅允许随机验收数据库及临时备份路径。

- `backup` 要求版本 3 和空闲队列，写出完整有序 SQL 备份，记录各表及配置、题包文件摘要，并拒绝并发变化。它新建目录，不覆盖备份；还须单独保留当前发布、systemd 和反向代理文件。
- `guard` 仅在版本 4 相对备份只改变版本标记并新增空 `tw_pack_access` 表时允许恢复版本 3。任何业务行变化、新访问记录、题包或配置变化均拒绝使用该备份。
- `restore` 要求 Worker 服务 inactive，并停止所有其他写入进程。工具复核守卫及校验和，删除空的新增表，恢复完整 SQL，再确认原有指纹及版本 3，随后才可启动匹配旧程序。MySQL DDL 恢复不是单一事务；失败时应保持写入停止，使用保留备份完成或修复恢复过程。

出现新写入后，工具刻意禁止过时恢复。此时保留版本 4 并采用兼容修复，不得丢弃访问记录或手动降低 `tw_schema`。`node deploy/build-access-ui-rollback.mjs --base <已核实旧引用> --out <新目录>` 以当前版本 4 后端、早期嵌入管理资源及匹配 SPA 脚本构建仅回退界面的程序。它不恢复 SQL，保留已有托管链接和报告；早期管理协议会暂时阻止新客户端发布，且不会撤销后端访问机制，也不覆盖任意后端故障。

隔离访问验收演练新写入前完整恢复版本 3及旧程序健康、新业务或访问记录产生后拒绝恢复，以及版本 4 界面回退程序验证托管链接。生产迁移、凭据创建和部署须另行授权。
