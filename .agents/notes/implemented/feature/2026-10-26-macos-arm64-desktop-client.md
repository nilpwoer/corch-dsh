# Agent Note: macOS ARM64 desktop client

Status: implemented

English | [中文](2026-10-26-macos-arm64-desktop-client.zh.md)

## Problem

The Windows desktop archive cannot run on Apple silicon. A macOS package must include ARM64 Electron, Node, and native dependencies without placing writable profile data inside the application bundle.

## Decision

`package:mac` assembles a `Corch DSH.app` from pinned Electron 44.7.2 and Node 24.18.0 ARM64 archives. Its frozen workspace install resolves and rebuilds native dependencies for `darwin/arm64`, including when the packaging host is Intel macOS. The package inventory permits only Electron framework symlinks that resolve within the application bundle and records every regular payload file. Default packaging applies an ad-hoc signature for internal distribution. Supplying both a Developer ID Application certificate name and a `notarytool` keychain profile enables hardened-runtime signing, notarization, ticket stapling, and Gatekeeper assessment.

Desktop module resolution and package containment checks compare canonical filesystem paths, so macOS `/var` and `/private/var` aliases cannot cause a profile import or a packaged file to be misclassified.

The packaged main process runs the embedded `node/bin/node`. Its default data directory is `~/Library/Application Support/Corch DSH`; an absolute `--data-dir` overrides it. The backend has its own POSIX process group, so timed shutdown cleanup can terminate only the desktop-owned group and await its exit.

## Alternatives considered

**Rosetta-only Intel application** does not provide a native Apple-silicon client or ARM64 native addons. **A macOS wrapper around the Windows portable layout** writes beside the bundle and conflicts with normal macOS application permissions. **Electron's embedded Node runtime** would require native addons to match Electron's ABI instead of the supported Node runtime.

## Consequences

Distribution remains a complete ZIP with a published SHA256, not an updater. Internal users can need Finder approval on first launch and can receive a Keychain access prompt after an ad-hoc-signed update. macOS acceptance must launch the packaged ARM64 executable with an isolated data directory, verify Keychain-backed publication credentials, and verify the backend exits with the application.
