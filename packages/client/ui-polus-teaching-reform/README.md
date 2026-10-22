# Teaching reform interview workbench

English | [中文](README.zh.md)

The client plugin prepares expert profiles and versioned question packages, then publishes to an explicitly configured Worker. Existing interview data stays in the browser; the Worker owns participant sessions, execution settings and reports. The profile mounts this bundle alongside an installed `dsh-better-sidebar` provider.

## Publish and share

In interview settings, save the Worker origin and a publishing API Key created in the Worker's **发布 API Key** management page. HTTPS is required outside loopback. The Windows desktop encrypts the Key with the current OS account; the browser retains only the non-secret target and credential metadata. A browser-only client shows a desktop-update explanation and does not open a login window. Model-provider credentials are separate.

Choose **发布并打开 SPA** after reviewing the current questions. The native process uploads immediately, validates the matching receipt and opens the participant page. No second confirmation or administrator login occurs. Missing, expired, revoked or invalid authorization produces a readable inline error and a settings shortcut. Duplicate clicks share one request; a failed or cancelled operation can retry the same immutable bytes. Changed content requires a new version. Editing unchanged content preserves the version. The displayed status follows the current version's successful receipt.

New publications omit invitation credentials. Worker returns the invitation in a fragment-only share URL. The participant page consumes and removes that fragment and enters directly. Native preview requests a new interview; refreshing retains its frozen session. Browser storage holds the receipt for sharing and never the publishing Key. Anyone receiving the complete link receives its invitation.

