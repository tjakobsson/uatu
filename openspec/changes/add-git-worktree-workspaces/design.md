## Context

See `proposal.md` for motivation and the two worktree documents in `docs/` for research and the agreed architecture. The SVG is a proposal, not evidence of working integration. This design expands the research's minimal create-only slice while retaining its provider-neutral boundaries.

Observed integration points:

- `src/hub/pages.ts` renders framework-free HTML with inline browser behavior, shared Hub styling and `--titlebar-inset`; the Hub is not the session SPA. `src/hub/server.ts` owns Hub routing. The session switcher is a separate client surface.
- `WorkspaceRegistry` gives canonical directories stable IDs. `SessionManager` and `SessionBackend` coordinate starts/stops; real local startup launches a child rooted at the workspace. Onboarding already journals registration and credential assignment; `PathReservationCoordinator` fences overlapping paths, not repository identities.
- Generic folder management currently performs filesystem renames and registry path rewrites. The existing hub-service/dashboard specs broadly promise rename behavior; this change adds a server-side Git-dependency exception, not a Git-aware move implementation.
- The live-stream spec has a fixed topic vocabulary and intentionally forbids paths/content in activity. Inventory invalidation therefore needs its own explicit topic extension, not hidden extra activity fields or another SSE connection.
- `tests/e2e/hub-server.ts` uses a real Hub with a `HarnessBackend` that **spawns child harness processes**, registers real temporary directories, and starts all configured workspaces. `hub-fixtures.ts` signs in and tracks EventSource connections. That fixture is useful later, but is not a non-mutating worktree UX prototype as-is.
- `playwright.config.ts` uses per-worker fixtures and HTML reports. `tests/e2e/evidence.ts` supplies screenshot/text attachments in Playwright output; tests never hard-code a change folder.

## Goals / Non-Goals

**Goals:** Prove comprehensible lifecycle and navigation before backend work; preserve one checkout/one workspace runtime boundaries; concentrate safety and recovery in one Hub operation layer; make state and provenance explicit.

**Non-Goals:** Multiple roots switched inside a running workspace; moving/forking conversations; transparent native transcript import; detached creation; automatic cleanup; recursive force deletion; Git-aware folder move/repair; copying ignored secrets/dependencies; automatic setup scripts; overriding Claude hooks or adopting OpenCode experimental lifecycle operations; treating worktrees or same-UID processes as security isolation.

## Decisions

### 1. UI-first with a hard approval boundary

Implement only reusable presentation and a **test-only** fake HTTP/state adapter before approval. Proposed `tests/e2e/worktree-demo-server.ts` serves the actual Hub page renderers/assets and responds to the same browser-facing reads/mutations with in-memory fixtures. Demo start/open/stop are simulated; `/s/<fixture-id>/` serves a harmless fixture destination identifying checkout, workspace and navigation back to Hub. It must not instantiate the real onboarding, registry persistence, Git, credential store, provider runtime, or LocalProcessBackend. Unknown mutation routes fail closed. A fake session destination is explicitly not proof that terminal/chat work in a real child.

Reuse/extract production presentation only where necessary from `pages.ts`; scenario controls, fixture objects, clocks, fake auth state, and reset endpoints remain under `tests/`. Do not add a production demo flag or an alternate pretend SPA. A dedicated Playwright fixture launches only this demo server, not `hub-server.ts` and its children. Bind loopback, use synthetic identity and credential names, no real login secrets, no remote requests, and no writes to user repositories/Hub state. Demonstrate safety through a request ledger and process/mutation assertions.

Use deterministic scenarios and controllable latency: populated and empty inventory; loading; all three successful creation modes; invalid branch/path and already-checked-out conflict; stale remote list, explicit fetch pending/success/auth failure; dirty/untracked/ignored/locked/in-use deletion; failed stop; registration failure with retained checkout and retry; discovered external and missing/replaced paths; network failure and reconnect/retry. Reset clears all simulated mutations and navigation state. Make the demo banner and scenario selector obvious but separate from product controls.

Review desktop browser, narrow touch viewport, keyboard/focus/error announcements, light/dark themes, and desktop WebView titlebar inset. Exercise create → stopped → explicit Start/Open → stable URL → back/forward; current conversation/selection stays unchanged on discovery. Capture screenshots and behavior reports using `captureScreenshot`/`saveEvidence` in normal test output. Native macOS behavior remains a later smoke test, not something browser emulation proves.

