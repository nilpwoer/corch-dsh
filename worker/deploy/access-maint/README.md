# Schema4 access maintenance

English | [中文](README.zh.md)

Reference for the Linux operator tool that protects schema3 data during the [Worker access migration](../../README.md#schema-migration-and-rollback). It uses the existing private YAML and MySQL account without displaying credentials, creating admin accounts or running model tasks. SQL dumps contain private data and credentials: keep the backup directory `0700` and files `0600`, outside public assets.

Build `go build -o access-maint ./deploy/access-maint` from the Worker directory. The operations take `-config /data/teaching-worker/config.yaml -backup /data/teaching-worker/deploy-backups/access-<unique-name>`; `-mysql-container` selects the existing MySQL container, default `mysql`. The database must contain only Worker `tw_` tables. Never use `-isolated` for production; it is restricted to random acceptance databases and temporary backup paths.

- `backup` requires schema3 and an idle queue, writes a complete ordered SQL dump, records every table digest and configuration/publication file digest, and refuses concurrent changes. It creates a new directory; it never overwrites a backup. Separately retain the current release, systemd and reverse-proxy files.
- `guard` permits a schema3 restore only when the schema4 state differs solely by the version marker and an empty `tw_pack_access` table. Any business-row change, new access record or publication/configuration change rejects the backup.
- `restore` requires an inactive Worker service and all other writers stopped. It repeats the guard and checksum checks, removes the empty additive table, restores the full SQL snapshot and verifies all original fingerprints and schema3. Only then may the matching old binary be restarted. MySQL DDL restore is not one transaction: on failure, keep writers stopped and complete or repair the restore from the retained backup.

After any new writes, stale restore is deliberately unavailable. Retain schema4 and use a compatible repair; do not discard access records or manually lower `tw_schema`. `node deploy/build-access-ui-rollback.mjs --base <verified-prior-ref> --out <new-directory>` builds the current schema4 backend with earlier embedded management resources and the matching SPA script. This UI-only fallback keeps existing managed links and reports without restoring SQL. Its earlier management protocol temporarily blocks publication from the new client; it does not undo backend access behavior or cover arbitrary backend faults.

The isolated access acceptance rehearses full schema3 restore and old-binary health before new writes, refuses restore after new business/access records, and verifies managed links with the schema4-compatible UI fallback. Production migration, credential creation and deployment require separate authorization.
