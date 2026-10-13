# Agent Note: Go teaching worker with MySQL leases

Status: implemented

English | [中文](2026-10-11-go-teaching-worker.zh.md)

## Problem

Interview follow-ups and report generation must survive API or consumer termination, retain the instructions actually used, and reject results for superseded answers. The deployment requires a Go executable started with `serve -c`, YAML-owned prompts, and MySQL storage. Occasional prompt revisions do not justify an additional configuration service.

## Decision

[worker/](../../../../worker/README.md) is an independent Go module using Cobra and GORM/MySQL. A trusted backend submits confirmed snapshots to an asynchronous API. API and consumer roles can run separately or together without changing task semantics. The existing TypeScript application and Cordis loop remain separate consumers rather than implicit runtime dependencies.

MySQL transactions own enqueue idempotency, snapshot versions and report freezing. Short `SKIP LOCKED` transactions assign renewable leases; publication and checkpoints require the current claim token and an unexpired database-clock lease. Model requests run outside transactions. Completed stages are durable, but a crash between an external response and checkpoint can repeat a billed call. This is deliberate at-least-once execution with fenced publication.

Each task captures its prompt/model/provider release and execution limits. A release version cannot be reused for changed contents. Interviews pin their follow-up release; a new report task may select a newer report release over frozen answers while retaining earlier reports. YAML changes require restart, keeping configuration rollout explicit.

All runtime settings, including database credentials, backend tokens and model keys, come from the startup YAML. Model keys are excluded from captured releases and their hashes; consumers resolve credentials from current configuration and require the endpoint to match the captured provider. Credential rotation therefore does not revise historical prompts or send credentials to a different queued endpoint.

The optional local browser entry serves the existing SPA assets and submits through a same-origin gateway. A signed HttpOnly cookie scopes each interview without exposing the shared backend token. Numeric loopback listeners, loopback peers and host/origin checks restrict this entry to local debugging; public expert identity remains an application concern. Browser storage holds drafts and retry identifiers while MySQL holds accepted snapshots and tasks.

Server deployment uses a static Linux binary under systemd with a non-login OS account. Nginx terminates HTTPS and translates the public `/teaching-worker/v1/` prefix to the Worker's `/v1/` API. The executable listens on the Docker bridge host gateway, and the public proxy exposes only the authenticated API and health; the local browser gateway stays disabled on the server. Deployment YAML and the Nginx upstream must use the same gateway and port.

Reports separate literal evidence extraction from composition. Code checks JSON fields, original quotations and citation IDs; prompts distinguish expert facts from interpretations. These checks establish traceability, not semantic truth or resistance to prompt injection.

## Alternatives considered

- A TypeScript worker inside the plugin runtime conflicts with the requested standalone Go deployment and couples queue availability to application assembly.
- PostgreSQL queue libraries or Redis add storage systems outside the MySQL deployment requirement. MySQL leases provide the required multi-consumer scheduling within the same transactions as interview state.
- Hot-reloaded prompt files make in-flight behavior harder to reproduce. Explicit release versions and restart suit occasional revisions without a configuration control plane.
- Synchronous model calls inside API requests lose independence from client connections and API lifecycle; model calls inside database transactions retain locks across external latency.

## Consequences

The backend API uses a shared server token and owns no expert identity. Public browser access requires an application authorization layer. Reports freeze an interview at enqueue; editing frozen answers requires another interview ID. Local draft synchronization, question administration, retention/deletion and report export remain application responsibilities.

[Process acceptance](../../../../worker/acceptance_test.go) builds and runs the executable against real MySQL with a controlled model endpoint, asserting lease recovery after process termination, claim fencing, version/idempotency conflicts, stage reuse, concurrent consumers and immutable/regenerated reports. The assembled transcript has a keyless golden snapshot. Real provider compatibility and semantic report quality are separate acceptance requirements; a deterministic fixture cannot establish them.

The [interview portal decision](../feature/2026-10-13-worker-interview-portal.md) owns publication uploads and public participant sessions; this record continues to own MySQL leases and captured execution releases.
