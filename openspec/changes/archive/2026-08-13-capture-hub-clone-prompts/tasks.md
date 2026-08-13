## 1. Clone Process Primitive

- [x] 1.1 Add a hub clone process adapter that spawns `git clone` in a dedicated Bun PTY and separate process group, incrementally emits normalized plain-text output, accepts line input, and disposes terminal resources on exit.
- [x] 1.2 Build the clone environment and Git arguments to remove Git/SSH askpass, set terminal prompting, clear Git credential helpers for the invocation, and preserve `SSH_AUTH_SOCK`; add unit coverage for the exact environment/argument policy without exposing environment secret values.
- [x] 1.3 Implement process-group SIGTERM-to-SIGKILL escalation and add a POSIX integration fixture proving cancellation reaps both the Git-shaped leader and a blocking descendant.

## 2. Clone Job Lifecycle

- [x] 2.1 Add an in-memory clone-job manager with random owner-scoped ids, normalized target reservations, phase/result events, bounded replay history, subscriber cleanup, and terminal-job expiry.
- [x] 2.2 Implement the clone-to-register-to-session-start state machine, including no registration before clone success, registration rollback on start failure, target release on every outcome, and preservation of successfully cloned files after start failure.
- [x] 2.3 Add bounded input handling that writes one response plus line ending only to an active job PTY, resets inactivity, rejects oversized/terminal-state input, and never stores or emits the submitted value.
- [x] 2.4 Add configurable inactivity and hard-lifetime timers plus idempotent cancellation, ensuring every timeout/cancel/failure path awaits process-group cleanup and releases job resources.
- [x] 2.5 Unit-test job ownership, replay after reconnect, output truncation, target collision, secret non-retention, all terminal states, timeout behavior, and cleanup/expiry using injected process and timer seams.

## 3. Hub API And Shutdown

- [x] 3.1 Replace the blocking clone route with non-blocking clone-job creation and add owner-gated SSE events plus POST input/cancel routes under the existing authentication and CSRF policy; return indistinguishable not-found responses for unknown and non-owned jobs.
- [x] 3.2 Wire the clone-job manager through hub assembly and graceful shutdown so shutdown closes creation, cancels and awaits active clone jobs, then stops workspace sessions and the server.
- [x] 3.3 Add hub integration tests for `202` creation, SSE event ids/replay and terminal result, input delivery, idempotent cancellation, cross-user denial, cookie CSRF rejection, bearer access, and registration/start behavior.
- [x] 3.4 Add shutdown integration coverage proving an active clone and descendant process are gone before hub exit.

## 4. Dashboard Clone Experience

- [x] 4.1 Rework the Add Folder clone form into an inline clone panel with phase label, bounded plain-text progress log, always-available masked response form, and cancel control, preserving the existing browsed destination behavior and uatu visual language on desktop and mobile.
- [x] 4.2 Update dashboard client logic to create a job, consume and reconnect the SSE stream, append output with `textContent`, clear responses immediately on submission, and keep clone controls busy without interval refresh replacing them.
- [x] 4.3 Add optional rolling-text prompt classification for common passphrase, username/password, host-trust, and verification prompts that labels/focuses the response input without gating unrecognized prompt input.
- [x] 4.4 Handle cancelled, timed-out, clone-failed, start-failed, and successful results distinctly; on success refresh the browser state and use the existing opening overlay to navigate to the workspace session.

## 5. Verification And Documentation

- [x] 5.1 Add an end-to-end interactive fixture that emits a passphrase-shaped and an unrecognized PTY prompt, verify masked dashboard responses complete the job, and assert submitted values never appear in streamed output or retained replay.
- [x] 5.2 Verify a clone can use an injected already-loaded SSH agent while askpass and Git credential helpers remain disabled, and document that independent external-agent UI is outside the hub's prompt-routing guarantee.
- [x] 5.3 Run focused hub/Git tests, `bun test`, `bun run typecheck`, and `bun run build`; resolve regressions without weakening timeout, ownership, or secret-handling assertions.

## 6. Dogfooding Corrections

- [x] 6.1 Hide prompt input and cancellation after every terminal clone result, visibly distinguish disabled controls, clear residual input state, and leave failure output available while restoring the clone form for retry.
- [x] 6.2 Add an optional checkout folder name, default it from the remote when blank, and reject path-like overrides before creating a clone job.
- [x] 6.3 Clear PTY terminal echo before every submitted response and add a real-PTY regression test proving a secret cannot enter captured output or replay through terminal echo.
