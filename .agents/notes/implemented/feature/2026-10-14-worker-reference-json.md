# Agent Note: Stable source reference JSON identity

Status: implemented

English | [中文](2026-10-14-worker-reference-json.zh.md)

## Problem

MySQL JSON storage reorders object keys. Retained question references use raw JSON, so equivalent snapshots can acquire different hashes after storage. Reloading a frozen interview then regenerating its report can fail package or input-version checks; historical idempotency records can also reject equivalent requests.

## Decision

Question JSON serialization sorts reference object keys recursively while preserving values, numeric precision, unknown fields and array order. Hashes and wire responses share this serialization. Prompt releases and publication hashes retain their existing serialization.

When a retained request digest differs, idempotency compares the complete stored submission using normalized question JSON. An equal-version snapshot digest mismatch is accepted only when the complete retained snapshot matches after normalization. Existing digests, snapshots, answers and reports remain unchanged. New versions and requests store normalized digests.

## Alternatives considered

**Frontend reconstruction** repairs one caller but leaves backend replay and historical idempotency inconsistent. **Global hash changes** would alter unrelated prompt release identities. **Database rewrites** would require migration and rollback coordination for immutable records. Scoped serialization with retained-input comparison avoids these costs.

## Consequences

Equivalent reference object ordering survives storage, reload and retries. Changed answers, reference values, array ordering, request kinds and versions retain distinct identities. Isolated MySQL acceptance covers historical digests, duplicate requests, frozen session regeneration and rejected content changes; browser acceptance reloads the real portal and regenerates a report using a controlled model endpoint.
