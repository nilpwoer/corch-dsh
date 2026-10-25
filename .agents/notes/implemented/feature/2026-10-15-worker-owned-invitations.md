# Agent Note: Worker-owned participant invitations

Status: implemented

English | [中文](2026-10-15-worker-owned-invitations.zh.md)

## Problem

Client-generated invitations make publication data the credential authority and hide access management from operators. A combined management page also mixes a selected package's settings with unrelated report content.

## Decision

New publication clients omit credentials and require the Worker invitation capability before transferring JSON. An authenticated upload creates one Worker-generated random access record bound to the immutable publication hash; the [six-digit invitation decision](2026-10-19-six-digit-worker-invitations.md) owns its numeric format and guessing-risk tradeoff. Unique-key insertion resolves concurrent retries to the same credential. Admin-only, no-store responses provide the recoverable code and fragment share URL; ordinary package lists and participant views do not. Existing MySQL permissions protect recoverable access data without a new master key or administrator credential.

Existing publication codes remain a read-only compatibility source. They are not backfilled or rotated by migration, viewing, uploading or retry. Explicit, revision-checked administrator actions create, rotate or revoke access; a revoked record never falls back to the legacy code. Active participant cookies and frozen execution remain separate from invitation validity. Client persistence pins legacy invitations to their original version and displays later invitations only from authoritative receipts.

The package editor, package list and report page have distinct views and fetch only their own data. The package editor contains masked invitation controls and navigation to the other views. The public entry page retains server-side verification and never receives an expected code from a public read endpoint.

## Alternatives considered

Keeping client generation would retain two authorities. Rewriting publication JSON for rotation would change immutable hashes and old session bindings. Hash-only invitation storage would prevent stable receipt retries and authorized redisplay; recoverable server storage is required for those consumers. Automatic legacy backfill would create production credential records without explicit publication or management intent.

## Consequences

Schema4 adds a separate access table without credential backfill. New clients reject older Worker capabilities; older clients retain legacy publication behavior. Schema3 binaries reject schema4. The [maintenance reference](../../../../worker/deploy/access-maint/README.md) defines the guarded full-restore boundary and UI-only schema4 fallback. Backups cannot safely discard post-migration writes.

Isolated SQL/HTTP acceptance covers additive migration, concurrent stable receipts, old invitations, admin-only visibility, invalid/revoked codes and guarded rollback. Native acceptance uses synthetic data to cover both client generations, independent settings/report views, copied fragment links, prefill and explicit entry without model calls. These fixtures do not establish production credential initialization, microphone or live model quality.
