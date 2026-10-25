# Agent Note: Worker publication and frozen execution settings

Status: implemented

English | [中文](2026-10-14-worker-direct-publish-settings.zh.md)

## Problem

The workbench previously marked a package published without a Worker upload. Operators also needed visible per-package follow-up controls and editable business prompts while active interviews retained the models, prompts and budgets under which they started.

## Decision

Use an explicit Worker origin and an owned popup. The legacy bridge authorizes one upload through the Worker management session and binds window, origin and nonce; native desktop publication uses the upload-only Key broker. No administrator credential or backend token is transferred to DSH. The [input-policy decision](2026-10-16-traceable-interview-inputs.md) owns default policy and direct participant entry.

Publish stable JSON bytes to the immutable package endpoint. Only its matching receipt marks DSH published. Cancellation and failure release the operation; retries preserve identical bytes. Another version is explicit and requires no model call. Invitation credentials stay in the fragment and are consumed before direct entry.

Store versioned settings separately from uploaded packages. Resolve YAML business prompts through global defaults and package overrides; package policy overrides the publication's initial policy. At participant entry, persist an immutable execution snapshot containing both releases, public model/provider configuration, queue budgets and resolved policy. Credentials remain in startup configuration. Backend-only interviews freeze on first submission. Future tasks and report versions use the snapshot. Editable prompts cannot alter Go schema or citation validators.

DSH keeps no package policy form: question-package actions own publication, JSON download and new versions. New publications carry the current default input policy. Titles supply new goals; existing saved goals and original-version policy remain available for byte-stable retries. The input-policy decision partially supersedes the former explicit-policy prerequisite; settings storage and interview freezing remain owned here.


## Alternatives considered

Embedding a backend token or administrator password in the client would grant excess authority. Allowing arbitrary browser origins with ambient management sessions would expose publication to untrusted sites. Rewriting immutable package JSON for settings would break retry identity and history. Resolving current prompts at every task would change interviews midway.

## Consequences

Schema version 3 adds settings and interview-runtime tables without rewriting history. Legacy interviews keep retained follow-up and earliest report releases; where no report release was ever recorded, first resume captures the service's startup baseline, never new management overrides. Unrecorded historical model settings cannot be reconstructed. Schema-2 binaries reject schema 3; the [Worker reference](../../../../worker/README.md#schema-migration-and-rollback) owns deployment and rollback requirements.

Real isolated MySQL and browser acceptance use disposable databases, controlled provider endpoints and synthetic packages. They cover authorization, retries, global/package inheritance, process restart, frozen execution and saved PDF downloads. DOM composition coverage does not claim native IME, microphone or live-provider acceptance.

The [full Web Loader acceptance](../../../../apps/web/tests/worker-publication.e2e.ts) mounts the real interview plugin and installed sidebar provider in a temporary profile. Its actual browser buttons create a host session and publish through the disposable Worker, then verify the receipt, share-page snapshot, invitation prefill and explicit participant entry. Component-only fixtures do not substitute for this assembled path. The test requires explicit installed-package and private Worker-handoff inputs and skips the corresponding checks when they are absent.

Native desktop acceptance launches the packaged executable with an isolated profile and the real Worker HTTP handlers/assets. Synthetic account and SQL storage isolate authenticated single-click publication, login continuation, missing-address feedback, blocked popups, old-protocol rejection and network errors without production credentials or model calls. It also pins legacy publication bytes, Worker-owned settings, invitation copying and explicit participant entry. This does not replace MySQL integration or real model/microphone acceptance.
