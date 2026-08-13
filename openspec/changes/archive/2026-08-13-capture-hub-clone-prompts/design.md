## Context

See `proposal.md` for motivation. Today `POST /api/hub/clone` awaits `gitClone()`, which spawns pipe-backed Git with ignored stdin and waits for all output plus `child.exited`. SSH can still open the daemon's controlling terminal, and the request has no channel for progress, input, cancellation, reconnect, or timeout. Registration and session startup happen only after that blocking call returns.

Bun already provides a POSIX PTY API, wrapped by `src/terminal/pty.ts`. Hub APIs already share one authentication gate, distinguish cookie and bearer transports, and apply same-origin checks to POST mutations. The dashboard is server-rendered HTML with a small inline client rather than the main SPA, so the clone affordance should remain compact and dependency-free.

## Goals / Non-Goals

**Goals:**

- Give each clone an isolated terminal whose output and input are mediated by the authenticated hub.
- Make clone progress reconnectable and every active job cancellable and time-bounded.
- Guarantee that Git/SSH prompt mechanisms controlled by the clone use the PTY rather than inherited terminal or askpass UI.
- Preserve already-loaded SSH agent keys while making the boundary around external agent behavior explicit.
- Keep submitted credentials ephemeral and absent from logs, events, errors, and persistent state.
- Reap Git, SSH, and descendants on every terminal path and during hub shutdown.

**Non-Goals:**

- Persisting clone jobs across hub restarts or supporting multiple hub processes sharing jobs.
- Storing, caching, or managing Git credentials or SSH keys in uatu.
- Rendering a full xterm terminal in the dashboard or supporting arbitrary cursor-oriented terminal applications.
- Guaranteeing that a retained third-party SSH agent never presents its own OS UI; the hub controls Git and SSH's direct prompt paths, not an external agent's internals.
- Changing non-network Git operations (`rev-parse`, `git init`) into jobs.

## Decisions

### D1: A hub-local clone-job manager owns the whole asynchronous workflow

Introduce an in-memory manager assembled in `src/hub/main.ts` and passed into the hub server. A job records a random id, authenticated owner name, source URL, resolved target, phase, terminal process, bounded event history, subscribers, timers, and terminal result. The manager owns the sequence:

```text
cloning -> registering -> starting -> succeeded
    |           |            |
    +-----------+------------+-> failed
    +--------------------------> cancelled / timed-out
```

The create route validates URL/destination and asks the manager to reserve the derived target before returning `202 {jobId}`. The manager clones, then registers and starts through the existing registry/session abstractions. If start fails, it removes the registration as the current endpoint does. Terminal jobs remain queryable briefly before expiry; active jobs are never persisted.

Owning the complete sequence in one lifecycle component prevents the HTTP handler from resuming registration twice after reconnect and gives shutdown one place to await all clone work. Alternative considered: keep clone in the original POST and add a duplex stream. Rejected because request abort and reconnect semantics become lifecycle semantics, and cancellation still needs a separately addressable operation.

### D2: Use a dedicated Bun PTY and process group for each clone

Spawn `git clone` directly in a dedicated PTY, with a fixed simple terminal size and a separate process group/session. The PTY joins stdin, stdout, and stderr, which matches what an interactive user would see and gives SSH a real `/dev/tty` associated with the child rather than the daemon's controlling terminal. Existing terminal PTY primitives can be reused or factored into a shared process adapter; clone jobs do not create an embedded-terminal session or xterm model.

Cancellation sends SIGTERM to the process group, waits a short grace period, then sends SIGKILL to the group and awaits the leader. Terminal close and listener disposal happen in `finally`. Group termination matters because killing only the Git leader can leave its SSH child blocked.

Alternative considered: pipes plus a writable stdin. Rejected because SSH preferentially reads `/dev/tty`, so pipe stdin does not reliably capture prompts. Alternative considered: a structured `GIT_ASKPASS`/`SSH_ASKPASS` helper. Rejected as the primary mechanism because it adds a helper IPC protocol and does not cover host-key confirmation, keyboard-interactive authentication, or arbitrary terminal prompts.

### D3: Force controlled prompts to the PTY while retaining the SSH agent

Build an explicit child environment from the daemon environment with `GIT_ASKPASS` and `SSH_ASKPASS` removed, `GIT_TERMINAL_PROMPT=1`, and `SSH_ASKPASS_REQUIRE=never`. Invoke Git with per-command configuration that clears `core.askPass` and the credential-helper list. Keep `SSH_AUTH_SOCK` unchanged so an agent can satisfy authentication from an already-loaded key.

This creates the practical guarantee:

```text
Git / OpenSSH-owned prompt -> clone PTY -> hub events -> dashboard
already-loaded key         -> retained SSH agent
agent's own UI/policy      -> outside hub control
```

