# Agent Note: Validate report citations before checkpointing

Status: implemented

English | [中文](2026-10-14-worker-report-citations.zh.md)

## Problem

A structurally valid model response can omit citations, cite unknown evidence or claim unsupported profile details as interview facts. Checkpointing that response before business validation causes retries to reuse the invalid result.

## Decision

Report evidence and composition use versioned checkpoint names and pass schema and business validation before persistence. The model receives allowed evidence IDs, conditional citation requirements and instructions separating answers from unconfirmed background. Evidence quotes must match saved answers. Empty evidence permits only statements marked `needs_verification` and no task cards.

`prompts.report.max_corrections` freezes a zero-to-three additional-call budget per stage into each report release. A rejected response remains in the call audit, and the next call receives validation field paths plus the original input. Only a validated response becomes a checkpoint. Configuration changes require a fresh release version. Legacy failed reports and checkpoints remain intact.

## Alternatives considered

Attaching an arbitrary evidence ID satisfies a structural check without supporting the statement. Removing citation validation publishes unsupported claims. Retrying a persisted invalid response repeats the same failure. These alternatives are rejected.

## Consequences

Report corrections can incur additional provider calls within the captured budget and task timeout. Unknown IDs, empty citations on facts or cards, invented quotes and zero-evidence assertions are rejected. These checks establish provenance, not semantic entailment; real report acceptance must still compare claims with cited quotes. Model tests cover rejection, bounded correction and checkpoint reuse; process acceptance records the assembled request and response snapshot.
