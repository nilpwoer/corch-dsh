# Teaching Worker

English | [中文](README.zh.md)

Reference for the independent Go service that generates interview follow-ups and evidence-linked reports. It uses Cobra, GORM and MySQL. The HTTP API is for a trusted application backend; an optional loopback browser entry supports local integration. An independent, explicitly enabled portal adds database-backed management accounts, package uploads and participant sessions; the loopback preview remains separate.

## Quick start

Install Go 1.25 or newer and create a dedicated MySQL database. MySQL 8.4 is the acceptance target; startup rejects MySQL older than 8.0.13 and MariaDB. The database account needs table-creation permission for initial setup and read/write permission afterward.

```powershell
cd worker
go build -o teaching-worker.exe .
Copy-Item config.example.yaml config.local.yaml
# 配置 database.dsn、auth.token、providers.deepseek.api_key。
.\teaching-worker.exe serve -c config.local.yaml
```

Edit `providers` and each prompt's `model` to match the provider endpoint and models available to your account. The example uses the DeepSeek Chat Completions endpoint. The adapter sends non-streaming JSON requests to `{base_url}/chat/completions`; incompatible provider protocols need a separate adapter. On Linux, build with `go build -o teaching-worker .` and use `./teaching-worker serve -c config.local.yaml`.

`GET /health` returns HTTP 200 with `ready: true` when MySQL is reachable. Other endpoints require `Authorization: Bearer <token>`. Keep this shared token in the application backend; it grants access to every interview in this Worker database and does not identify individual experts.

## Configuration

[config.example.yaml](config.example.yaml) is the complete configuration. Unknown fields, missing required values and invalid limits fail startup. Startup settings, including credentials and model selection, come from the YAML passed to `serve -c`; environment variables are not read. Management business-prompt and package-policy overrides are stored separately in MySQL. `config.local.yaml` is Git-ignored. Configuration is read at startup; changes take effect after restart.

| Group | Settings and behavior |
|---|---|
| `mode` | `both` serves the API and executes tasks; `api` only accepts and reads tasks; `worker` only consumes tasks and serves health. Every process needs a distinct listening address and access to the same database when deployed together. |
| `server` | Listening address, read/write/shutdown timeouts and HTTP body limit. |
| `database` | Inline `dsn`, initial schema creation, pool sizes, connection lifetime and connection/I/O timeout. `auto_migrate` initializes schema version 4 or upgrades versions 1/2/3 with additive portal/runtime/access tables; other versions are rejected. |
| `auth` | Inline shared backend `token`; at least 32 characters. Required in all modes. |
| `queue` | Separate follow-up/report concurrency, polling, lease and heartbeat intervals, task timeout, attempt limit, retry delays and input/output byte limits. Execution limits are frozen for each interview and copied into its tasks; concurrency and polling belong to each running process. |
| `providers` | Named endpoint, inline `api_key` and request timeout. API-only mode permits an empty model key; consumers require a key for each configured model. |
| `prompts.followup` | Version, model settings, legacy backend follow-up limit, analysis prompt and composition prompt. Portal sessions use the package policy instead of this limit. |
| `prompts.report` | Independent version/model and evidence-extraction/composition prompts. `max_followups` is zero. |
| `preview` | Optional local browser entry, asset/question-pack paths, cookie lifetime, polling interval and displayed model label. Requires `api` or `both` and a numeric loopback listening IP. |

Lease duration must be at least three heartbeat intervals. Size MySQL connection capacity for all replicas and leave room for heartbeat and API transactions. A task timeout covers its stages together. `max_input_bytes` also bounds the complete model request, including instructions and schema; `max_output_bytes` bounds each provider response and the combined final result.

### Updating prompts

Change the relevant prompt text, model settings or public provider settings, assign a new `version` for each affected pipeline, then restart. Reusing a version with different contents fails startup. Each task stores its input, release and hash; retries retain that release even after configuration changes. Credentials are excluded from releases and their hashes, so key rotation only requires restart. A consumer resolves the key from its current YAML by provider name and refuses to send it if the captured endpoint differs. No hot reload is provided.