The dashboard and documentation must not claim an absolute host-wide no-GUI guarantee because an agent is a separate process and may independently request confirmation, hardware-token presence, or keychain access. Alternative considered: remove `SSH_AUTH_SOCK` and platform keychain integration. Rejected because it would discard useful unlocked keys and force avoidable passphrase entry. Alternative considered: preserve Git credential helpers. Rejected because arbitrary helpers can invoke native UI, defeating deterministic prompt capture.

### D4: SSE carries replayable output; POST carries input and cancellation

Use hub-owned routes shaped as:

```text
POST /api/hub/clone-jobs
GET  /api/hub/clone-jobs/:id/events
POST /api/hub/clone-jobs/:id/input
POST /api/hub/clone-jobs/:id/cancel
```

The create response is non-blocking. SSE events have monotonically increasing ids and typed payloads for output, phase changes, and terminal results. A new subscriber receives the retained bounded history before live events; `Last-Event-ID` avoids duplicate replay when available. Input accepts one bounded string, appends the terminal line ending server-side, writes it once, and immediately drops the value. Cancel is idempotent for a terminal job.

All routes resolve the authenticated user from the existing gate. Unknown and non-owned ids return the same not-found response to avoid exposing job existence. Input/cancel use the existing POST and CSRF policy. SSE is chosen over a clone-specific WebSocket because output is one-way, browser reconnect is built in, and sensitive input remains a normal audited mutation. The existing session WebSocket bridge remains dedicated to proxied workspace terminals.

### D5: Prompt recognition is optional UX, never protocol state

The server incrementally decodes PTY bytes, strips ANSI/control sequences not meaningful in a compact text log, and emits safe text; the browser inserts it with `textContent`. A small rolling text window may classify common passphrase, username/password, host-trust, and verification prompts. Classification can update the response label and focus it, but the response control remains available for every active clone.

The job never enters a correctness-critical `awaiting-prompt` state because prompt text varies by Git/SSH version, server, locale, and authentication plugin. Any line can be answered; only the active/terminal job state gates writes. The input uses `type=password` even for non-secret responses so no response is left visible, and the browser clears it as soon as the POST is dispatched.

Alternative considered: expose input only after a recognized regex match. Rejected because an unrecognized prompt would recreate the original hang.

### D6: Bound memory, time, target concurrency, and retention

Use injectable constants/timers with production defaults of approximately 64 KiB retained text per job, ten minutes without PTY output or submitted input, one hour maximum active lifetime, and five minutes of terminal-job retention. Output beyond the cap is discarded from the oldest retained events while live subscribers continue receiving new output. The inactivity timer resets on PTY output and accepted input; phase transitions after clone are covered by the hard deadline and their existing bounded session-start behavior.

A target reservation map is acquired before spawn and released in all outcomes. Existing target validation still runs before reservation, and a second active job for the same normalized target fails before Git starts. The hub does not recursively delete a failed checkout: Git normally cleans a failed new target itself, while deleting paths in a daemon is a disproportionate risk. Any residue remains unregistered and visible to the user.

### D7: Shutdown awaits clone cleanup before stopping the server

Hub shutdown first marks the clone manager closed so no new jobs can start, cancels and awaits all active clone process groups, then stops workspace sessions and the HTTP server. Repeated shutdown keeps the existing force-quit behavior. This ordering prevents active clone children from losing their management channel while the daemon exits.

## Risks / Trade-offs

- [An external SSH agent can still display native UI] -> State the guarantee narrowly, retain the agent by explicit product choice, and keep timeout/cancel available if the agent blocks.
- [PTY output can contain hostile terminal control sequences or secrets emitted by third-party tools] -> Normalize to plain bounded text, render with `textContent`, never reflect submitted input, and expire output shortly after completion.
- [Prompt heuristics miss localized or custom prompts] -> Keep masked input available throughout every active clone; heuristics only focus and label it.
- [Clearing credential helpers makes an HTTPS clone prompt even when a desktop helper has stored credentials] -> Prefer deterministic web-mediated prompting over an unobservable GUI helper; SSH agent keys remain available.
- [A quiet but healthy clone hits inactivity timeout] -> A PTY causes Git transfer progress to be emitted for normal long clones; use a generous default and retain a separate hard cap.
- [Process-group signaling differs across POSIX runtimes] -> Isolate spawn/termination behind a testable adapter and add an integration fixture that verifies a descendant is gone after cancellation.
- [SSE reconnect can duplicate output] -> Number events and honor `Last-Event-ID`; duplicate text is preferable to losing the prompt if a client lacks the header.
- [A failed clone can leave filesystem residue] -> Never register it, report the target and Git error, and avoid unsafe recursive deletion by the daemon.

## Migration Plan

Replace the experimental blocking clone endpoint and dashboard caller together; no released API compatibility or persisted data migration is required. Existing registry and session records are unchanged. Rollback removes only in-memory jobs and restores the old endpoint shape; checkouts already cloned and registered remain ordinary workspaces.
