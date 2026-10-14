# Agent Note: Worker publication and frozen execution settings

Status: implemented

English | [中文](2026-10-14-worker-direct-publish-settings.zh.md)

## Problem

The workbench previously marked a package published without a Worker upload. Operators also needed visible per-package follow-up controls and editable business prompts while active interviews retained the models, prompts and budgets under which they started.

## Decision

Use an explicit Worker origin and an owned popup on that origin. The existing Worker management account authorizes each upload after a visible package confirmation. Both sides bind messages to the exact source window, origin and random nonce; success additionally binds the package key. The Worker accepts only loopback DSH sources, clears bridge fragments and refuses framing. No administrator password, session or backend token is transferred to DSH or a shared link.

Publish stable JSON bytes to the existing immutable package endpoint. Only its matching receipt marks DSH published. Cancellation and failure release the operation; retries preserve identical bytes. Another version is explicit and requires no model call. Share preview has two sections; the participant invitation stays in the URL fragment and pre-fills without entering automatically.

Store versioned settings separately from uploaded packages. Resolve YAML business prompts through global defaults and package overrides; package policy overrides the publication's initial policy. At participant entry, persist an immutable execution snapshot containing both releases, public model/provider configuration, queue budgets and resolved policy. Credentials remain in startup configuration. Backend-only interviews freeze on first submission. Future tasks and report versions use the snapshot. Editable prompts cannot alter Go schema or citation validators.

## Alternatives considered

Embedding a backend token or administrator password in the client would grant excess authority. Allowing arbitrary browser origins with ambient management sessions would expose publication to untrusted sites. Rewriting immutable package JSON for settings would break retry identity and history. Resolving current prompts at every task would change interviews midway.

## Consequences

Schema version 3 adds settings and interview-runtime tables without rewriting history. Legacy interviews keep retained follow-up and earliest report releases; where no report release was ever recorded, first resume captures the service's startup baseline, never new management overrides. Unrecorded historical model settings cannot be reconstructed. Schema-2 binaries reject schema 3; the [Worker reference](../../../../worker/README.md#schema-migration-and-rollback) owns deployment and rollback requirements.

Real isolated MySQL and browser acceptance use disposable databases, controlled provider endpoints and synthetic packages. They cover authorization, explicit confirmation, retries, global/package inheritance, process restart, frozen execution and saved PDF downloads. DOM composition coverage does not claim native IME, microphone or live-provider acceptance.
