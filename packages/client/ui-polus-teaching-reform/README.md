# Teaching reform interview workbench

English | [中文](README.zh.md)

The client plugin prepares expert profiles and versioned question packages, then publishes to an explicitly configured Worker. Existing interview data stays in the browser; the Worker owns participant sessions, execution settings and reports. The profile mounts this bundle alongside an installed `dsh-better-sidebar` provider.

## Publish and share

In interview settings, save the Worker origin and a publishing API Key created in the Worker's **发布 API Key** management page. HTTPS is required outside loopback. The Windows desktop encrypts the Key with the current OS account; the browser retains only the non-secret target and credential metadata. A browser-only client shows a desktop-update explanation and does not open a login window. Model-provider credentials are separate.

Choose **发布并打开 SPA** after reviewing the current questions. The native process uploads immediately, validates the matching receipt and opens the participant page. No second confirmation or administrator login occurs. Missing, expired, revoked or invalid authorization produces a readable inline error and a settings shortcut. Duplicate clicks share one request; a failed or cancelled operation can retry the same immutable bytes. Changed content requires a new version. Editing unchanged content preserves the version. The displayed status follows the current version's successful receipt.

New publications omit invitation credentials. The Worker returns the participant invitation and fragment-only share URL with the upload receipt. Browser storage retains that receipt for display/copy; it never contains the publishing Key. Legacy invitation data remains available for byte-stable original-version retries, while new versions omit it. Anyone receiving the full share link receives its invitation. The Worker removes the fragment from history, pre-fills the code and waits for participant entry; it does not automatically start an interview.

The question-package toolbar provides JSON download and new-version actions. The preview presents the invitation and link. Configure follow-up scope/count and inherited or overridden prompts in the separate [Worker editor](../../../worker/README.md#management-settings-and-interview-freezing). New packages do not infer a policy; participant entry requires an explicit publication policy or saved package override. Same-version upload preserves separate Worker settings. Reports have their own management page.

## Model Experience

### Question-package generation

#### What the model sees

Generation submits the [rendered interview prompt](src/client/interviewPrompt.ts) through the existing session, including expert information, supplied materials and enabled references. Publication, edits, settings and report viewing make no model requests.

#### Token effect

Generation appends the rendered user message; its size depends on supplied information. Publication and settings add no model input tokens.

#### KV Cache effect

Generation appends to session history, preserving reusable unchanged prefixes according to provider behavior. Publishing and settings send no model request.

## Known Limitations and Deferred Work

Native publication requires the current desktop broker and a Worker supporting upload Keys. [Loader acceptance](../../../apps/web/tests/worker-publication.e2e.ts) uses `DSH_WORKER_SIDEBAR_PACKAGE`; [native acceptance](../../../apps/desktop/publisher-ui.acceptance.mjs) exercises the actual EXE and isolated Worker HTTP/assets. SQL acceptance separately verifies database storage and migration. Synthetic fixtures do not establish real model quality or microphone acceptance. The [authorization decision](../../../.agents/notes/implemented/feature/2026-10-16-worker-publisher-keys.md) records credential scope and rollback constraints.
