# Teaching Reform Workbench

English | [中文](README.zh.md)

After users confirm the JD sample and generate typical work tasks, the workbench writes `typical-work-tasks.md` and a human-readable `typical-work-tasks.html` beside the job data. The HTML report follows the supplied capability-map example styling, and its “Read report” action opens the saved HTML with the host default application, normally a browser. The report records the task descriptions, sample frequency hints, source JD ids, professional ability tags, confirmed job details, and source links. Task definitions and frequency interpretation follow the JD-driven capability mapping methodology: tasks are verb-led, independently deliverable activities supported by JD evidence, while sample frequency is not a market-wide statistic.

A search result immediately creates a sidebar project record keyed by its DSH session id. Project listing metadata and excluded job ids are stored in browser local storage, with a volatile in-memory fallback while the client is running. Job data and the reports are stored in the DSH workspace through the active session's file tools; a failed file write remains visible in the workbench and does not remove the project from the sidebar.

## Expert interviews

The client plugin prepares expert profiles and versioned question packages, then publishes to an explicitly configured Worker. Existing interview data stays in the browser; the Worker owns participant sessions, execution settings and reports. The profile mounts this bundle alongside an installed `dsh-better-sidebar` provider.

## Publish and share

In interview settings, save the Worker origin and a publishing API Key created in the Worker's **发布 API Key** management page. HTTPS is required outside loopback. The Windows desktop encrypts the Key with the current OS account; the browser retains only the non-secret target and credential metadata. A browser-only client shows a desktop-update explanation and does not open a login window. Model-provider credentials are separate.

Choose **发布并打开 SPA** after reviewing the current questions. The native process uploads immediately, validates the matching receipt and opens the participant page. No second confirmation or administrator login occurs. Missing, expired, revoked or invalid authorization produces a readable inline error and a settings shortcut. Duplicate clicks share one request; a failed or cancelled operation can retry the same immutable bytes. Changed content requires a new version. Editing unchanged content preserves the version. The displayed status follows the current version's successful receipt.

New publications omit invitation credentials. Worker returns the invitation in a fragment-only share URL. The participant page consumes and removes that fragment and enters directly. Native preview requests a new interview; refreshing retains its frozen session. Browser storage holds the receipt for sharing and never the publishing Key. Anyone receiving the complete link receives its invitation.

The question-package toolbar provides JSON download and new-version actions. The link-field icon copies the complete share URL and announces success. Publications carry a default per-question limit of two and a question input policy: pure choices never request follow-ups; conditional Other requires both the selected option and written text. Worker inherits that policy until an administrator saves a 0–2 override with per-question or interview scope. Settings affect new interviews; same-version uploads preserve separate overrides. See [Worker settings](../../../worker/README.md#management-settings-and-interview-freezing).

Every expert question has a permanent text field. Generation, Markdown conversion, editing and publication normalize controls to `text` (no options) or `mixed` (auxiliary options), retaining only substantive answer choices. Generic Other/please-specify controls and non-applicable exit controls are omitted; the permanent text field accepts all narrative and supplements. Matching identifies whole control labels, including observed variants, rather than deleting business text containing those words. Legacy stored modes remain readable; participant rendering also applies to published packs and resumed interviews. Update the Worker executable and HTML/JS assets, then refresh the expert page to repair existing packs without republishing, client installation or database migration. Updated generation and editing require the client assets. Existing answers, sessions and pinned follow-up ceilings, including zero, remain unchanged. See the [narrative-input decision](../../../.agents/notes/implemented/bug-fix/2026-10-20-always-visible-expert-input.md).

## Model Experience

### Question-package generation

#### What the model sees

Generation renders the saved global template from **专家访谈 → 访谈设置 → 系统提示词** and sends it as a user message through the current session’s `session.prompt`. This field controls question-package generation; it does not change the Host’s system-message role or the Worker’s follow-up/report prompts. Expert fields, supplied materials and enabled reference passages replace the documented placeholders. A stored template missing the mandatory answer-mode protocol receives that protocol in the rendered request. Existing generated packages retain their content.

#### Token effect

The fourteen supplied Markdown documents are embedded in the client. Full-text search and preview read their exact bodies. Enabled sources contribute bounded verbatim passages with original-file line/column positions; generated metadata retains source hashes and excerpts through publication. The total built-in reference context is below 42,000 characters. Existing user text, titles and enable/archive choices win over seed updates. Missing bodies fail explicitly; OCR metadata is not verified bibliography and Markdown positions do not assert printed page numbers. Generation appends this rendered user message; publication and settings make no model call.

#### KV Cache effect

Generation appends to session history, preserving reusable unchanged prefixes according to provider behavior. Publishing and settings send no model request.

## Known Limitations and Deferred Work

- Native publication requires the current desktop broker and a Worker supporting upload Keys. [Loader acceptance](../../../apps/web/tests/worker-publication.e2e.ts) uses `DSH_WORKER_SIDEBAR_PACKAGE`; [native acceptance](../../../apps/desktop/publisher-ui.acceptance.mjs) exercises the actual EXE and isolated Worker HTTP/assets. SQL acceptance separately verifies database storage and migration. Synthetic fixtures do not establish real model quality or microphone acceptance. The [authorization decision](../../../.agents/notes/implemented/feature/2026-10-16-worker-publisher-keys.md) records credential scope and rollback constraints.
