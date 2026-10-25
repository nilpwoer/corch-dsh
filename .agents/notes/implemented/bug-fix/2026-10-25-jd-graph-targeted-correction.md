# Agent Note: Targeted correction of rejected JD graphs

Status: implemented

English | [中文](2026-10-25-jd-graph-targeted-correction.zh.md)

## Problem

A completed model response can contain a valid five-level tree and literal quotations while labelling an expanded description as direct evidence. Repeating the same instruction without the validator's node and field diagnostics can reproduce that error until the attempt limit is exhausted. A fixture that supplies a valid answer after a fixed number of calls cannot establish that a correction reaches the model.

## Decision

The first graph request uses the existing base prompt verbatim. A rejected response produces a new logged request with the same base prompt and frozen source corpus, followed by structured validation feedback. Feedback identifies the failed attempt and category. Parsed graph diagnostics retain every invalid parent, incomplete branch and unsupported direct declaration, including its unchanged node, offending fields, expected level and verified quotations. Malformed JSON and earlier field or quotation failures return their specific category or reason. The owning session retains the rejected model response; feedback does not duplicate its entire graph.

The model returns a complete corrected graph. Application code never patches nodes, converts labels or edits source quotations to pass validation. The same validator checks each new response before a version can be saved. Configured attempt limits, cancellation, transport failures, turn completion, immutable versions and confirmations retain the [source-backed JD rules](../feature/2026-10-20-jd-search-integration.md). This note supersedes only that note's instruction-only retry decision; its source and persistence guarantees remain active.

Correction feedback is model-visible data in the durable user message, encoded as JSON and identified as validator data rather than external instructions. Existing exact-message turn correlation applies to the appended request. The base prompt, original evidence, methodology and report layout remain unchanged. No additional tools become available.

## Alternatives considered

**Repeat the original instruction alone.** This supplies no actionable explanation of the failed declaration and permits the same error on every attempt.

**Relax direct-evidence matching or change labels in application code.** This can accept unsupported statements or silently change model authorship. The model must correct its declaration and satisfy the existing evidence rules.

**Append the entire rejected graph.** The owning session already records that response. Node-specific diagnostics preserve the relevant context with less duplication.

## Consequences

Retry feedback adds context and ordinary model usage within the existing attempt limit; it cannot guarantee a valid response. Exhaustion leaves previous versions, confirmations and originals intact. Unit tests pin the actual expanded-description failure, multiple simultaneous diagnostics, unchanged rejected input and request cancellation. The assembled desktop fixture advances from each invalid response only after receiving its corresponding feedback, while preserving the base prompt and source corpus. Missing or mismatched feedback cannot produce a passing correction transcript. Real-model acceptance remains necessary to establish provider behavior on the retained JD corpus.
