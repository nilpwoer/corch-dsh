# Worker upgrade backup and restore

English | [中文](README.zh.md)

This Linux tool protects the [schema migration](../../README.md#schema-migration-and-rollback) using existing private configuration and MySQL access. It displays no credentials, creates no accounts and calls no models. Keep backup directories0700 and SQL/fingerprint files0600 outside public assets.

Build `go build -o publisher-maint ./deploy/access-maint` from Worker. Operations take `-config /data/teaching-worker/config.yaml -backup /data/teaching-worker/deploy-backups/access-<unique-name>`; `-mysql-container` defaults to mysql. The database must be dedicated to Worker. `-isolated` permits only random acceptance databases and temporary paths, never production.

- `backup` requires schema3/4 and an idle queue, writes ordered full SQL and every table/configuration/publication fingerprint, and refuses concurrent changes or existing output. Retain release, systemd and proxy files separately.
- `guard` permits restoration only if schema5 differs solely by its marker and empty additive tables. A schema3 snapshot allows empty access and Key tables; schema4 allows only an empty Key table. The empty schema3→4 access migration remains supported for acceptance.
- `restore` requires the service and every other writer stopped, repeats fingerprints/checksums, drops verified empty additive tables, restores full SQL and checks every original fingerprint/version. DDL restoration is not transactional; keep writers stopped if it fails and finish repair using retained backups.

Any new business, invitation or Key write rejects a stale restore. Retain schema5 and use compatible repair; never discard records or lower the marker. `node deploy/build-access-ui-rollback.mjs --base <verified-old-ref> --out <new-directory>` combines the current backend with selected earlier management/SPA pages. Native Key publication stays available; earlier pages cannot administer Keys. This fallback does not cover arbitrary backend defects. Isolated SQL acceptance verifies full schema3/4 restoration, old-program health, stale rejection and retained invitations. Production deployment and real credential creation require separate authorization.
