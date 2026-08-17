## 1. Operator-overridable budget (independently shippable — land first)

- [x] 1.1 Read `UATU_OPENCODE_STARTUP_TIMEOUT_MS` where the chat service is constructed in `src/cli.ts`, mapping it to the existing `startupTimeoutMs` option; treat empty, non-numeric, and non-positive values as absent
- [x] 1.2 Raise the default total startup budget from 10s to 30s in `src/chat/opencode-service.ts`
- [x] 1.3 Add tests in `src/chat/opencode-service.test.ts` covering override honored, invalid values falling back to the default, and the workspace still starting when the value is garbage
- [x] 1.4 Add an e2e or integration assertion that a hub-spawned session inherits the override from the hub process environment
- [x] 1.5 Document the variable in `ARCHITECTURE.md` alongside the existing `UATU_DEBUG` / `UATU_HEARTBEAT_TIMEOUT_MS` knobs

## 2. Two-phase readiness

- [x] 2.1 Change the spawn in `src/chat/opencode-service.ts` from `stdout: "ignore"` to a piped, bounded capture reusing the existing `BoundedTextCapture` — for diagnostics only, never as input to readiness
- [x] 2.2 Add a probe-outcome classifier over the existing `/global/health` call: refused (Bun `ConnectionRefused`), abandoned (`TimeoutError`), HTTP status (with code), unhealthy/malformed body, and unknown (recording the raw error rather than defaulting to refused)
- [x] 2.3 Replace `waitUntilReady`'s flat loop with budget switching at the first HTTP response: generous bind budget until then, fixed 5s health slice after
- [x] 2.4 Give each health probe a fixed 2s timeout instead of `AbortSignal.timeout(remaining)`
- [x] 2.5 Produce phase-attributed failure messages from the observed outcomes: never-answered vs answered-but-unhealthy, naming the endpoint and last status in the latter
- [x] 2.6 Tests: all-refused → bind-phase message; answers-then-401 → health-phase message within the short slice, not the full budget; accepted-but-unanswered connection yields multiple probes rather than one; unrecognized error classifies as unknown; readiness succeeds when stdout is silent or unrecognizable

## 3. Failure diagnostics

- [x] 3.1 Add an optional structured diagnostics field to `ChatAvailability` in `src/chat/types.ts` (resolved executable, passed-over candidates, version, probed endpoint, elapsed ms, probe count, last probe outcome, stdout tail, stderr tail)
- [x] 3.2 Carry the classified last probe outcome from task 2.2 into the payload, preserving its distinctions rather than flattening it to a string
- [x] 3.3 Accept and constrain the new field in `src/chat/validation.ts`
- [x] 3.4 Assemble the payload on the failure path only, leaving the success path's cost unchanged
- [x] 3.5 Probe `opencode --version` with a short bounded timeout on the failure path only; record "could not be determined" on expiry without masking the original error
- [x] 3.6 Scrub the generated password's literal value from both captures before storage, as defense in depth on top of never placing it in a field
- [x] 3.7 Test that no field or capture of a failed availability contains the password, including a capture deliberately seeded with it
- [x] 3.8 Test that captures stay bounded when OpenCode writes more than the limit before failing

## 4. Executable discovery reporting

- [x] 4.1 Extend `src/chat/executable.ts` to collect every match on the search path (`which -a` semantics) while still selecting the first
- [x] 4.2 Carry the chosen path and the passed-over candidates into the diagnostics
- [x] 4.3 Test that a shadowed second `opencode` on the path is reported and that selection order is unchanged

## 5. Retry

- [x] 5.1 Add a retry entry point on `OpenCodeService` that clears the cached unavailable state and re-enters `start()`, reusing the existing `startPromise` join so concurrent retries do not spawn a second process
- [x] 5.2 Clear the cached availability in `LazyOpenCodeChatService` (`src/chat/service.ts`) so `status()` stops short-circuiting after a retry
- [x] 5.3 Add `POST /api/chat/retry` to `src/server/routes.ts`
- [x] 5.4 Test that a retry after a failure re-attempts startup, that a second failure reports fresh diagnostics rather than the previous attempt's, and that concurrent retries join

## 6. API contract

- [x] 6.1 Add the diagnostics field to the `ChatAvailability` schema in `api/openapi.yaml`
- [x] 6.2 Add the retry operation to `api/openapi.yaml` and `api/operations.yaml`
- [x] 6.3 Regenerate/update `api/contract.json` and extend `api/route-coverage.test.ts` for the new route
- [x] 6.4 Increment `workspaceApiRevision` 1 → 2 (`src/shared/version.ts`, `api/contract.json`, `api/openapi.yaml`) and add an `api/CHANGELOG.md` migration section naming the workspace domain — the closed-object rule makes the new `diagnostics` property breaking; run `bun run api:validate`, `bun run test:api`, and the `contract-fast` compatibility gate

## 7. Chat surface

- [x] 7.1 Render the diagnostics in the unavailable state in `src/chat/ui.ts`, in a form a user can copy into a bug report
- [x] 7.2 Offer a retry control when unavailable, wired to `POST /api/chat/retry`
- [x] 7.3 For `not-installed`, lead with the install instruction and present retry only as a secondary action
- [x] 7.4 Add an e2e assertion in `tests/e2e/` that a failed chat startup surfaces diagnostics and a working retry control

## 8. Verification and release

- [x] 8.1 Run `bun test`, `bun run typecheck`, and `bun run check:licenses`
- [x] 8.2 Run the real-OpenCode integration test (`UATU_REAL_OPENCODE=1`) and reconcile its `startupTimeoutMs: 20_000` override with the new 30s default — the override may now be redundant
- [x] 8.3 Run `bun test:e2e`
- [x] 8.4 Show the unavailable-state UI before relying on the suite — a green run says nothing about whether the diagnostics are readable

> **Release note (not a task).** This stabilizes chat work that is in no `v*`
> tag (latest stable is `v0.5.1`), so the PR body must carry a
> `BEGIN_COMMIT_OVERRIDE` / `END_COMMIT_OVERRIDE` block rewriting the title to
> `chore(chat): ...` before squash merge. It lives in the PR, not in the
> working tree, so it cannot be a checkbox here.
