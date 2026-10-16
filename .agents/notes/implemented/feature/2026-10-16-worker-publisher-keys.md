# Agent Note: Worker publishing API Keys

Status: implemented

English | [中文](2026-10-16-worker-publisher-keys.zh.md)

## Problem

Publication tied to administrator sessions interrupts first use and expiry with interactive login. Sharing administrator identity also grants more authority than upload needs. Hosts need one-click publication after configuring a dedicated Key while preserving participant invitations and old packages.

## Decision

Worker administrators create named, revocable, optionally expiring upload Keys. Plaintext is returned only on creation; MySQL retains a hash. The dedicated endpoint returns only the matching immutable upload receipt, with no report, management or model-API authority. A desktop OS-encrypted vault exposes narrow configuration/status/publication IPC only to the local main frame; remote participant windows have no preload. Uploads reject redirects and validate same-origin participant URLs. Browser persistence contains no publishing Key.

The UI derives published status from the current version's receipt and needs only one publication click after review. Advanced prompts are collapsed; reports, settings and Key management are separate pages. The [invitation decision](2026-10-15-worker-owned-invitations.md) owns participant credentials. The older browser bridge remains supported; native publication does not depend on it.

The [original implementation plan](../../../../docs/worker-spa-implementation-plan.md) retains its explicitly requested Chinese-only form through a single-file translation exclusion. Generated catalogs follow their owning source; existing paired runtime and UI documentation retains both languages with confirmed content hashes. The Corch branding package documents its browser-only behavior and external font dependency.

## Alternatives considered

**Administrator Cookies.** They cannot guarantee direct first-use publication and grant administrator identity beyond upload needs.

**Static configuration token.** Creation/revocation requires server credential edits and restart, preventing named management in the existing administrator UI.

**Browser-persisted Key.** Ordinary page scripts and browser storage receive long-lived plaintext; native OS encryption limits that exposure.

## Consequences

Schema5 adds an empty Key table; schema4 executables reject it. Before all new writes, stopped writers and full fingerprints permit complete schema3/4 restoration. Key creation/use/revocation or business writes require preserving5 and compatible repair. Revocation does not terminate already authorized in-flight requests. Lost Keys require revocation/replacement, and another Windows account must configure its own saved Key. Browser-only publication is unavailable.

## Verification

HTTP/native tests cover no-Cookie first upload, negative scope checks, hash-only/one-time disclosure, expiry/revocation, stable retries, cancellation and duplicate merging. Isolated MySQL acceptance verifies migration, restoration and retained data. Actual EXE/browser acceptance covers saved configuration/reload, single-click entry, error guidance and separate pages. These synthetic checks do not establish real model, microphone or production deployment acceptance.

Isolated access acceptance accepts a predeclared `tw_access_accept_` name with exactly 32 hexadecimal UUID characters. It validates the name before opening a connection and refuses the configured source database. A separate absence check can explicitly drop only that validated test database, allowing cleanup to be verified after a failed rehearsal as well as a successful one.
