## Context

See `proposal.md` — Why. The constraints that shape the approach:

- `OpenCodeService.start()` (`src/chat/opencode-service.ts`) spawns with `stdout: "ignore"`, so OpenCode's `opencode server listening on <url>` line is discarded. `waitUntilReady` polls `/global/health` on the *requested* port and swallows every non-exit error, so connection-refused, 404, 401, and an unhealthy body are indistinguishable.
- `AbortSignal.timeout(remaining)` gives each probe the entire remaining budget. A socket that accepts but never answers yields exactly one attempt in the whole window.
- `bindAttempts` retries only when the diagnostic matches `isBindFailure()`. A timeout never matches, so today's timeout path retries zero times.
- `LazyOpenCodeChatService.status()` returns a cached `unavailable` immediately (`src/chat/service.ts`), so a startup failure is permanent for the workspace process.
- The hub builds its session children's argv itself (`src/hub/backend.ts`), so no new `uatu serve` flag can reach a hub-hosted workspace. Environment inherits.
- `/api/chat/status` is a published contract (`api/openapi.yaml`, `api/contract.json`) with a `contract-fast` gate.

Verified against a real OpenCode `1.18.18` during exploration, and treated as fixed ground here: the `Basic opencode:<password>` scheme is correct (200; unauthenticated → 401, so the password env var is honored); `server.password` is not a config field, so config cannot shadow the generated credential; and `--port` beats a config `server.port`. None of those are causes, and none of them change.

## Goals / Non-Goals

**Goals:**

- Never again emit a startup failure that cannot be attributed to a phase and a concrete last-probe outcome.
- Keep the happy path's cost unchanged — diagnostics work must be paid on the failure path only.
- Depend on no unversioned property of the user's OpenCode binary — in particular, no output format.

**Non-Goals:**

- Any general logging facility. See `proposal.md` — What Changes.
- Automatic or background retry. Retry is user-initiated by design (see the spec requirement).
- Changing how UatuCode authenticates to OpenCode, or the pinned SDK version.
- Making Chat startup *fast*. This change makes a slow start survivable and legible, not quicker.

## Decisions

### 1. Phase attribution comes from probe outcomes, not from parsed text

Classify every probe outcome and attribute the failure from what was observed, with no parsing of OpenCode's output. The three outcomes are cleanly distinguishable in Bun and were verified against a live server:

```
closed port          → Error         code "ConnectionRefused"
accepted, no answer  → TimeoutError  code 23
bound and answering  → HTTP status (200 / 401 / 404 / …)
```

Which yields the attribution directly: if no probe ever got an HTTP response, OpenCode never bound; if any probe did, OpenCode bound and the health check is what failed — reported with the status code it returned.

Stdout is still captured (bounded, exactly as stderr already is) and still lands in the diagnostics, but as **evidence a human reads**, never as input to control flow. If OpenCode's output format changes, the diagnostics get marginally less readable and nothing breaks.

This is the correction that matters most in this design, because the obvious alternative looks safer than it is. `@opencode-ai/sdk`'s own `createOpencodeServer` waits for `opencode server listening on <url>` on stdout, which makes copying that regex look like "following the SDK". It is not. The pin in `package.json` governs *our client*; the stdout format is a property of *the user's binary*, which Homebrew or npm installed on its own cadence. Bumping the SDK pin would say nothing about it and no compile-time signal would ever fire. Probe outcomes are a property of the protocol instead, so they cannot drift out from under us.

Alternatives considered:
- **Use the SDK's `createOpencodeServer` instead of spawning ourselves.** The right instinct, but it cannot carry uatu's requirements: it exposes no `env` option (so the ephemeral password could only be injected via uatu's own `process.env` — which `src/terminal/server.ts:162` spreads into the pty, putting the password in users' interactive shells), no `cwd`, no process-group termination, and no bind-race retry, and it discards its captured output on success.
- **Parse the stdout listening line, with port polling as fallback.** Rejected per the above: unversioned coupling with no signal when it breaks. The auto-correction it would buy — connecting to a port other than the one requested — was justified by a hypothesis that exploration then disproved, since `--port` was verified to beat a config `server.port`.
- **Keep polling blind, just report more.** Cheaper, but leaves "never bound" and "bound but unhealthy" indistinguishable, which is the specific defect this change exists to remove.

### 2. One operator-facing budget, split internally

Externally there is one knob, `UATU_OPENCODE_STARTUP_TIMEOUT_MS`, because an operator debugging a slow start should not have to reason about two numbers. Internally it splits at the moment of the first HTTP response — the protocol-level fact that OpenCode has bound (Decision 1). Before that, the generous bind budget applies; from that moment a fixed short health slice (5s) applies. Default total 30s, so the default bind budget is 25s.

Splitting at the first HTTP response rather than at a parsed listening line preserves the point of having two budgets — a server that binds instantly and then answers 401 forever must fail in 5s, not 30 — without reintroducing any text coupling.

30s over today's 10s because the failure costs are asymmetric — too long means Chat takes a moment to appear behind an already-existing `starting` state, too short means Chat is permanently broken and unexplainable. The change's own real-OpenCode integration test already runs at 20s, which is direct evidence that 10s is under-provisioned for a real cold start.

Each individual health probe gets a fixed 2s timeout instead of `remaining`, so an accepted-but-unanswered connection costs one probe rather than the whole window.

Invalid override values fall back to the default rather than failing startup: Chat is optional to a workspace, so a typo in an environment variable must not prevent documents from being served.

