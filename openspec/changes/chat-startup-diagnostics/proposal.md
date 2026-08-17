## Why

When OpenCode fails to start, Chat reports a single string — `OpenCode did not become ready. OpenCode health check timed out after 10000ms.` — that is identical for at least five unrelated root causes and carries no evidence about any of them. A WSL2 user running the hub with Homebrew OpenCode hit this, and eliminating the obvious causes (wrong binary, version skew, auth scheme, config shadowing, port override) took a live investigation against a real OpenCode 1.18.18 rather than anything in the report. Every one of those hypotheses died to evidence the workspace process already had in hand and threw away.

The startup path also discards OpenCode's own readiness signal, budgets "did it bind" and "does it answer" together under one hardcoded 10s timeout, offers no way to widen that timeout without a release, and caches the failure for the process lifetime so a user who fixes their environment must restart the workspace.

## What Changes

- **Classify probe outcomes instead of swallowing them.** A refused connection, an accepted-but-unanswered connection, an HTTP status, and an unhealthy body are four different bugs that currently produce one string. Distinguish them, and attribute the failure from what was actually observed at the protocol level — not from any text OpenCode prints, whose format is a property of the user's independently-installed binary rather than of the pinned SDK.
- **Split the single startup budget in two.** A generous budget until OpenCode first answers at all, then a short one to become healthy. A server that binds instantly and then answers 401 forever fails in seconds instead of occupying the whole window, and each phase fails with its own distinguishable reason.
- **Capture the child's stdout.** Currently `"ignore"`, discarding OpenCode's own account of what it did. Keep it as evidence in the failure report — read by humans, never parsed by control flow.
- **Make the startup budget overridable without a release.** A `UATU_OPENCODE_STARTUP_TIMEOUT_MS` environment variable, so an operator can test a slow-start hypothesis on the build they already run. Environment rather than a CLI flag because the hub builds its session children's argv itself, so a flag cannot reach a hub-hosted workspace.
- **Make the unavailable state carry its own evidence.** Report the resolved executable and the other PATH candidates that were passed over, the OpenCode version, the endpoint actually observed, elapsed time and probe count, the last probe's concrete outcome (connection refused / HTTP status / malformed body), and bounded stdout and stderr tails — with the ephemeral server password never appearing in any of it.
- **Make the failure retriable in place.** `startup-failed` is cached for the workspace process lifetime today. Add an explicit user-initiated retry that clears it, so a user who corrects their environment recovers without restarting the workspace.
- **Raise the default startup budget.** The change's own real-OpenCode integration test already runs at 20s; production ships 10s. The costs are asymmetric — too long means Chat takes a moment to appear, too short means Chat is permanently broken and unexplainable.

Explicitly out of scope: a general uatu logging facility (`--log` / verbosity levels). That is cross-cutting, must answer to the security posture for the ephemeral password and hub session tokens, and is worthless until the hub stops swallowing session-child stderr. It belongs in its own change and must not gate this one.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: The requirement *Chat uses the workspace's OpenCode installation and identity* currently says only that an unavailable Chat "SHALL report an actionable unavailable state." This change specifies what actionable means — a two-phase readiness contract with distinguishable failure reasons, a required diagnostic payload with a secret-redaction constraint, an overridable startup budget, and a user-initiated retry that clears a cached startup failure.

## Impact

**Code**
- `src/chat/opencode-service.ts` — the whole startup path: stdout capture, two-phase readiness, per-probe timeouts, diagnostic assembly, retry entry point. `waitUntilReady` currently swallows every non-exit probe error, and `AbortSignal.timeout(remaining)` hands each probe the entire remaining budget, so a socket that accepts but never answers yields exactly one attempt.
- `src/chat/types.ts`, `src/chat/validation.ts` — `ChatAvailability` gains an optional diagnostics payload; its validator must accept and constrain it.
- `src/chat/service.ts` — `LazyOpenCodeChatService.status()` returns the cached unavailable state early; the retry path must invalidate it.
- `src/chat/ui.ts` — surface the diagnostics and the retry control in the unavailable state.
- `src/server/routes.ts` — `/api/chat/status` response gains the diagnostics field; the retry needs an endpoint.

**Published API contract**
- `api/openapi.yaml` (`ChatAvailability` schema, plus a new retry operation), `api/contract.json`, `api/operations.yaml`, and `api/route-coverage.test.ts`. Both changes are additive, so under `api/CONVENTIONS.md` no revision increment or changelog migration section is required — but the contract artifacts and the `contract-fast` gate must still be updated in step.

**Release notes**
- Chat shipped in `8410b08` and `#258`, which are in no `v*` tag; the latest stable is `v0.5.1`. Per the release-note discipline in `CLAUDE.md`, this correction stabilizes unreleased work, so the PR keeps its truthful `fix(...)` title but its body must carry a `BEGIN_COMMIT_OVERRIDE` / `END_COMMIT_OVERRIDE` block rewriting it to `chore(chat): ...` before squash merge.

**Not affected**
- No dependency changes; `@opencode-ai/sdk` stays pinned at `1.18.18`. No change to the OpenCode server-password scheme, which was verified correct against a real 1.18.18 (`Basic opencode:<pw>` → 200; unauthenticated → 401).
