# Agent Note: Source-backed JD search integration

Status: implemented

English | [中文](2026-10-20-jd-search-integration.zh.md)

## Problem

The JD workbench needs actual public job descriptions. Enabling fetch only in the base bundle leaves browser sessions without the tool because shipped Agent presets own their tool registrations. Model output can also cite a different job identifier from the page actually fetched, so a plausible URL and summary do not establish source evidence.

## Decision

The standard, code and Cordis presets enable `web_fetch` against the host HTTP provider. The base importer records that workspace dependency without changing existing package resolutions. JD role inference and search use the exact owning session; changing sessions remounts the workbench rather than reusing another session's results. JD response waiting binds the exact logged instruction to its Chat turn and waits for durable turn completion. Intermediate messages and session-wide running transitions cannot establish completion. Active generation has no fixed elapsed-time deadline; the Host-configured idle limit bounds waiting without active generation or a usable connection. Stop, request failure, removal and plugin disposal reject without launching another graph request.

Candidate URLs must match actual `web_search` metadata from the current operation. A candidate, search summary or model description cannot establish a source original. The [browser-collection decision](2026-10-23-browser-first-jd-collection.md) owns acquisition and the execution guard that denies anonymous fetch and other tools in JD sessions. The general presets retain `web_fetch` for unrelated workflows. Exact captured URLs and literal text remain the evidence for graph generation; retrieval does not establish continued vacancy availability.

The Host owns versioned research projects and captured originals under its private data directory. Atomic writes and writer locks protect committed revisions; stale clients cannot overwrite another writer. Originals and graph versions are append-only, with SHA-256 verification on read and write. The Host rejects newly appended graphs that cite currently excluded sources; historical graphs retain their source hashes. The loopback-only Connection channel serves research operations independently of Worker publication and interview storage.

Discovered login-restricted URLs remain pending sources. The desktop opens an isolated persistent browser session for human login, then reads rendered job text. External pages have no native interface; cookies, passwords and browser storage do not enter research documents or model requests. Recognizable login pages and truncated HTTP results cannot establish an original. Browser and manual originals enter the owning session as logged user-message evidence for graph generation. Manual imports retain their user-supplied provenance. A BOSS list URL can display different jobs without changing its address, so it cannot identify a captured original. The reader requires a unique same-origin detail link matching the displayed role, or a standalone detail page; it rejects missing or ambiguous attribution. Visible duty-bearing sections take precedence over incidental class-name matches.

A completed graph response passes JSON decoding and the existing graph validator before persistence. Validation rejection resubmits the identical instruction and frozen source corpus within the Host-configured attempt limit; errors are not appended to the model instruction and rejected nodes are never patched or saved. One feature generation runs per session, and progress survives workbench switching. Retry exhaustion preserves historical versions and confirmations.

Every graph branch follows project/task/process/skill/knowledge. Each quote must occur literally in its identified retained JD. Direct statements require literal support; synthesis, workflow and assessment proposals remain inferred and require expert review. Coverage counts distinct cited sources without claiming market prevalence or statistical significance. The [confirmed-workspace decision](2026-10-23-confirmed-jd-workspaces.md) owns search drafts, version confirmation and HTML distribution. Export uses the saved graph and source corpus without another model request.

Primary, secondary and file-selection actions share control dimensions, typography and keyboard focus treatment. Color distinguishes action priority; action groups wrap within the workbench. The native file input retains keyboard activation and same-file reselection.

## Alternatives considered

**Trust model source URLs after syntax validation.** A real search returned a job identifier different from the successfully fetched page. Exact tool evidence prevents that mismatch from becoming a clickable result.

**Use search summaries when fetching fails.** Search summaries can omit responsibilities and dates. Returning fewer verified jobs or an empty result preserves the distinction between source evidence and inference.

**Fall back to another available conversation.** This can put JD requests and output in an unrelated interview. A missing owning session fails explicitly.

## Consequences

Live search and analysis use the user's existing configured model and native search provider, incurring ordinary provider usage; repeated validation attempts add generation calls and cannot guarantee an acceptable result. Exact prompt matching identifies this client’s single-flight request, but concurrent identical instructions from independent clients have no distinct prompt receipt in the current API. Public websites can return errors, require login or change their content; the workbench cannot guarantee the requested count or active vacancy status. Focused regressions cover false login-page success, unsupported quotes, invalid hierarchy, concurrent writers, corrupt hashes and historical evidence after exclusion. The [desktop acceptance](../../../../apps/desktop/jd-research.acceptance.mjs) runs the actual desktop, Loader, model adapter, search tools and browser collection against synthetic external services, verifying login continuation, original persistence, confirmed HTML exports and restart recovery. Its committed output snapshot is keyless. Synthetic services do not establish real platform compatibility or real model quality. Platform restrictions, model context limits and expert review remain material constraints.
