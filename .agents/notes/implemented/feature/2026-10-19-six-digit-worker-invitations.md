# Agent Note: Six-digit Worker invitations

Status: implemented

English | [中文](2026-10-19-six-digit-worker-invitations.zh.md)

## Problem

Long invitations are cumbersome to transcribe. Shortening them must preserve Worker authority, existing access and separate administrator, publishing and session credentials.

## Decision

The Worker samples uniformly from 000000 through 999999 with `crypto/rand.Int` and formats a six-character string, retaining leading zeros. Entropy failures return an error without a fallback. Explicit rotation rejects a draw equal to the previous code so the old invitation becomes invalid even when the numeric space permits collisions. Codes are scoped to their publication, not globally unique.

The [Worker-owned invitation decision](2026-10-15-worker-owned-invitations.md) retains authority over creation, immutable publication bindings, stable retries, revision-checked administration and legacy compatibility. This note supersedes only its high-entropy format choice; that authority decision remains active. Existing stored and publication codes remain exact strings, including long codes; reads and retries never shorten or reset them. No database migration, desktop change, API Key shortening or participant-cookie change is required.

## Attempt limits

`POST /portal/api/session` consumes the existing `portal.login_limit` budget within `portal.login_window` before parsing or checking an invitation. All packages and client addresses share one fixed-window counter per mounted Worker process; valid and invalid attempts both count. Exhaustion returns 429 / `LOGIN_RATE_LIMIT`, including for a correct code. A restart or another process has an independent counter. The example configuration permits 20 attempts per minute; it is not evidence of the deployed setting.

One million possibilities makes persistent online guessing material. At 20 guesses per minute, a targeted code has a 2.88 percent success probability over one day of distinct guesses. The current counter limits aggregate single-process traffic but provides no durable failure budget, shared multi-instance state, per-package backoff or code expiry; it can also block unrelated legitimate entrants. It does not establish adequate long-term protection for a six-digit secret. Additional lockout, expiry or step-up behavior changes access semantics and is a separate operator decision; this change neither adds them nor relaxes the existing limit.

## Alternatives considered

**Retaining the long random code** preserves a much larger guessing space but does not meet the requested transcription format. **Client generation or time-derived digits** would weaken Worker ownership or unpredictability. **Reducing random bytes modulo one million** introduces bias without rejection sampling. **Automatically rotating saved codes or accepting numeric JSON** would invalidate existing invitations or discard leading zeros. **Silently adding lockout or expiry** would change participant access and recovery behavior beyond the format request.

## Consequences

Only new access creation and explicit rotation use six digits. A Worker binary update activates that behavior; existing desktop and SPA string handling remains compatible. Existing long codes continue working until an administrator explicitly rotates or revokes them, and active participant sessions remain separate. No production deployment or credential reset is implied by the source implementation.

Focused tests cover secure generation, leading zeros, range rejection, entropy failure, collision rejection on rotation, exact checks for old and new codes, HTTP entry and the existing shared failure limit. HTTP tests use isolated files and an in-memory backend, without production data or model calls. Shared persistent guessing protection remains a named gap, not an accepted production-security claim.
