# Agent Note: Explicit interview answer modes

Status: implemented

English | [中文](2026-10-20-explicit-interview-answer-modes.zh.md)

## Problem

Generated interview questions use options as memory aids even when their main answer is narrative. Deriving answer controls solely from the presence of options hides the narrative field and restricts text to the Other selection, contradicting the mixed interview methodology.

## Decision

Each new generated question declares `answerMode`: `text` has a permanent text field and no options; `choice` has options and no text field; `mixed` has options and a permanent text field; `other` has options and a conditional text field triggered by a matching Other label. `type` retains topic and single/multiple-selection information. The client validates incompatible or unknown modes, retains modes through parsing, edits, browser persistence and export, and derives the per-question policy again at publication. Saved custom generation templates receive the same mandatory control protocol as the default template.

Worker publication parsing validates the explicit mode against its options and input policy, rejecting missing or contradictory policies. Text and mixed modes map to `input: text`, choice to `none`, and conditional Other to `other`. Actual nonblank text is required for model eligibility, with at most two published follow-ups per question; existing lower limits still apply. The [portal](2026-10-13-worker-interview-portal.md) retains the pinned publication and derived snapshot policy. Presentation changes do not replace either publication or snapshot data.

Missing `answerMode` retains the legacy type/options derivation, including saved conditional-Other policies. No migration reinterprets existing publications or frozen interviews. A host repairs an affected draft by selecting a mode and publishing a new version; existing interviews remain pinned, and a new interview uses the new version. Explicit-mode publications require the updated client and Worker; an older Worker rejects the unknown field. No database schema or credential change is required.

## Alternatives considered

**Treating every option-bearing question as choice** hides narrative answers. **Making all choices mixed** changes consent and pure-choice semantics. **Only changing the SPA or the prompt** leaves publication validation and model eligibility inconsistent. **Automatically rewriting old packs** changes pinned interview behavior without host review.

## Consequences

Hosts can preserve auxiliary options without losing free text and can repair saved drafts without a new model call. The client and Worker require coordinated updates; the new protocol does not retroactively fix published versions. Four explicit modes make the answer field independent of a model's free-form topic labels while retaining legacy behavior only for records without the new field.

## Testing

Fixed client fixtures exercise parsing, persistence and repeated publication. The runnable teaching-pack CLI snapshot covers the four modes without provider access. Worker publication and engine tests cover matching policies, invalid controls, frozen copies, conditional eligibility and the third-follow-up rejection. The isolated browser scenario mounts the actual host editor and participant assets with synthetic HTTP responses, covering mode editing, reload, mixed text/selection payloads and conditional Other; it does not establish live model quality or production acceptance.