**STOP after this evidence is presented.** User must explicitly approve the UX; record the actual decision and any required revisions. Planning completion, green tests, or agent judgment cannot satisfy the gate. No Git/backend, CLI, provider-skill installation/integration before that approval.

### 2. Ordinary Git, independent workspace identity

After approval introduce a Hub worktree service beneath authenticated routes, consumed by UI and CLI alike. Use canonical Git common-directory identity for repository grouping/serialization plus the existing path hierarchy reservations and session lifecycle coordination. Keep workspace ID, repository identity, checkout identity, registration, and durable Uatu creation provenance distinct. Never infer ownership from names, `.claude/`, `opencode/`, or registration.

Proposed durable journal records operation ID, initiating user, intended source/destination, repository identity, mode/ref selection, creation phase, verified checkout identity, provenance and registration result. Persist intent before mutation; verify actual Git state during restart recovery. If identity is uncertain, retain files and require reconciliation rather than asserting ownership. Preserve provenance independently of forgetting a registration; re-registering the same verified tree may recover provenance, whereas path reuse never does.

Alternative provider delegation was rejected because hooks/experimental APIs differ in setup and destructive semantics. A full clone loses shared repository behavior. Multiple trees inside one child would require unrelated cwd, watcher and conversation lifecycle changes.

### 3. Creation and credential semantics

Show source repository, mode, destination parent/folder, display name, and explicit refs. Suggest selected checkout HEAD for a new branch but display the choice. Existing-local mode never resets a branch. Remote mode shows selected remote/ref and local tracking name; cached refs disclose freshness and explicit Fetch refreshes them with selected compatible operation credentials. Revalidate resolved refs and branch occupancy at execution; fail visibly rather than silently choosing another ref. Do not promise network freshness without fetch.

Propose default destination from the existing workspace-parent preference, outside the source checkout and provider-reserved trees; allow browsed alternatives subject to validation, rejecting nested source destinations in this initial feature. Validate branch/ref and parent/child paths, reject option-like inputs, use argument arrays and bounded subprocesses, never force or `-B`. Explain Git hooks/filters may execute and uncommitted/ignored files are not copied. Dirty source alone need not block independent checkout creation.

Assignments default to none; selecting source assignments requires explicit confirmation, with independent authentication/signing selection and normal readiness/unlock handling. Operation fetch credentials and retained new-workspace assignments are distinct. Do not inherit ambient agents, copy secrets, or silently pick stored credentials. Reuse onboarding atomic registration/assignment coordination; successful creation is stopped by default, and explicit requested start uses normal startup. Start failure retains the configured stopped workspace (onboarding semantics, not the older clone-specific rollback behavior).

### 4. Recovery is not destructive rollback

Expose phases validating/creating/verifying/registering/ready and terminal errors with sanitized diagnostics. After Git creates a checkout, registration failure retains it and its branch, reports its path and recovery operation, and offers retry-registration for the same verified checkout. Idempotent retry and restart reconcile the journal rather than creating a second tree/branch. Git failure, timeout, or cancellation also inspect for partial resources; never recursively remove uncertain content. Uncertain ownership blocks destructive actions. If registration later fails during deletion, record removal-complete and retry metadata cleanup without deleting a new occupant at that path.

### 5. Discovery and live navigation

Inventory comes from `git worktree list --porcelain -z` using known accessible repository contexts, not arbitrary host scans. Reconcile on navigator/workspace open, after relevant observed agent/terminal activity, bounded periodic refresh while interested clients are visible, and manual refresh. Provider events are hints only; no universal external instant-notification promise. Coalesce/rate-limit per repository. Uatu operations publish invalidation immediately after state is committed; a `worktrees` topic on the existing broker triggers authoritative fetch. Reconnect sends fresh invalidation/snapshot state, independent of conversation cursors. Never add paths to activity or diagnostics.

Display registered Uatu-created, registered external, discovered unregistered external, missing, and uncertain identities distinctly. An Open action for unregistered discovery first configures a workspace with explicit assignments/start choice; registration does not acquire cleanup ownership. A stopped registration offers Start and a running one Open. Grouping is presentation only. Do not auto-register every external checkout, silently switch selection, migrate conversation, or recreate missing paths. Existing exact-cwd Claude/OpenCode filtering remains authoritative.

### 6. Guarded deletion and folder safety

