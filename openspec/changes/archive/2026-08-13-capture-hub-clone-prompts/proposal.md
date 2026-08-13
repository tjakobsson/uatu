## Why

Hub repository clones can wait forever when Git or SSH requests credentials because the clone has no usable interactive terminal, no timeout, and no cancellation path. The dashboard must let the signed-in user answer terminal prompts and observe progress without allowing the daemon's clone child to prompt through an inherited controlling terminal or OS askpass UI.

## What Changes

- Replace the dashboard's single blocking clone request with an observable, cancellable clone job that streams terminal output and reports cloning, workspace registration, and session-start outcomes.
- Run each clone in a dedicated PTY and surface a masked response control in the Add Folder flow so Git/SSH-owned credential and trust prompts can be answered from the dashboard.
- Force Git and SSH askpass off for hub clones and disable Git credential helpers for that invocation, while retaining an existing SSH agent for already-loaded keys; external agent behavior remains outside the hub's no-GUI guarantee.
- Bound clone jobs with inactivity and hard timeouts, terminate their process groups on cancellation, timeout, shutdown, or failure, and reap retained output/job metadata after a short expiry.
- Preserve the existing guarantees that failed clones register nothing, successful clones are registered and served, and credentials supplied through the dashboard are never persisted or echoed by the hub.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `hub-dashboard`: Change repository cloning from a blocking action into an observable prompt-capable flow with streamed progress, masked responses, cancellation, and explicit completion or failure feedback.
- `hub-service`: Add authenticated, user-owned clone-job lifecycle behavior, PTY isolation, prompt routing, timeouts, process-tree cleanup, bounded retention, and shutdown handling.

## Impact

- Hub Git plumbing and process management in `src/hub/git.ts`, plus a new hub-local clone-job manager or equivalent lifecycle owner.
- Hub routes and dependency assembly in `src/hub/server.ts` and `src/hub/main.ts`, including streaming output and POST-only input/cancel operations under the existing auth and CSRF gate.
- Add Folder markup, styles, and client behavior in `src/hub/pages.ts`.
- Hub unit/integration coverage for prompts, streaming, cancellation, ownership, timeout, process cleanup, successful registration/start, and secret non-retention.
- No new runtime dependency is expected because Bun's existing PTY support is already wrapped by the terminal subsystem.
