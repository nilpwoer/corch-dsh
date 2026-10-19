# Agent Note: Traceable interview inputs and bounded text follow-ups

Status: implemented

English | [中文](2026-10-16-traceable-interview-inputs.zh.md)

## Problem

A reference title and editorial summary cannot establish which source text reached question generation. A package without policy also blocks an otherwise authorized publication, while a textarea on every choice question makes non-text answers eligible for model follow-ups. Operators need saved settings to remain visible without silently changing an interview already in progress.

## Decision

Embed the fourteen host-supplied Markdown bodies and their original paths and SHA-256 hashes. Preserve twelve stable source IDs and leave the two additional sources unclassified. Existing nonempty user bodies and saved selection state take precedence over seeds. Missing text fails explicitly. Full-text search and preview use the body; generation receives bounded verbatim passages with original Markdown line/column locations, and publication metadata retains those passages and hashes. OCR bibliography and printed page numbers are not inferred.

The client’s saved generation template is rendered into `session.prompt` as a user message. Its UI name does not grant the Host system-message role or change Worker follow-up/report prompts. Enabled source passages and expert inputs fill the documented variables.

New publications carry per-question two by default; new Worker sessions resolve a missing policy to that default and cap new overrides at two. Consent and pure choices have no text control or model call. Conditional Other requires selection and written text. Administrators can save 0–2 with per-question or interview scope. New-session preview adopts current settings; reload retains the frozen interview. Failure retains answers and offers continue or an explicit retry under a fresh input revision.

This partially supersedes the policy prerequisite in [publication settings](2026-10-14-worker-direct-publish-settings.md) and [portal entry](2026-10-13-worker-interview-portal.md). Those notes retain authentication, immutable publication and execution-freezing decisions, so neither is fully superseded.

## Alternatives considered

Replacing source bodies with summaries loses inspectable evidence. Sending all books on every generation wastes context. Overwriting saved user documents during seeding destroys local edits. Re-resolving settings during refresh changes interviews midway. Enabling textareas for choices invents an answer modality rather than respecting the question.

## Consequences

The client bundle includes approximately 7.7 MB of supplied source text; generation uses fewer than 42,000 reference characters. Original file hashes and line positions identify the supplied OCR edition, not verified bibliographic facts. No schema migration rewrites frozen interviews. Real EXE/Edge acceptance with isolated MySQL and local providers pins publication, persisted overrides, conditional text and failure recovery. Unit tests pin exact source passages, bounded context and user-data precedence. Synthetic providers establish request wiring, not live model quality or microphone acceptance.
