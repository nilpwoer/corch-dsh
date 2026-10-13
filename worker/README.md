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

[config.example.yaml](config.example.yaml) is the complete configuration. Unknown fields, missing required values and invalid limits fail startup. All runtime settings, including credentials and prompts, come from the YAML passed to `serve -c`; environment variables are not read. `config.local.yaml` is Git-ignored. Configuration is read at startup; changes take effect after restart.

| Group | Settings and behavior |
|---|---|
| `mode` | `both` serves the API and executes tasks; `api` only accepts and reads tasks; `worker` only consumes tasks and serves health. Every process needs a distinct listening address and access to the same database when deployed together. |
| `server` | Listening address, read/write/shutdown timeouts and HTTP body limit. |
| `database` | Inline `dsn`, initial schema creation, pool sizes, connection lifetime and connection/I/O timeout. `auto_migrate` initializes schema version 2 or explicitly upgrades version 1 with the portal tables; other versions are rejected. |
| `auth` | Inline shared backend `token`; at least 32 characters. Required in all modes. |
| `queue` | Separate follow-up/report concurrency, polling, lease and heartbeat intervals, task timeout, attempt limit, retry delays and input/output byte limits. These limits are captured for each task; concurrency and polling belong to each running process. |
| `providers` | Named endpoint, inline `api_key` and request timeout. API-only mode permits an empty model key; consumers require a key for each configured model. |
| `prompts.followup` | Version, model settings, legacy backend follow-up limit, analysis prompt and composition prompt. Portal sessions use the package policy instead of this limit. |
| `prompts.report` | Independent version/model and evidence-extraction/composition prompts. `max_followups` is zero. |
| `preview` | Optional local browser entry, asset/question-pack paths, cookie lifetime, polling interval and displayed model label. Requires `api` or `both` and a numeric loopback listening IP. |

Lease duration must be at least three heartbeat intervals. Size MySQL connection capacity for all replicas and leave room for heartbeat and API transactions. A task timeout covers its stages together. `max_input_bytes` also bounds the complete model request, including instructions and schema; `max_output_bytes` bounds each provider response and the combined final result.

### Updating prompts

Change the relevant prompt text, model settings or public provider settings, assign a new `version` for each affected pipeline, then restart. Reusing a version with different contents fails startup. Each task stores its input, release and hash; retries retain that release even after configuration changes. Credentials are excluded from releases and their hashes, so key rotation only requires restart. A consumer resolves the key from its current YAML by provider name and refuses to send it if the captured endpoint differs. No hot reload is provided.

Prompts can change questioning criteria, wording, report emphasis and section titles within the existing JSON fields. Output fields, validation rules, task states and the two-stage execution sequence are defined in Go; changing those requires code and acceptance updates. Configuration does not introduce arbitrary workflows.

An interview keeps the follow-up release selected when its first task is accepted, so an active interview does not change questioning rules midway. Report tasks use the submitting API process's configured report release. A new idempotency key creates another numbered report over the same frozen answers; existing reports remain available. Deploy API replicas with matching releases when new tasks need consistent versions.

## API and caller responsibilities

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

The database retains snapshots, prompt releases, stage outputs, model requests/responses and reports. Request headers and secret values are not recorded. Model-visible input is the configured system prompt plus an output-schema instruction, followed by a separate JSON user message. This separation is an instruction convention, not proof against prompt injection. Retention/deletion, per-expert authorization, public rate limiting, administrative UI and report export are not implemented here. Interrupted model calls can be repeated and billed again before a checkpoint exists; queue fencing prevents stale publication, not duplicate external calls.

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

The acceptance account must be able to create/drop temporary databases. Process acceptance skips explicitly without `-mysql-config`; that flag reads only `database.dsn` from the named YAML. Tests create an isolated temporary database, build the executable and launch separate API/consumer processes, covering lease recovery, stale-result fencing, concurrent consumers, idempotency, stage reuse, prompt immutability, report regeneration and browser-session isolation. [testdata/flow.golden.json](testdata/flow.golden.json) records assembled model messages and outputs. Tests use a controlled endpoint and never use the file's real model key; live provider compatibility and report quality require separate acceptance with real interviews and credentials.