The question-package toolbar provides JSON download and new-version actions. The link-field icon copies the complete share URL and announces success. Publications carry a default per-question limit of two and a question input policy: pure choices never request follow-ups; conditional Other requires both the selected option and written text. Worker inherits that policy until an administrator saves a 0–2 override with per-question or interview scope. Settings affect new interviews; same-version uploads preserve separate overrides. See [Worker settings](../../../worker/README.md#management-settings-and-interview-freezing).

Every expert question has a permanent text field. Generation, Markdown conversion, editing and publication normalize controls to `text` (no options) or `mixed` (auxiliary options), retaining only substantive answer choices. Generic Other/please-specify controls and non-applicable exit controls are omitted; the permanent text field accepts all narrative and supplements. Matching identifies whole control labels, including observed variants, rather than deleting business text containing those words. Legacy stored modes remain readable; participant rendering also applies to published packs and resumed interviews. Update the Worker executable and HTML/JS assets, then refresh the expert page to repair existing packs without republishing, client installation or database migration. Updated generation and editing require the client assets. Existing answers, sessions and pinned follow-up ceilings, including zero, remain unchanged. See the [narrative-input decision](../../../.agents/notes/implemented/bug-fix/2026-10-20-always-visible-expert-input.md).

## JD search

The JD workbench uses its owning DSH session, configured model and native DeepSeek search/HTTP fetch providers. All shipped presets enable fetch. Returned jobs require a successful fetch from the current request; redirects use their final URL. Unmatched model links cannot establish jobs. Discovered URLs that require login or fail fetching remain pending candidates for browser collection. See the [source-evidence decision](../../../.agents/notes/implemented/feature/2026-10-20-jd-search-integration.md).

## JD research projects

Search projects, originals, selection decisions and graph versions are stored under `DSH_HOME/jd-projects` by the Host plugin, with atomic writes and optimistic revisions. The loopback-only `/jd` Connection channel owns list, read, save and export. `projectDirectory` overrides the directory; `maxProjectBytes` defaults to 20 MiB per serialized project. Unsupported formats and corrupted source hashes fail explicitly. Saved originals and graph versions cannot be overwritten or removed; a changed capture is a new source, and a new generation is a new graph version. Exclusion affects future generation, while an older graph retains its original corpus.

Failed anonymous fetches retain discovered source URLs for collection. On Windows, **打开登录采集窗口** opens a separate persistent Electron session. Complete login or verification yourself, open a specific job detail, then choose **登录后继续采集** in the workbench. Collection reads rendered text, not browser cookies, passwords or local storage. External pages receive no native interface. The capture window also supports navigating to the next job. Browser-only users can paste or import `.txt`/`.md` originals with a source URL; these remain labelled user-supplied and are not independently authenticated. Exact-text duplicates are not counted twice. File import supports keyboard selection of `.txt`/`.md` files up to 1 MB and shows the last successfully read filename.

Each source records its original URL, capture time, acquisition method and SHA-256. BOSS list-page details require a unique same-origin job-detail link matching the displayed role title; missing or ambiguous links require opening a standalone detail page. BOSS detail URLs omit query and fragment parameters. HTTP originals are the tool's complete rendered text, not original HTML bytes; truncated results and recognizable login pages are rejected. Search region and date filters are research criteria, not verified facts about every imported source. The five-level graph rejects dangling parents, incomplete branches, unsupported direct statements and quotes absent from the retained original. Sample quote coverage counts distinct cited JDs; it is not market prevalence, statistical significance or a model-generated weight. Inferred workflow, knowledge and assessment content remains marked for expert review.

Both exports come from the same saved graph version. The AI Markdown includes stable node relationships, evidence quotes and the complete original corpus. The human PDF uses Chinese text, pagination and a source appendix with deduplicated verbatim quotes and complete-original hashes; it points readers to the MD and saved project for the full captured text. Desktop PDF generation runs in an isolated renderer with networking and scripts disabled. A browser-only client uses its print/save-as-PDF dialog. Opening saved projects restores their owning Host conversation; exporting and restoring do not regenerate the model output. The [JD decision](../../../.agents/notes/implemented/feature/2026-10-20-jd-search-integration.md) owns evidence and inference semantics.

## Model Experience

### Question-package generation

#### What the model sees

Generation renders the saved global template from **专家访谈 → 访谈设置 → 系统提示词** and sends it as a user message through the current session’s `session.prompt`. This field controls question-package generation; it does not change the Host’s system-message role or the Worker’s follow-up/report prompts. Expert fields, supplied materials and enabled reference passages replace the documented placeholders. A stored template missing the mandatory answer-mode protocol receives that protocol in the rendered request. Existing generated packages retain their content.

#### Token effect

The fourteen supplied Markdown documents are embedded in the client. Full-text search and preview read their exact bodies. Enabled sources contribute bounded verbatim passages with original-file line/column positions; generated metadata retains source hashes and excerpts through publication. The total built-in reference context is below 42,000 characters. Existing user text, titles and enable/archive choices win over seed updates. Missing bodies fail explicitly; OCR metadata is not verified bibliography and Markdown positions do not assert printed page numbers. Generation appends this rendered user message; publication and settings make no model call.

#### KV Cache effect

Generation appends to session history, preserving reusable unchanged prefixes according to provider behavior. Publishing and settings send no model request.

### JD inference, search and analysis

#### What the model sees

Role inference receives the major and optional direction. Search receives the chosen titles, platforms, region, publication window and count limit, with instructions to use real source bodies and return JSON. Graph generation receives retained JD originals, source identifiers and hashes. It returns project → task → process → skill → knowledge nodes, literal source quotes, direct/inferred labels and explicitly inferred assessment suggestions. These are user messages in the owning session; Worker publication credentials and private expert records are absent.

#### Token effect

Inference, search and analysis are separate model operations. Native web search incurs auxiliary provider calls; fetched bodies and retained JD originals add context. Graph generation is a separate model operation; PDF/Markdown export reads the saved graph and makes no model call. The five-result test mode is an upper limit, not a guarantee. Source matching, exclusion and displaying results make no extra model call.

#### KV Cache effect

Operations append to the same owning session and can reuse its unchanged prefix. A new JD session has separate history.


## Known Limitations and Deferred Work

- Native publication requires the current desktop broker and a Worker supporting upload Keys. [Loader acceptance](../../../apps/web/tests/worker-publication.e2e.ts) uses `DSH_WORKER_SIDEBAR_PACKAGE`; [native acceptance](../../../apps/desktop/publisher-ui.acceptance.mjs) exercises the actual EXE and isolated Worker HTTP/assets. SQL acceptance separately verifies database storage and migration. Synthetic fixtures do not establish real model quality or microphone acceptance. The [authorization decision](../../../.agents/notes/implemented/feature/2026-10-16-worker-publisher-keys.md) records credential scope and rollback constraints.
