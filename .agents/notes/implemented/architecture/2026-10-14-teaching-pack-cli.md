# Agent Note: Teaching-pack generation and local import

Status: implemented

English | [中文](2026-10-14-teaching-pack-cli.zh.md)

## Problem

Question-pack generation and export depend on browser component state, preventing an automation client from producing the same validated publication when browser control is unavailable. Copying credentials or constructing replacement questions would lose the actual DSH generation provenance.

## Decision

The repository CLI uses the existing loopback Host session API with a new conversation, checks its already-selected DeepSeek route, and leaves model defaults and credential storage with the Host. The workbench and CLI share question parsing, validation, metadata construction and publication export. The CLI supplies an explicit methodology template and references rather than reading browser localStorage. Actual session identifiers and original model responses are retained separately from keyless test fixtures.

The Worker local import command uses OS publication-directory permissions and the existing parser, runnable-snapshot validation and atomic no-replace publisher. Dry-run validates without creating files, identical imports are idempotent, and conflicts fail. The command neither creates HTTP administrator sessions nor loads database/provider configuration; a separate tool binary does not require a service restart.

The Node CLI is checked by the Client aggregate because its shared question-pack modules belong to the Client project; it remains a Node entry point. Its transport subprocess tests stay in the Host aggregate. The dedicated CLI check is available through its own TypeScript configuration.

## Alternatives considered

**Owned-process SDK:** the official SDK launches its own runtime rather than attaching to the configured Web Host. Reusing the existing Host avoids copying credentials or competing over its home state.

**Browser automation:** unavailable browser-control infrastructure is not a dependable command interface; this workflow explicitly does not claim UI acceptance.

**Direct filesystem copying or a new HTTP import route:** copying bypasses shared validation and conflict checks, while another network route adds authentication policy. The local command reuses publication enforcement with existing SSH/OS authorization.

## Consequences

CLI output is a real DSH-generated draft with inspectable model provenance, not a browser-workbench record. Browser-only customizations require explicit task inputs. Model failures and invalid packs stop publication. Invitation-bearing output stays private and is excluded from ordinary console output. Dedicated transport-entry, parser, publication and local-import tests cover the new interfaces; real provider generation remains a separate execution check.