## Portal management and participant sessions

Set `portal.enabled` explicitly and configure an existing `packs_dir`, public `origin`, session and upload limits, and login rate limits. HTTPS is required outside loopback. Visit `/admin/` to log in, upload/list/remove JSON publications, inspect reports and download report JSON. The reports list is bounded to the latest 200 tasks. The management account is read from MySQL; first initialization inserts username `admin` only when a valid `admin_password_hash` is supplied. Portal startup rejects the example backend-token placeholder. An existing password is never overwritten, and first-login password changes are not enforced. There is no participant registration or general RBAC system.

`hash-password --output <new-private-file>` reads a password from standard input and writes a salted PBKDF2-HMAC-SHA256 hash with 600,000 iterations to a new owner-only file. It prints neither password nor hash and refuses to overwrite a file. Obtain separate approval before entering or persisting a real credential; no default password is provided. The cost follows the [OWASP password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Copy only the approved hash into private startup configuration, never a tracked file.

Participant routes stay disabled until `participants_enabled` is explicit and `entry_mode` (`link` or `list`), `invitation_mode` (`code` or `none`), `participant_reports` (`allow` or `deny`), assets, polling and model label are all supplied. These are selectable protocol options, not approved default product decisions. Management and interview sessions use different HttpOnly, SameSite=Strict cookies, server-side expiry and exact-origin checks for mutations. Logout revokes the database management session. Login budgets are per process and configured through `login_limit` and `login_window`.

Root `/` and the existing `/practice-expert-interview-spa.html` path serve the original template with the worker entry selected. `/portal/api` owns participant requests; missing API or JSON paths return errors rather than template HTML. Link mode does not expose a public package list. A link can use the immutable upload key as `fieldnoteId`; ambiguous fieldnote aliases require a version-specific key rather than silently selecting the latest file. Code mode validates the existing invitation on the server and never sends it to the browser. Uploaded files remain private host publications; participant views omit invitation and host materials.

DSH's SPA preview adds a goal, explicit follow-up scope/count and JSON export without replacing the existing host confirmation/publishing flow. Publications preserve `followUp` and `sourceRefs`; references describe question design, not expert answer evidence. `interviewPolicy` contains `scope: per_question | interview` and a nonnegative `maxFollowups`; zero disables additional questions. Legacy publications can be inspected but cannot start portal sessions until the goal and policy are supplied. No server per-package default is inferred.

Uploads are parsed and bounded before a same-filesystem, atomic no-replace publication. Same-key identical retries succeed; changed contents require another key. Path-shaped keys, escaping symlinks, malformed formal files and unfinished uploads are excluded. Interview sessions retain a publication copy, version, private full hash and policy in MySQL, so directory deletion or replacement cannot change an active session. The browser binding hash excludes invitation data to avoid exposing a fast digest of a short code.

Answers use the existing transactional snapshot and task idempotency, and published follow-ups are counted both before model work and under the final interview lock. Context contains the goal, background, optional hint, actual answer history and prior follow-ups. The model may decide an answer is sufficient without composing another question; hints and answers remain user data. Report generation reuses literal quotation and citation checks. Participant report outputs are withheld when configured `deny`, while the management API remains authenticated. Process restart restores accepted snapshots, tasks and report state; unsent drafts remain in the browser.

`go test . -args -mysql-config <isolated-config> -portal-browser` additionally runs the real portal with installed Playwright/Chromium through `tests/portal-browser.mjs`. Set `PORTAL_TEST_CHROMIUM` when using a separately installed executable. The browser checks login/upload, invitation, radio choices, a controlled speech-recognition hook, local draft reload, real HTTP answer submission, evidence-linked report download and logout. The model endpoint and speech recognition are controlled fixtures; this does not prove live provider quality or microphone availability.
