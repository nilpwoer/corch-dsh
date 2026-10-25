# Worker 升级备份与恢复

[English](README.md) | 中文

Linux 维护工具使用既有私有配置和 MySQL 账户，保护[结构迁移](../../README.zh.md#schema-migration-and-rollback)。不会显示凭据、创建账户或调用模型。备份目录必须为0700，SQL与指纹文件为0600，且不在公开目录内。

从 Worker 目录执行 `go build -o publisher-maint ./deploy/access-maint`。操作参数为 `-config /data/teaching-worker/config.yaml -backup /data/teaching-worker/deploy-backups/access-<唯一名称>`；`-mysql-container` 默认mysql。数据库必须专属Worker。`-isolated`仅允许随机验收库和临时目录，不能用于生产。

- `backup`要求结构3或4与空闲队列，写入完整有序SQL并记录所有表、配置与题包指纹，拒绝并发变化或覆盖已有目录。另行保留版本、systemd与反代配置。
- `guard`仅在结构5与原快照相比只有版本号及空新增表时允许恢复。原结构3可增加空访问表与空Key表，原结构4仅可增加空Key表。保留结构3→4的空访问表验收兼容。
- `restore`要求服务及其他写入者全部停止，重复校验指纹与快照校验值，移除已确认的空新增表，恢复完整SQL并逐项核对原指纹和结构版本。DDL恢复并非单事务，失败时保持停止并用留存备份完成修复。

任何新业务、口令或Key写入都会拒绝旧快照恢复。保留结构5，使用兼容修复；不得删除记录或改低版本号。`node deploy/build-access-ui-rollback.mjs --base <已验证旧引用> --out <新目录>`构建当前后端与指定旧管理/SPA页面。原生Key发布继续可用，旧页面不能管理Key，此回退不覆盖任意后端错误。独立SQL验收验证结构3/4完整恢复、旧程序健康、新写入后的拒绝与旧口令保留。生产部署和实际凭据创建需要单独授权。
