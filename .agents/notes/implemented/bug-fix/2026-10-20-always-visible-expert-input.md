# Agent Note: Always-visible expert narrative input

Status: implemented

English | [中文](2026-10-20-always-visible-expert-input.zh.md)

## Problem

Published expert questions can hide the answer field behind Other or omit it entirely. Teachers need to describe their experience before making any selection. Repairing only generation leaves published packs and resumed interviews affected.

## Decision

Every expert question displays a permanent narrative field, including legacy `choice`, `other` and mode-less publications. Generation, Markdown conversion, editing and publication normalize controls to `text` or `mixed`. Only substantive answer choices remain. Generic Other/please-specify labels and non-applicable exit controls, including the observed Chinese variants, are omitted from new options and participant rendering. The permanent field accepts narrative and supplements without selection. Filtering targets complete control-label forms, preserving substantive business sentences such as interdepartmental collaboration and handling inapplicable clauses. Markdown splitting preserves parenthesized descriptions so business text is not split into accidental options.

Participant rendering filters labels without renumbering the original options. Submitted and local historical selections, including a previously selected retired label, remain intact. The Worker accepts structured narrative text on legacy `none` policies and treats actual nonblank text as eligible without requiring Other. Existing snapshot hashes, question policies, question-pack versions and frozen reports remain unchanged; pinned zero or lower follow-up ceilings still apply. Selection membership, answer-text consistency and input-size checks remain enforced.

This partially supersedes the presentation and generation rules in [explicit answer modes](../feature/2026-10-20-explicit-interview-answer-modes.md). That record remains active for the accepted publication formats and strict mode/policy validation. No stored pack, session or answer is migrated. Local preview drafts restore only when the stored pack identifier and complete questions match the loaded pack, preventing cross-pack answer reuse.

## Alternatives considered

**Regenerate or republish every pack.** This misses resumed interviews and needlessly creates new versions. Runtime presentation and submission compatibility repair existing packs directly.

**Change only the page.** Legacy `none` policies reject written answers during submission. The service must accept the newly visible narrative field as well.

**Remove retired labels from stored arrays.** Local drafts can refer to option indices and saved answers can contain the label. Rendering omits controls while storage retains their identity.

## Consequences

Published packs take effect after updating the Worker executable and its HTML/JS assets and refreshing the participant page. No client update, republishing, invitation rotation or database migration is required for those packs. Updated generation, editing and local previews require the client assets too. Completed reports stay read-only, and historical follow-up budgets remain pinned.

## Testing

Client tests use nineteen exact labels observed in published packs, plus explicitly requested variants, to cover normalization, Markdown conversion, publication and the real keyless CLI snapshot. Worker tests cover acceptance of legacy choice text, historical option retention, unknown-option rejection, independent narrative eligibility and existing follow-up ceilings. An isolated browser scenario exercises the actual host React editor and participant scripts with synthetic data, intercepted network requests, desktop/mobile layouts and draft/session restoration. This evidence does not assert production deployment or live model quality.
