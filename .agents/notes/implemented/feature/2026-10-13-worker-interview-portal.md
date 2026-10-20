# Agent Note: Worker interview portal with pinned publications

Status: implemented

English | [中文](2026-10-13-worker-interview-portal.zh.md)

## Problem

DSH publications carry profile, metadata and optional question hints that the local preview DTO cannot import. A single startup question pack does not identify independent public interviews, and browser-only submission cannot establish a durable answer or report. Management accounts and publication uploads require server authorization without forcing participant registration.

## Decision

Explicit answer controls and legacy compatibility are defined by the [answer-mode decision](2026-10-20-explicit-interview-answer-modes.md); auxiliary options in mixed questions do not suppress their text field.

The [portal service](../../../../worker/internal/service/portal.go) serves the existing SPA assets at root and the legacy filename. An independent portal configuration leaves loopback preview restrictions intact. Participant entry mode, invitation mode and report visibility are explicit selectable options; participant routes remain disabled until those choices are configured. No default product decision is inferred from an implementation test.

The Worker participant view keeps the question navigation and gives the answer card the remaining width in a two-column grid, retaining the template's height, scrolling and mobile breakpoint rules. It omits the model-name badge, persistent draft/freeze banner and right-hand information cards. The explicitly excluded host-only helper sentence is filtered only during display; other hints, stored publication data, submitted answers and model behavior remain intact. The welcome text, confirmed-question count and navigation remain available; completing the final question still opens the existing confirmation and report flow without a separate review shortcut.

The [publication module](../../../../worker/internal/published/pack.go) accepts DSH fields without requiring slots, retains optional followUp and sourceRefs, and requires an explicit package-owned follow-up policy for portal sessions. The engine receives the goal, background, answer history and optional hints as data. It can accept sufficient answers without composing another question. Both pre-model and final transactional checks enforce published follow-up counts.

Validated files are atomically published without replacing different content under the same key. Rooted filesystem operations reject escaping paths and symlinks. MySQL participant sessions capture the publication copy, version, full private digest and policy. Browser binding digests exclude invitation information; a fast digest containing a short code would enable offline guessing. Removing a directory package does not change an existing session.

The [management service](../../../../worker/internal/service/management.go) uses database accounts and revocable sessions separately from participant cookies. First initialization inserts admin only with an operator-supplied strong hash; restart does not overwrite the password and there is no forced first-login change. Exact-origin mutation checks, HttpOnly cookies and bounded login attempts protect both entries. Report bodies remain subject to explicit participant visibility and authenticated management access.

[Portal acceptance](../../../../worker/portal_acceptance_test.go) runs the real process with isolated MySQL and a controlled model, covering version-1 migration, retained data, hashed credentials, session restart, idempotency, package deletion, report access and cross-session rejection. The browser scenario verifies upload, choices, a controlled voice hook, draft reload, real answer requests, report download and logout. Live model quality and microphone support remain separate from fixture acceptance.

The [MySQL lease decision](../architecture/2026-10-11-go-teaching-worker.md) remains active: queue fencing, release capture and report evidence responsibilities are retained. This record adds portal authorization and multi-publication ownership rather than replacing those mechanisms.

## Alternatives considered

- Reusing public preview routes would weaken their explicit loopback guarantee. The portal has its own configuration and session namespace.
- Keeping publication solely in localStorage cannot transfer data to another origin or preserve accepted answers across process restart. Files carry publications and MySQL owns accepted state.
- Server per-package limits and mandatory required slots conflict with package-owned counts and contextual AI judgment. The package policy is explicit and hints remain optional data.
- A new identity product or complex RBAC adds unrelated scope. Existing MySQL holds the minimal management account, while participants retain separate invitation/session access.

## Consequences

Schema version 2 adds portal tables through an explicit version-1 upgrade under the existing database lock. Configured deployments need a private bootstrap hash only when admin does not exist. No actual credential or public deployment is created by the implementation tests.

DSH adds a JSON export and explicit goal/policy controls without replacing its existing confirmation and publishing operations. Legacy publications without policy can be inspected but cannot begin portal sessions. Version-ambiguous aliases require a specific upload key. Management report listing is currently bounded to the latest 200 tasks; unsent drafts remain browser-local.
