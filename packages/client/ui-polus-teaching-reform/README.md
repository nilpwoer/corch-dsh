# Teaching reform interview workbench

English | [中文](README.zh.md)

The client plugin prepares expert profiles and versioned question packages, then publishes a confirmed package to an explicitly configured Teaching Worker. Existing interview data stays in the browser; the Worker owns participant sessions, execution settings and saved reports.

The profile mounts this package's [bundle patch](cordis.patch.yml) alongside an installed `dsh-better-sidebar` provider. The default Web bundle does not mount this workbench. The real Loader acceptance uses `dsh-better-sidebar@0.17.1` with a temporary profile and host session.

## Publish and share

In interview settings, save the Worker origin under **Worker 发布**. Public targets require HTTPS; HTTP is accepted only for loopback development. The address must contain no credentials, path, query or fragment. No target is inferred or silently configured.

Confirm the question package, enter the interview goal and explicit initial follow-up policy, then choose **发布并打开 SPA**. The Worker opens its own management window. Sign in there with an existing account, review the exact package key, expert, version and count, and explicitly confirm the upload. DSH marks the interview published only after the matching success receipt. Closing, cancelling, failed login or failed upload leaves it available for retry. Stable publication bytes make the same-version retry idempotent; changed contents require **创建新发布版本**. That action does not regenerate questions or call a model.

SPA preview contains only the invitation code and share link. The link carries the immutable package key and a code fragment. Worker removes the code from browser history, pre-fills it and waits for the participant to click enter. Anyone receiving the full link receives that invitation.

## Worker settings

Management provides global business prompts and per-package overrides for both follow-up and report stages, plus each package's follow-up scope and count. Inheritance and immutable execution semantics are described in the [Worker reference](../../../worker/README.md#management-settings-and-interview-freezing). Same-version publication never replaces those separate Worker settings. A new version starts with its own initial policy and inherits the current global business prompts.

## Model Experience

### Question-package generation

#### What the model sees

The generation action submits the [rendered interview prompt](src/client/interviewPrompt.ts) through `session.prompt` on the existing agent. It includes the saved methodology template, expert profile, supplied expert materials and loaded global references. Publishing, creating another publication version, editing Worker settings and reading saved reports make no model requests.

#### Token effect

Generation adds the rendered prompt as a queued user message. Its size depends on the template, profile and supplied materials. Publication and Worker-setting actions add no model input tokens.

#### KV Cache effect

Generation appends to existing session history; earlier unchanged request prefixes may remain reusable according to the provider. Publishing and settings changes send no request and do not affect that cache. Controlled fixtures do not establish live-provider or microphone acceptance.

## Known Limitations and Deferred Work

- Direct publication currently accepts a loopback DSH origin and requires an allowed popup plus an existing Worker management login. It adds no persistent publishing credential and does not relax Worker CORS or authentication. The [real Loader acceptance](../../../apps/web/tests/worker-publication.e2e.ts) requires `DSH_WORKER_SIDEBAR_PACKAGE` pointing to the installed sidebar package and `DSH_WORKER_PUBLISH_FIXTURE` pointing to a private disposable Worker handoff; without those inputs, its corresponding checks skip. It uses synthetic data and no model calls. Native operating-system IME, microphone and live-provider acceptance remain separate checks.