Only an explicit manual action for a verified Uatu-created linked checkout is deletable; never the main checkout or external/unknown tree. Inspect tracked changes, untracked **and ignored** files, Git locks, nested worktrees, identity and known activity. Initial policy blocks dirty/untracked/ignored content rather than introducing force removal; offer instructions to preserve/resolve data externally and recheck. Tell the user external process use may be unknowable. Confirm exact path/branch and stopping agents/shells, fence new starts, await in-flight starts, stop Uatu activity, recheck, then non-force Git worktree removal. Failed checks/stop/remove retain registration and explain the blocker. Unregister/clear assignments and personal state only after verified removal. Preserve branch by default; optional separately confirmed branch deletion uses safe Git checks, reports failure independently and never force-deletes.

Forget remains stop-then-unregister only; it never deletes checkout, branch or files. External trees have open/refresh/forget, no automatic cleanup. Generic rename must preflight both direct and ancestor dependencies through Git metadata, including main checkout/common Git directory and linked trees absent from Hub registry. Unknown/unreadable dependency state fails closed where safety cannot be established. Stop authorization is not authorization to break Git links. Rename workspace (display name only) remains safe. Do not silently repair/move Git structures.

### 7. Shared API, CLI and thin skills after approval

Routes enforce authentication, cookie same-origin checks, current authorization and workspace/source context; jobs/results are scoped to the initiating user and redact secrets. Publish eventual DTOs/errors and live-topic changes through the existing public-contract machinery. UI cannot bypass safety and CLI does not run independent Git commands.

Proposed command family only: `uatu worktree list|create|open|remove` with structured JSON results and explicit source/Hub context. Final spelling, flags, credential transport and packaging are not existing supported commands. Resolve authenticated Hub context through a least-privilege revocable mechanism without tokens in command lines, outputs or skill prose; absence/expiry fails with actionable guidance rather than guessing a Hub. Design that transport and review its threat model after UX approval before integration.

Thin Claude/OpenCode skills explain persistent Uatu workspace requests, the CLI result/recovery contract, ownership and explicit open/stop/delete confirmation. They must not intercept native worktree tools/hooks, write provider ownership markers, or promise subagent base inheritance. Distribution is explicit/opt-in and must preserve user/project configuration. Check actual supported binaries then; no installation, existing CLI availability, or live compatibility is assumed by this plan.

## Risks / Trade-offs

- Shared refs/config and external races → serialize Uatu operations, trust Git checks, revalidate identity; disclose that external actors are outside the fence.
- Prototype can look complete without proving real semantics → mark simulation and keep backend/credential/provider acceptance tests separate after approval.
- Unregistered descendants and separate common Git directories make rename checks harder → targeted dependency discovery tests, fail closed on ambiguity, no promise of arbitrary-host omniscience.
- Ignored data may be valuable and external use is unknowable → block removal on local data, respect locks, explicit warning and no force override in this scope.
- Polling overhead and stale inventories → bounded coalesced refresh, visible stale/error state, manual refresh and immediate Uatu invalidation.
- Version/submodule differences → probe supported Git capabilities and reject unsupported operations with diagnostics; define compatibility floors before shipping, test actual provider binaries separately.

## Migration Plan

1. Ship no integration during planning. Build only the isolated mock-backed UI when implementation is explicitly requested, then stop for UX approval.
2. After approval, add additive journal/provenance metadata; old registrations remain external/unknown unless creation provenance exists. Do not adopt by naming convention.
3. Implement service, guards, authenticated APIs and live contract together; wire approved UI, then CLI and opt-in skills. Existing create/clone/forget behavior outside the new guard remains unchanged.
4. Validate recovery from interrupted create/delete, API compatibility, real temp-repo integration, and provider cwd boundaries before enabling real operations.
5. Rollback disables new mutation entry points, keeps ordinary Git checkouts and branches, preserves recoverable journals/provenance, and leaves compatible registrations usable. Never delete resources during rollback or discard a pending journal to make older code start; resolve/recover or use a compatible version first.

## Open Questions

These are deferred implementation/UX choices within the fixed safety contract, not permission to bypass the gate:

- Final repository grouping/entry-point layout and destination suggestion wording: decide through prototype review.
- Exact bounded refresh cadence/backoff and supported Git/submodule matrix: determine through targeted post-approval tests.
- CLI spelling/flags, authenticated context transport, and opt-in skill packaging/discovery: propose and security-review after UX approval; no installed tool assumptions.
- Whether safe branch deletion is a second action or a separately confirmed option in the delete flow: review wording in the prototype; preserve-branch default and no force remain fixed.
