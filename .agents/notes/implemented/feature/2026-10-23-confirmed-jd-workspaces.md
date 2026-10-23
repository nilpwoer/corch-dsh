# Agent Note: Archived search sessions and confirmed JD graphs

Status: implemented

English | [中文](2026-10-23-confirmed-jd-workspaces.zh.md)

## Problem

A saved evidence corpus does not restore an unfinished search. Losing draft fields, the active step or selected graph when switching conversations makes separate searches appear to share state. A generated draft also needs an explicit, durable selection before curriculum construction can consume it.

## Decision

Each new search immediately receives its own Host session and project document. The Host rejects a second project for the same session. Repeating a completed search creates another session with copied search criteria and no inherited evidence. Serialized client writes retain drafts, filters, capture text, the selected step and graph version. Switching through the search history flushes pending writes; asynchronous search results remain owned by the originating session.

Graph generation creates an immutable draft version. Confirmation is a separate Host operation with an authoritative timestamp and optimistic revision check. Confirmations are append-only, repeated confirmation is idempotent, and a new graph version requires its own confirmation. The loopback-only confirmed roster supplies project and version identifiers for subsequent curriculum construction; confirmation does not assert expert approval. Original evidence, source hashes and graph validation remain owned by the [source-backed JD decision](2026-10-20-jd-search-integration.md).

The workbench has one graph step. Its primary action confirms the selected version, then exposes HTML export for that confirmed version. The Host rejects unconfirmed export. The standalone report contains a cover, contents, five-level tree, evidence table, source links and original hashes, with explicit inference labels. Reference-report styling does not establish evidence for course gaps, trends or sample prevalence. The desktop saves the report under its private exports directory, opens its file URL in the system browser and falls back to revealing the saved file. Restrictive content policy disables report scripts and network access.

Pending-source actions open the chosen job directly. Continue-capture appears only while the project’s platform window is open. The [browser-collection decision](2026-10-23-browser-first-jd-collection.md) owns automatic rendering, session reuse, durable platform stops and human verification. Manual import remains the source-labelled alternative when the user can obtain authorized text through their normal browser. Login does not guarantee platform access.

## Alternatives considered

**Restore only the final results.** This preserves evidence but loses unfinished work and the selected historical version. **Treat generation as confirmation.** This makes an unreviewed draft indistinguishable from the version selected for later use. **Expose separate graph and export steps with MD/PDF actions.** These repeat the same graph and bypass the user's requested confirmation sequence; the report is distributed as HTML while structured data remains in the project. **Retry or disguise automated access after an anti-bot page.** This cannot establish reliable platform compatibility and can worsen access restrictions; the reader reports the restriction instead.

## Consequences

Draft fields and pasted originals are private durable data subject to the project's byte limit. A failed save prevents history navigation rather than silently discarding edits. Existing format-one projects without workspace or confirmation fields remain readable. Source retrieval, confirmation and export do not imply expert endorsement. Focused store/UI/native tests and the assembled desktop snapshot cover independent sessions, state restoration, immutable confirmations, pre-confirmation export denial, source attribution, blocked collection and saved HTML. Synthetic acceptance establishes application behavior, not BOSS availability or model quality.