Alternatives considered:
- **Two environment variables.** More precise, worse ergonomics for the one job this knob exists to do.
- **A `uatu serve` flag.** Cannot reach a hub-hosted workspace, which is exactly where the reported failure occurred. Rejected on that alone. (`UATU_DEBUG` and `UATU_HEARTBEAT_TIMEOUT_MS` in `serve-cli-startup` set the precedent for env-var knobs; those pair with flags because they are also useful directly, which this one is not.)

### 3. Diagnostics are assembled only on failure, and the version is probed only then

The diagnostic payload hangs off the `unavailable` availability as an optional structured field. On the success path nothing extra is computed: the version already arrives in the health body (`{"healthy":true,"version":"1.18.18"}`).

On the failure path there is no health body, so the version is unknown at the point it is most wanted. Resolve it with a separate short-lived `opencode --version` invocation, bounded by a small timeout, executed only when startup has already failed. Its own failure is itself diagnostic ("version could not be determined") and must not mask the original error.

Alternatives considered:
- **Probe the version eagerly at spawn.** Adds a subprocess to every workspace that opens Chat, to serve a path that normally never runs.
- **Omit the version.** It is the field that eliminates a whole hypothesis class in one line; worth a subprocess on a path that has already failed.

### 4. Executable discovery reports candidates without changing which one wins

`discoverExecutable` returns on the first match. Extend it to collect every match on the search path (`which -a` semantics) while still selecting the first, and carry the also-rans into the diagnostics.

Deliberately *not* filtering or reordering candidates — the WSL2 hazard of a Windows shim shadowing a Linux binary is real, but skipping `/mnt/*` on Linux is a heuristic that would break legitimate setups and introduce a new failure mode nobody can see. Reporting the shadowing costs nothing, changes no behavior, and makes the diagnosis immediate if it ever is the cause.

### 5. Redaction is structural first, scrubbing second

The password is never placed into any diagnostic field. Because OpenCode's own output is captured verbatim and cannot be assumed never to echo its environment, captures are additionally scrubbed for the password's literal value before storage. Structure prevents the expected case; scrubbing covers the unexpected one.

The generated password is `base64url`, so its literal form is the only encoding that can appear in a capture — there is no percent-encoded or quoted variant to also match.

Other diagnostic content — executable paths, the workspace path, the loopback endpoint — is already visible to the authenticated workspace user through existing surfaces, so exposing it here grants no new authority.

### 6. Retry is an additive endpoint that joins the in-flight start

Add `POST /api/chat/retry`. `GET` is not an option: retry has side effects (it spawns a process). Reusing `GET /api/chat/status` with a query parameter would put those side effects behind a safe method.

Implementation reuses the existing `startPromise` join in `OpenCodeService.status()` — retry clears the cached `unavailable` and calls the same path, so a second concurrent retry joins the first rather than spawning a second OpenCode.

The endpoint clears any unavailable state, including `not-installed` — a user who just installed OpenCode should recover the same way. The spec's constraint is about *presentation*: the surface leads with the install instruction for `not-installed` and offers retry as a secondary action, rather than presenting retry as the remedy for a missing binary.

Both the `ChatAvailability` schema field and the new operation are additive, so under `api/CONVENTIONS.md` no revision increment or changelog migration section is required — but `api/openapi.yaml`, `api/contract.json`, `api/operations.yaml`, and `api/route-coverage.test.ts` must move together or the `contract-fast` gate fails.

## Risks / Trade-offs

- **OpenCode changes or drops the stdout listening line** → No longer a functional risk after Decision 1; stdout is evidence only, so the failure mode is a slightly less readable diagnostic rather than a broken startup.
- **Bun changes how it surfaces connection errors** → The classifier keys on Bun's `ConnectionRefused` / `TimeoutError` shapes. This is a coupling, but to a pinned dependency with a compile-time surface, unlike the binary's output. Unrecognized shapes must classify as "unknown" and record the raw error rather than being mistaken for a refusal, so a Bun change degrades attribution instead of inverting it.
- **A 30s default makes a genuinely broken setup feel like a hang** → The `starting` availability state already exists and the surface renders it; the wait is visible rather than silent. The knob exists for operators who want it shorter.
- **Diagnostics become a new place to leak secrets** → Decision 5, plus a test that asserts the password appears in no field of a failed availability, including captures seeded with it.
- **Unbounded capture growth from a looping OpenCode** → Both captures reuse the existing bounded-capture behavior already applied to stderr.
- **The version subprocess hangs on the failure path** → Bounded by its own short timeout; on expiry the field records that the version could not be determined and the original error is still reported.
- **Contract artifacts drift from the implementation** → `contract-fast` already gates this; the tasks keep the API edits adjacent to the route edits.

## Migration Plan

No data or config migration; every change is additive and default-compatible.

Sequencing matters for one item. `UATU_OPENCODE_STARTUP_TIMEOUT_MS` (Decision 2) is independently valuable and independently shippable — it is a handful of lines against an option that already exists on the constructor, and it lets an operator test the slow-start hypothesis on a build already in the field. It should land first and can ship ahead of the rest if the reported failure needs an answer before the whole change is ready.

Rollback: the env var is additive and defaults to current behavior when unset; the readiness change falls back to today's polling; the API additions are additive. Reverting any single piece leaves the others functional.

## Open Questions

- Whether the diagnostics should also be surfaced to a hub operator (the hub currently reads a session child's stderr tail only on startup failure, never after). Deferrable: it is a hub-side transport concern that belongs with the logging change, and it does not affect these specs, this approach, or the task breakdown.
