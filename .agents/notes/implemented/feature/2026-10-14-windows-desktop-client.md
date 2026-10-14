# Agent Note: Windows desktop client with the expert interview workbench

Status: implemented

English | [中文](2026-10-14-windows-desktop-client.zh.md)

## Problem

The expert interview workbench needs a distributable Windows application containing its actual plugin dependencies and a private profile. A browser shortcut depends on an independently running development server. The Python SDK executable builder ships an automation agent and excludes Windows.

## Decision

Use a minimal Electron main process over the normal built DSH CLI/Web bundles. Ship a separate official Node runtime for the backend so native addons use their supported Node ABI. The production closure declares the teaching plugin and real patched better-sidebar provider. A writable portable data directory owns the Electron profile, DSH home and working directory. It never adopts existing DSH homes or ambient provider credentials. The first loopback port is retained to preserve origin-scoped browser data; an occupied saved port fails startup.

Keep renderer Node integration disabled, context isolation and Chromium sandbox enabled, and navigation confined to each window's origin. A Worker publication popup is allowed only for the existing admin path, loopback opener origin and random nonce. Native browser popup creation retains `window.opener`, source identity and cross-origin postMessage semantics. No preload exposes host APIs. Microphone permission requires a native prompt. Closing the application requests backend shutdown over private IPC, waits for exit and bounds fallback process-tree termination to its owned child. Parent disconnect also initiates backend cleanup.

Package pinned official runtimes after SHA256 verification and install dependencies through a frozen pnpm production install in a publication-only workspace mirror, then materialize the shared workspace graph. Payload checks reject links and private configuration; the archive carries a per-file manifest and upstream licenses. Packaging is separate from the ordinary library build and does not change an already running client.

## Alternatives considered

**Browser app mode** depends on the user's browser installation and does not provide a self-contained desktop runtime. **The SDK executable** has a different protocol and supported-platform scope. **Electron's Node runtime for the backend** requires rebuilding native dependencies for its ABI. **A new desktop API bridge** duplicates existing model, profile and publication mechanisms while adding privileges.

## Consequences

The portable archive is larger because it contains both Chromium and a supported Node runtime. It is unsigned and has no automatic updater; operators distribute complete updates and verify hashes. Per-user configuration and credentials are initialized by the user through existing DSH settings. A loopback provider fixture proves transport/credential routing without real model calls; actual provider quality, microphone hardware and native IME remain separate acceptance. Desktop acceptance uses the real packaged executable and synthetic isolated Worker publications, with no production account impersonation or publication writes.
