# Agent Note: Preserve composing interview inputs

Status: implemented

English | [中文](2026-10-14-worker-ime-input.zh.md)

## Problem

The Worker bridge replaces the entire application markup on every main-answer input, destroying the focused textarea during an IME composition. Restoring selection on a replacement node does not preserve the browser's composition session. Supplement drafts also persist uncommitted preedit text.

## Decision

Main-answer edits retain the textarea and update only confirmation, progress and stale assessment elements. Both answer fields listen to composition events, defer draft commits until compositionend, and ignore the duplicate final input when its value is unchanged. Draft persistence remains synchronous for committed edits. Rendering requested during composition waits until the final input can complete; other renders restore textarea focus, selection and scroll position where applicable.

The isolated browser regression loads the actual SPA and bridge with synthetic session responses. It exercises composition events, concurrent save/render, insertion caret, ordinary typing, paste-input events, radio/checkbox choices, refresh restoration, supplement drafts and stale assessment invalidation without model requests.

## Alternatives considered

**Restore focus after each input render:** this replaces the IME-owned node before composition completes and reproduces the failure.

**Persist every preedit input or debounce all saving:** preedit is not committed text, while delayed committed saving adds a loss window on refresh. Committed input is saved immediately without rebuilding the answer field.

**Replace the production Worker for a static fix:** the portal caches bridge bytes at startup. A narrowly scoped Nginx static override can serve the tested bridge without restarting the Worker; its retirement procedure must accompany the deployment to prevent hiding future release assets.

## Consequences

The browser keeps composition ownership and the original draft format. Headless event simulation verifies DOM behavior, not Windows native input-method integration. Production hotfixes require resource/config backups, an exact single-script location, MIME and no-store headers, Nginx validation before reload, and public-byte verification. The [operations procedure](../../../../docs/worker-ime-hotfix.md) records rollback and release-upgrade cleanup.