Prompts can change questioning criteria, wording, report emphasis and section titles within the existing JSON fields. Output fields, validation rules, task states and the two-stage execution sequence are defined in Go; changing those requires code and acceptance updates. Configuration does not introduce arbitrary workflows.

Both follow-up and report releases are frozen for each interview as described in [management settings and interview freezing](#management-settings-and-interview-freezing). A new idempotency key creates another numbered report over the same frozen answers and execution settings; existing reports remain available. Deploy API replicas with matching startup configuration when new interviews need consistent versions.

### Report validation

Report stages validate exact evidence quotes and report citations before saving checkpoints. Facts and task cards require known evidence IDs; empty evidence permits only `needs_verification` statements and no task cards. `prompts.report.max_corrections` accepts 0–3 additional calls per stage (default 0; example 2), captured in the release. Corrections retain invalid responses in the call audit and return validation field paths to the model. Assign a new report version when changing this budget. Validation establishes provenance; semantic support still needs report review. See the [decision record](../.agents/notes/implemented/feature/2026-10-14-worker-report-citations.md).

## API and caller responsibilities

Question `sourceRefs` object keys are serialized deterministically across MySQL storage and session reloads; values and array order remain significant. Historical request and snapshot digests are checked against their complete retained inputs when necessary, preserving legacy records while accepting equivalent retries. See the [serialization decision](../.agents/notes/implemented/feature/2026-10-14-worker-reference-json.md).

| Request | Result |
|---|---|
| `POST /v1/tasks` | Accept a `followup` or `report` request; return HTTP 202 and a persisted task. Requires `Content-Type: application/json` and `Idempotency-Key` of 1–200 characters. |
| `GET /v1/tasks/{id}` | Read task status, attempts, error code, release version/hash and output. |
| `GET /v1/interviews/{id}/tasks` | Read the interview's task and report history. |

Use [examples/followup.json](examples/followup.json) and [examples/report.json](examples/report.json) as complete request examples. A snapshot carries an interview ID, positive `input_version` and `question_pack_version`, expert profile, questions with optional legacy slots, answers and optional publication context. Submit only a confirmed target answer for a follow-up; reports require every question to have a confirmed answer or confirmed skip. IDs use ASCII letters, digits, underscore or hyphen, up to 100 characters.

```powershell
curl.exe http://127.0.0.1:3090/v1/tasks `
  -H "Authorization: Bearer <auth.token>" `
  -H "Content-Type: application/json" `
  -H "Idempotency-Key: interview-demo-followup-1" `
  --data-binary "@examples/followup.json"
```

Increment `input_version` whenever any snapshot content changes. Older versions and different content under the same version return HTTP 409. A stale follow-up is marked `superseded` without publishing its output. Request keys are global within this database: reuse the same key for network retries; different content under that key returns `IDEMPOTENCY_CONFLICT`. Follow-ups also deduplicate by interview/question/input version across different keys. A terminal failed follow-up is therefore returned again for that version rather than silently generating another task.

Accepting a report freezes that interview's answers immediately, including while generation is queued or failed. Further follow-ups and changed snapshots return `INTERVIEW_FROZEN`. To revise a frozen interview, the caller must create a new interview ID. Local draft storage does not enqueue work or synchronize devices; the backend must submit a snapshot and retain the returned task ID.

## Local browser integration

From this directory, set `preview.enabled: true` in the local configuration, keep `server.listen: "127.0.0.1:3090"`, and start with `serve -c config.local.yaml` or [start-local.ps1](start-local.ps1). Open [the local interview](http://127.0.0.1:3090/). Asset and question-pack paths are relative to the process working directory. [examples/interview-pack.json](examples/interview-pack.json) supplies three questions; each question declares the slots the model assesses. The displayed model label is configuration text, not a provider health check.

The page submits confirmed answers for follow-ups, accepts supplementary answers or skips, and generates a report after every question is confirmed. Drafts use browser local storage. Refresh restores accepted snapshots and tasks from MySQL, resumes polling, and retains task IDs and idempotency keys across uncertain network outcomes. Report submission freezes answers; regeneration creates another report version over those answers. Starting another interview creates a new ID and keeps the old database records.

The same-origin `/browser` gateway scopes requests to a signed HttpOnly cookie and rejects cross-origin or non-loopback requests. The shared backend token and model key are never delivered to the browser. This entry is for local debugging; deployment for public experts requires application authentication and authorization. The workbench publishing flow is not connected by this entry.

## Execution and outputs

Tasks progress through `queued`, `running`, and `succeeded` or `failed`; outdated follow-ups become `superseded`. MySQL owns the queue and lease clock. Consumers claim with `FOR UPDATE SKIP LOCKED`, renew leases, and check claim tokens before saving checkpoints or publishing results. A terminated consumer's task becomes eligible after lease expiry. Successful stages are checkpointed, so a retry can reuse analysis or extracted evidence.

Follow-ups first assess `complete`, `incomplete`, `uncertain` or `sensitive`, then compose at most one question. Skips bypass the model. Sensitive answers, published-round exhaustion and exhausted transient model failures return `needs_review` with `allow_skip: true`. Other invalid model outputs fail explicitly. Transport errors, HTTP 408/429 and 5xx responses retry with bounded exponential delays; attempt counts include the initial execution.

Reports extract literal answer quotations before composing sections and task cards. JSON Schema rejects malformed fields; deterministic checks reject invalid analysis, invented quotations and missing/unknown fact or task-card citations. Required slots are optional legacy input, not a mandatory interview checklist. Statements distinguish `fact`, `interpretation` and `needs_verification`. Citation validity does not prove that a statement follows logically from its evidence; human review remains necessary.

The database retains snapshots, prompt releases, stage outputs, model requests/responses and reports. Request headers and secret values are not recorded. Model-visible input is the configured system prompt plus an output-schema instruction, followed by a separate JSON user message. This separation is an instruction convention, not proof against prompt injection. Retention/deletion and public rate limiting remain application responsibilities. Interrupted model calls can be repeated and billed again before a checkpoint exists; queue fencing prevents stale publication, not duplicate external calls.

## Server deployment

[deploy/teaching-worker.service](deploy/teaching-worker.service) runs the Linux executable as the non-login `teaching-worker` OS account, restarts on failure and reads `/data/teaching-worker/config.yaml`. `/opt/teaching-worker/current` points to a versioned release directory. Program directories need traversal permission for the service account; keep the configuration directory `0750 root:teaching-worker` and its YAML `0640 root:teaching-worker`. All Worker runtime settings remain in that YAML.

[deploy/teaching-worker.locations.inc](deploy/teaching-worker.locations.inc) belongs inside the existing HTTPS server block. On `114.132.201.209`, the active host directory is `/data/volume/nginx/conf.d` and the container is `nginx-compose`. The template proxies `/teaching-worker/v1/` to `/v1/` and exposes `/teaching-worker/health`; other paths under the prefix return 404. Bearer authorization passes through to the Worker. The root of the prefix redirects to health.

The template upstream is `172.23.0.1:18083`, the host gateway of `nginx_default`; set `server.listen` to that address and disable `preview.enabled` in the server YAML. MySQL is reached through its host-published port `127.0.0.1:13306`. Gateway, port and route choices are deployment-specific: update the YAML and Nginx snippet together if the network changes. A local browser gateway sharing this database can use `mode: api` while the server runs `mode: both`.

```bash
systemctl status teaching-worker.service --no-pager
systemctl restart teaching-worker.service
journalctl -u teaching-worker.service -n 50 --no-pager
docker exec nginx-compose nginx -t
docker exec nginx-compose nginx -s reload
curl --fail https://114.132.201.209/teaching-worker/health
```

Validate Nginx before reloading. Keep the previous release and a copy of the affected Nginx configuration outside `conf.d` for rollback. Updating prompts or credentials requires a Worker restart; modifying routes requires Nginx validation and reload.

## Verification

```powershell
go test ./... -count=1
go test . -count=1 -args -mysql-config config.local.yaml
go vet ./...
go build -o teaching-worker.exe .
```

The acceptance account must be able to create/drop temporary databases. Process acceptance skips explicitly without `-mysql-config`; that flag reads only `database.dsn` from the named YAML. Tests create an isolated temporary database, build the executable (or use an explicit `-worker-binary`) and launch separate API/consumer processes, covering lease recovery, stale-result fencing, concurrent consumers, idempotency, stage reuse, prompt immutability, report regeneration and browser-session isolation. [testdata/flow.golden.json](testdata/flow.golden.json) records assembled model messages and outputs. Tests use a controlled endpoint and never use the file's real model key; live provider compatibility and report quality require separate acceptance with real interviews and credentials.

## Portal management and participant sessions

On a remote Linux test host without a browser, `-portal-browser-handoff <private-path>` writes the synthetic browser origin and pack path, then waits up to 120 seconds for `<private-path>.done` containing `PASS`. Run [tests/portal-browser.mjs](tests/portal-browser.mjs) against that isolated origin through an SSH loopback tunnel and return the result; this option never connects to a real model endpoint.

For credential-free automation through an already configured DSH Host, see [Teaching-pack CLI](../docs/teaching-pack-cli.md). `import-pack --dry-run` validates a publication against an explicit directory and size limit without loading service configuration or connecting to MySQL; removing `--dry-run` uses the same atomic no-replace publisher as administrator upload. Run a separate tool binary with existing OS directory permissions to avoid replacing or restarting the service.

Set `portal.enabled` explicitly and configure an existing `packs_dir`, public `origin`, session and upload limits, and login rate limits. HTTPS is required outside loopback. Visit `/admin/` to log in, upload/list/remove JSON publications, preview reports as web pages and download PDF files. The reports list is bounded to the latest 200 tasks. The management account is read from MySQL; first initialization inserts username `admin` only when a valid `admin_password_hash` is supplied. Portal startup rejects the example backend-token placeholder. An existing password is never overwritten, and first-login password changes are not enforced. There is no participant registration or general RBAC system.

`hash-password --output <new-private-file>` reads a password from standard input and writes a salted PBKDF2-HMAC-SHA256 hash with 600,000 iterations to a new owner-only file. It prints neither password nor hash and refuses to overwrite a file. Obtain separate approval before entering or persisting a real credential; no default password is provided. The cost follows the [OWASP password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Copy only the approved hash into private startup configuration, never a tracked file.

Participant routes stay disabled until `participants_enabled` is explicit and `entry_mode` (`link` or `list`), `invitation_mode` (`code` or `none`), `participant_reports` (`allow` or `deny`), assets, polling and model label are all supplied. These are selectable protocol options, not approved default product decisions. Management and interview sessions use different HttpOnly, SameSite=Strict cookies, server-side expiry and exact-origin checks for mutations. Logout revokes the database management session. Login budgets are per process and configured through `login_limit` and `login_window`.

Root `/` and the existing `/practice-expert-interview-spa.html` path serve the original template with the worker entry selected. `/portal/api` owns participant requests; missing API or JSON paths return errors rather than template HTML. Link mode does not expose a public package list. A link can use the immutable upload key as `fieldnoteId`; ambiguous fieldnote aliases require a version-specific key rather than silently selecting the latest file. Code mode validates the submitted invitation against Worker-owned access records, with read-only fallback to existing legacy publication codes; participant APIs omit the stored invitation. An explicitly shared code fragment is removed from browser history and pre-fills the entry form without submitting it. Uploaded files remain private host publications; participant views omit invitation and host materials.

The [DSH workbench](../packages/client/ui-polus-teaching-reform/README.md#publish-and-share) publishes confirmed JSON through a Worker-owned management window. Publications preserve `followUp` and `sourceRefs`; references describe question design, not expert answer evidence. `interviewPolicy` contains `scope: per_question | interview` and a nonnegative `maxFollowups`; zero disables additional questions. Legacy publications require a goal and an explicit policy, supplied by their publication or a saved package override, before participant entry. No server per-package default is inferred.

Uploads are parsed and bounded before a same-filesystem, atomic no-replace publication. Same-key identical retries succeed; changed contents require another key. Path-shaped keys, escaping symlinks, malformed formal files and unfinished uploads are excluded. Interview sessions retain a publication copy, version, private full hash and policy in MySQL, so directory deletion or replacement cannot change an active session. The browser binding hash excludes invitation data to avoid exposing a fast digest of a short code.

Answers use the existing transactional snapshot and task idempotency, and published follow-ups are counted both before model work and under the final interview lock. Context contains the goal, background, optional hint, actual answer history and prior follow-ups. The model may decide an answer is sufficient without composing another question; hints and answers remain user data. Report generation reuses literal quotation and citation checks. Participant report outputs are withheld when configured `deny`, while the management API remains authenticated. Process restart restores accepted snapshots, tasks and report state; unsent drafts remain in the browser.

`go test . -args -mysql-config <isolated-config> -portal-browser` additionally runs the real portal with installed Playwright/Chromium through `tests/portal-browser.mjs`. Set `PORTAL_TEST_CHROMIUM` when using a separately installed executable. The browser checks login/upload, invitation, radio choices, a controlled speech-recognition hook, local draft reload, real HTTP answer submission, evidence-linked report download and logout. The model endpoint and speech recognition are controlled fixtures; this does not prove live provider quality or microphone availability.

### Saved report preview and PDF

Management and participant report controls use the same HTML report layout, including statement kinds, task-card fields and original evidence anchors. Downloads are real, selectable-text PDF files; JSON remains the internal API representation. Queued and failed reports show their status without an export button.

| Reader | Authenticated GET routes |
|---|---|
| Administrator | `/admin/api/reports/{id}/view` and `/admin/api/reports/{id}/pdf` using the existing management session |
| Participant | `/portal/api/tasks/{id}/view` and `/portal/api/tasks/{id}/pdf` using that interview session and `participant_reports: allow` |
| Loopback preview | `/browser/tasks/{id}/view` and `/browser/tasks/{id}/pdf` using its signed preview session |
| Trusted backend | `/v1/tasks/{id}/view` and `/v1/tasks/{id}/pdf` using the existing backend Bearer token |

Anonymous reads return 401; another participant's report returns 404; participant visibility denial returns 403; unfinished or failed reports return 409. Rendering validates saved report/evidence data, escapes HTML and sets private no-store responses. It does not update reports or call a model. The PDF embeds the [licensed Chinese font](internal/reportview/fonts/README.md), wraps long content across A4 pages and includes evidence links and page numbers. Unsupported font glyphs fail rendering rather than silently disappearing; HTML retains the original text.

Production requires only the compiled Worker, the existing two SPA assets and the accompanying [license notices](licenses/README.md). The font and report HTML are embedded; no browser, Python, external PDF service or new configuration is required. PDF rendering itself requires no schema change and retains saved report versions; application rollback is subject to the [schema compatibility rules](#schema-migration-and-rollback).

`TestReportPreviewAcceptance` creates a disposable database in API-only mode and seeds saved synthetic reports without model calls. `-report-browser-handoff <private-path>` enables [the real-browser check](tests/report-preview.browser.mjs) through a loopback SSH tunnel; its `.done` file returns `PASS` within 150 seconds. The handoff contains only synthetic test-session credentials and must stay outside Git. Independent PDF verification checks Chinese text completeness, embedding, page bounds and citation destinations.

### Management settings and interview freezing

`GET`/`PUT /admin/api/settings` manage global business prompts; `GET`/`PUT /admin/api/packs/{key}/settings` manage package overrides and policy. The existing management session and exact-origin mutation checks apply. Updates require the current `revision`, package `publication_hash`, and `settings`; stale revisions return 409. The editable fields are the follow-up/report `analyze` and `compose` business text plus package `policy`. Model/provider fields are rejected, and Go output-schema and citation validation remain mandatory.

Unchecked override controls inherit YAML → global → package business prompts. Package policy inherits the immutable publication policy unless explicitly overridden. Identical publication retries preserve settings; a new package version has independent overrides. Deleting and replacing a key with different bytes does not silently rebind saved settings.

Participant entry freezes both pipeline releases, public provider/model configuration, execution budgets and effective policy in `tw_interview_runtime`; backend-only interviews freeze on first submission. Subsequent tasks, retries and report versions use that record across restarts. Credentials remain in the running YAML. Concurrency and polling remain process settings. Management edits affect only new interviews; uploads do not modify settings or started interviews.

Legacy interviews retain their saved follow-up release and earliest recorded report release. If no historical report release exists, the first resumed task captures the service's startup report baseline, ignoring new management prompt overrides. Historical settings never recorded cannot be reconstructed. Existing participant policy remains in its retained publication; starting a new session resolves current settings.

The publication bridge accepts only a canonical loopback DSH origin, exact opener window and random nonce. It shows the package key, expert, version and question count. The DSH publish click starts one authenticated upload immediately; a missing or expired management session requires normal login and resumes that same transfer automatically. No extra upload confirmation is shown. The readiness message advertises automatic publication, and progress/failure messages contain no credentials. When the uploaded package has no effective follow-up policy, the window opens its settings with empty scope/count fields. Explicitly saving a policy resumes SPA opening; an existing package policy passes directly. Uploads never invent or overwrite policies. Participant entry refuses missing policies with a readable explanation and an authenticated settings link for the host. Completion returns the matching key/hash, participant invitation and share URL only to that origin; the Worker opens the participant URL. No administrator credential or backend token is returned to DSH. Management pages disallow framing and use a self-only content policy. Browser CORS and existing authentication are unchanged.

### Worker-owned participant access

New clients omit invitation credentials from publication JSON. An authenticated new-package upload generates a 160-bit random invitation in `tw_pack_access`; concurrent and same-version retries reuse the winning record. Existing publication invitations are read without backfill, replacement or automatic rotation. Upload retries cannot reactivate revoked access. The participant validator reads authoritative access state; active participant cookies remain valid after invitation rotation or revocation.

`GET /admin/api/packs/{key}/access` returns the current code and fragment-only share URL to an authenticated administrator with `Cache-Control: no-store`. `POST` on that path accepts explicit `create`, `rotate` or `revoke`, the current revision and publication hash. Stale writes fail with 409. The code is recoverably stored under existing MySQL access controls so authorized administrators and retries can retrieve it; protect database dumps and client data as credentials. No new administrator credential, encryption master key or public invitation endpoint is introduced. Never log the code or put it in a query.

`/admin/?configure={key}` shows only that package editor and its access controls. `/admin/?view=reports` owns report browsing/downloads; navigation preserves both functions. New clients require Worker invitation support before transfer; older clients can still publish their legacy payloads and retain their codes.

### Schema migration and rollback

Schema 4 adds `tw_pack_access` without generating or migrating credentials; schema 3 owns runtime settings and frozen interviews. Versions 1/2/3 upgrade only with `database.auto_migrate`. Existing interviews, tasks, calls and reports are retained. Schema-3 binaries reject schema 4; switching only the executable is not a rollback.

Before an approved deployment, back up the database, private configuration and publication directory together and verify a restore in isolation. Coordinate the DSH client build, Worker binary and SPA assets. The [access maintenance tool](deploy/access-maint/README.md) verifies a full schema3 restore only before any post-migration business, publication or credential write. It refuses stale restores; never lower the version marker manually. After new writes, retain schema4 and use a compatible fix. The UI rollback builder can select earlier management/SPA assets over the schema4 backend without a SQL restore; it preserves managed links but temporarily disables new-client publication until the current management protocol is restored. It is not a general backend rollback. Snapshot and restore credentials remain private operator inputs.
