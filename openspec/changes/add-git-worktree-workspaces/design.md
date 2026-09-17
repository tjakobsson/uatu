## Context

See `proposal.md` for motivation and the two worktree documents in `docs/` for research and the agreed architecture. The SVG is a proposal, not evidence of working integration. This design expands the research's minimal create-only slice while retaining its provider-neutral boundaries.

Observed integration points:

- `src/index.html` and `src/app.ts` are the actual workspace frontend. `src/shell/hub-nav.ts` owns its existing workspace picker in Hub-shaped `/s/<id>/` sessions; extend that surface for worktree discovery, creation and switching rather than building a second navigator. `src/hub/pages.ts` renders the separate server-rendered Hub; its dashboard/onboarding entry points remain secondary.
- `WorkspaceRegistry` gives canonical directories stable IDs. `SessionManager` and `SessionBackend` coordinate starts/stops; real local startup launches a child rooted at the workspace. Onboarding already journals registration and credential assignment; `PathReservationCoordinator` fences overlapping paths, not repository identities.
- Generic folder management currently performs filesystem renames and registry path rewrites. The existing hub-service/dashboard specs broadly promise rename behavior; this change adds a server-side Git-dependency exception, not a Git-aware move implementation.
- The live-stream spec has a fixed topic vocabulary and intentionally forbids paths/content in activity. Inventory invalidation therefore needs its own explicit topic extension, not hidden extra activity fields or another SSE connection.
- `tests/e2e/hub-server.ts` uses a real Hub with a `HarnessBackend` that **spawns child harness processes**, registers real temporary directories, and starts all configured workspaces. `hub-fixtures.ts` signs in and tracks EventSource connections. That fixture is useful later, but is not a non-mutating worktree UX prototype as-is.
- `tests/e2e/server.ts` already serves the real frontend with base-path-aware navigation and injected route dependencies; `tests/e2e/chat-service.ts` supplies fake chat-service patterns. Reuse these patterns, not their entire startup: the existing server also wires filesystem restoration, watchers, Git and a terminal backend, which must not become reachable in the mock host.
- `playwright.config.ts` uses per-worker fixtures and HTML reports. `tests/e2e/evidence.ts` supplies screenshot/text attachments in Playwright output; tests never hard-code a change folder.

## Goals / Non-Goals

**Goals:** Prove comprehensible lifecycle and navigation inside the real workspace frontend before backend work; demonstrate independent document, preview, terminal and chat contexts through the existing workspace picker; preserve one checkout/one workspace runtime boundaries; concentrate safety and recovery in one Hub operation layer; make state and provenance explicit.

**Non-Goals:** Multiple roots switched inside a running workspace; moving/forking conversations; transparent native transcript import; detached creation; automatic cleanup; recursive force deletion; Git-aware folder move/repair; copying ignored secrets/dependencies; automatic setup scripts; overriding Claude hooks or adopting OpenCode experimental lifecycle operations; treating worktrees or same-UID processes as security isolation.

## Decisions

### 1. UI-first with a hard approval boundary

Implement only reusable frontend presentation and a **test-only** fake HTTP/state adapter before approval. Revise `tests/e2e/worktree-demo-server.ts` into a host for the actual `src/index.html`/`src/app.ts` frontend at separate `/s/<workspace-id>/` URLs, with normal bundled assets and base-path-aware session requests. Extend the real `src/shell/hub-nav.ts` picker to discover, create and switch worktrees. A standalone Hub-style page, placeholder session destination or alternate pretend SPA does not satisfy this design. Hub dashboard/onboarding presentation may remain available as secondary navigation, not the primary review surface.

Reuse the shell-serving, navigation and dependency-injection patterns from `tests/e2e/server.ts` and fake chat-service patterns from `tests/e2e/chat-service.ts`; do not import or launch the existing server's side-effectful startup wholesale. The dedicated host supplies only allowlisted in-memory document/tree/render, terminal, chat, workspace state and live-channel adapters needed by the real frontend. Terminal sessions/output and chat inventories/transcripts/responses are simulated, with no PTY, shell command or provider invocation. Fake chat file-restoration or attachment callbacks must remain in memory rather than write to a checkout. Start/open/stop, fetch, credentials and lifecycle operations are simulated. No real onboarding, registry persistence, Git, watcher, credential store, provider runtime or LocalProcessBackend is instantiated; unknown routes fail closed rather than fall through to production handlers or a remote proxy.

Maintain fixture context keyed by workspace ID: distinguish checkout identity, document tree and selected document, preview content, terminal session/output and selection, and chat inventory/transcript and selected conversation. Navigating to another worktree loads its separate workspace URL and context, never swaps cwd inside the current workspace. Returning through the picker or browser history restores that workspace's own context, including its document and conversation selection, without copying or migrating another workspace's conversations. Creation/discovery alone leaves the current context unchanged. Use distinct fixture content and identifiers to make cross-workspace leakage observable; route responses, simulated streams and any browser restoration state must respect workspace boundaries, including delayed responses after navigation.

Scenario controls, fixture objects, clocks, fake auth state and reset endpoints remain under `tests/`; only reusable product presentation belongs in `src/`. Do not add a production demo flag. A dedicated Playwright fixture launches only the test host, not `hub-server.ts` or workspace children. Bind loopback, use synthetic identity and credential names, no real login secrets, no remote requests, and no writes to user repositories or persistent Hub state. The test host process itself is the only required server, not a simulated workspace runtime. Demonstrate safety through a request ledger and assertions that no Git, PTY, child process, provider, credential or persistent-state effects are reachable.

Use deterministic scenarios and controllable latency: populated and empty inventory; loading; all three successful creation modes; invalid branch/path and already-checked-out conflict; stale remote list, explicit fetch pending/success/auth failure; dirty/untracked/ignored/locked/in-use deletion; failed stop; registration failure with retained checkout and retry; discovered external and missing/replaced paths; network failure and reconnect/retry. Reset restores every workspace's simulated data, selections and navigation state, clears simulated mutations and pending events, and prevents browser restoration state from reviving a previous scenario. Make the demo banner and scenario selector obvious but separate from product controls.

Review desktop browser, narrow touch viewport, keyboard/focus/error announcements, light/dark themes, and desktop WebView titlebar inset in the actual workspace frontend. Begin in a populated source workspace, open its existing picker, exercise create → stopped → explicit Start/Open → separate stable URL, inspect the destination's distinct files/preview/terminal/chat, then return via picker and back/forward and verify restoration of each workspace's own context. Discovery and simulated live invalidation/reconnect must not change the active document or conversation; test delayed responses for cross-workspace leakage. Capture screenshots and behavior reports using `captureScreenshot`/`saveEvidence` in normal test output, showing the actual picker and workspace surfaces rather than only dashboard cards. This proves frontend behavior against mocks, not real Git cwd, PTY or provider isolation. Native macOS behavior remains a later smoke test, not something browser emulation proves.

**STOP after this evidence is presented.** User must explicitly approve the UX; record the actual decision and any required revisions. Planning completion, green tests, or agent judgment cannot satisfy the gate. No Git/backend, CLI, provider-skill installation/integration before that approval.

The previous standalone demo and prior completion checkboxes are historical evidence, not acceptance of this iteration. The user approved the grouped-parent, branch-name, fixed-destination and live-inheritance decisions below and their artifact reconciliation; that authorization is not final UX approval under task 2.2. Reverify affected mock tasks and present fresh evidence before stopping at that gate.

### 2. Ordinary Git, independent workspace identity

After approval introduce a Hub worktree service beneath authenticated routes, consumed by UI and CLI alike. Use canonical Git common-directory identity for repository grouping/serialization plus the existing path hierarchy reservations and session lifecycle coordination. Keep workspace ID, repository identity, checkout identity, registration, and durable Uatu creation provenance distinct. Never infer ownership from names, `.claude/`, `opencode/`, or registration.

Proposed durable journal records operation ID, initiating user, intended source/destination, repository identity, mode/ref selection, creation phase, verified checkout identity, provenance and registration result. Persist intent before mutation; verify actual Git state during restart recovery. If identity is uncertain, retain files and require reconciliation rather than asserting ownership. Preserve provenance independently of forgetting a registration; re-registering the same verified tree may recover provenance, whereas path reuse never does.

Alternative provider delegation was rejected because hooks/experimental APIs differ in setup and destructive semantics. A full clone loses shared repository behavior. Multiple trees inside one child would require unrelated cwd, watcher and conversation lifecycle changes.

### 3. Creation and credential semantics

Both parent fork icons open a small two-option dropdown: **New branch / worktree** and **Existing branch**. New opens only a title, Name field and Create/Cancel; source HEAD is predetermined. Existing is a true editable accessible combobox combining local and remote branches with badges and remote-qualified names. Typing fuzzy-filters; click/Enter commits the exact displayed ref into the field, confirms/highlights selection and collapses the list. Editing always clears the underlying choice and disables Create until a valid option is picked again. Reopening a committed field offers all refs, not a list accidentally filtered to that value. Arrows navigate, Enter selects rather than submits, Escape closes the list before the dialog, and blur/click-away closes the list. Touch uses the same options. Cancel/reopen starts without an old hidden choice. No base, destination, configuration, ownership or informational readouts belong in either popup. Conflicts offer direct Open/Start/registration actions.

The child workspace name is its exact current local branch, including slashes; no independent child display-name form or branch rename is offered. Existing-local mode never resets a branch. Remote selection derives the local tracking name by removing the remote prefix; an existing local name conflicts rather than resets. A small icon beside the branch field is labeled and titled **Fetch remote branches**. Cached options are immediate; opening never triggers a fetch. Explicit fetch uses parent policy, reports loading and inline auth/network errors, preserves query and a still-valid choice, and clears selection if the ref disappears. No duplicate fetch control is on the dashboard. Selecting a cached remote does not claim network freshness. Revalidate refs and occupancy in the exact selected repository.

Use the predetermined sibling `<main-folder>.worktrees/<safe-branch-folder>` (for example `atlas.worktrees/feature-login` for branch `feature/login`). No destination or name form is offered. Sanitize only the folder, never the displayed branch. On a sanitized-folder collision, use a deterministic branch-derived suffix, then refuse if that destination is also occupied; never overwrite. Validate branch components and refs, including option-like names, dot/lock components, control characters and revision syntax. After approval real Git still revalidates. External discoveries stay at their existing paths. Explain Git hooks/filters may execute and uncommitted/ignored files are not copied. Dirty source alone need not block independent checkout creation.

Credential assignments and shared workspace configuration belong only to the explicitly identified main parent and are inherited live by every child, including explicitly registered external children. Parent updates propagate, with no per-child Configure or overrides. Disclose parent policy at registration; parent Configure manages policy. Compact creation omits predetermined policy readouts. This is a relationship, not secret copying or ambient credential adoption. Files, roots, running state, terminals, conversations, selections and personal/device preferences remain independent. Creation is stopped by default; start failure retains the child and offers relevant Retry/Start. Actual credential/runtime enforcement remains blocked behind UX approval.

#### Approved mock-only branch-origin revision

Nested children in the actual workspace selector and original-style dashboard
show a small muted `from main`, `from origin/foo`, or `origin unknown` label,
keeping the exact current branch primary. Compact menus/popups are unchanged.
The optional `sourceRef` presentation field is an immutable branch-creation
snapshot, separate from `upstream`, checkout starting revision and live parent
configuration. New branch creation records the selected parent's current
simulated HEAD ref, never a hardcoded `main`; a newly created tracking branch
records the selected remote-qualified ref. Explicit synthetic fixture history and
the in-memory repository/branch history retain known origins across checkout
removal/recreation while the branch survives. Existing-local branches and
external trees without that history show unknown. Neither upstream, merge-base,
parent identity nor a checkout's base can establish historical branch origin.
Changing parent ref/configuration or upstream must not rewrite the snapshot.
No Git inference, durable storage or new real operation is introduced before 2.2.

### 4. Recovery is not destructive rollback

Successful mock creation closes the originating popup on SPA, dashboard and review entry paths, refreshes the source list/picker/dashboard, and shows a small `Created <branch>` confirmation with Open. The source remains selected; the new child remains stopped until explicit Open performs the existing start-then-open flow. Never automatically mount Worktree ready, Details or inventory after creation. Async errors and retained-checkout registration failure stay in a compact originating flow with actionable retry, not a path/identity/configuration dump. Retry registration operates on the same retained checkout; start failure offers retry without another creation.

Expose bounded operation progress and sanitized errors. After Git creates a checkout, registration failure retains it and its branch and offers retry-registration for the same verified checkout; internal recovery identity and path are not routine popup contents. Idempotent retry and restart reconcile the journal rather than creating a second tree/branch. Git failure, timeout, or cancellation also inspect for partial resources; never recursively remove uncertain content. Uncertain ownership blocks destructive actions. If registration later fails during deletion, record removal-complete and retry metadata cleanup without deleting a new occupant at that path.

### 5. Discovery and live navigation

#### Selected Active groups dashboard; independent lifecycle

The repository heading owns parent configuration, rename and fork controls, not a runtime session. Its main checkout has its own row, actual branch label and explicit Main checkout identity. Stopping main stops only main; a child may start while main remains stopped. Parent policy ownership is independent of runtime availability.

The user selected **A · Active groups** on 2026-09-17 ("Lets go on A"). It is the sole worktree-capable dashboard layout, not a preference. The alternate renderer and layout toggle are removed. Old layout query links safely resolve to Active groups; mock URLs canonicalize without resetting state. Scenario controls remain test-only. The selected renderer belongs to reusable actual dashboard presentation, not a permanent test-only override.

- **Active groups:** repositories with any running checkout appear under Active. Group heading, main's own lifecycle row and running children stay together, even when main is stopped. Stopped children live under expandable `N stopped worktrees`. Only stopping the last running checkout moves the whole group to Inactive, where all-stopped groups are collapsed with explicit expand-to-Start/fork affordance.

Preserve actual dashboard row styling, fonts, paths, status, provenance and applicable safety/action handlers; no-capability pages are unchanged. Verify default rendering, mixed repositories (including main stopped + child running), all-stopped scenarios, keyboard/touch disclosures and persistence of the selected presentation through operations/reload. Capture desktop/touch evidence for Active groups only. Existing selector nesting stays unchanged. Final UX gate 2.2 is unapproved; this choice authorizes no real integration.

Preserve original dashboard rows, paths, status dots, shell/credential summaries and applicable Open/Start/Stop/Rename/Remove actions. Add grouping, exact branch names and parent forks, not a replacement dashboard. Children follow their parent with truthful status/actions. There is no generic Details view or switcher Details action. The switcher focuses on switching and parent forks; dashboard parent Configure manages policy and children have no Configure. Keep Remove from Uatu distinct from guarded Delete worktree, offered only for owned children as a secondary action (reuse an existing secondary affordance when present). Missing paths and recovery have inline actionable errors. Test-only visible controls retain inventory/discovery, unavailable paths and folder-guard review; no hidden fixture editing is required.

The in-workspace picker is the primary navigator: group children under explicit main workspace and repository identity, never matching display names. Put a fork action on each main row, targeting that parent; children have no fork button and are subordinate/indented with exact local branch names. The actual Hub dashboard renderer shows the same hierarchy through optional capability data; ordinary unmocked/no-capability running/stopped behavior remains unchanged. Include at least two mock parents and identical branch names across repositories. Preserve workspace identity/activity affordances. Explicit switching navigates to the selected checkout's independent workspace, and returning restores its own context; no conversation migration.

Inventory comes from `git worktree list --porcelain -z` using known accessible repository contexts, not arbitrary host scans. Reconcile on navigator/workspace open, after relevant observed agent/terminal activity, bounded periodic refresh while interested clients are visible, and manual refresh. Provider events are hints only; no universal external instant-notification promise. Coalesce/rate-limit per repository. Uatu operations publish invalidation immediately after state is committed; a `worktrees` topic on the existing broker triggers authoritative fetch. Reconnect sends fresh invalidation/snapshot state, independent of conversation cursors. Never add paths to activity or diagnostics.

Display registered Uatu-created, registered external, discovered unregistered external, missing, and uncertain identities distinctly. Unregistered external Open first confirms registration under the parent policy and an optional start; it does not move the existing checkout or acquire cleanup ownership. A stopped registration offers Start and a running one Open. Grouping never confers ownership. Do not auto-register every external checkout, silently switch selection, migrate conversation, or recreate missing paths. Existing exact-cwd Claude/OpenCode filtering remains authoritative.

### 6. Guarded deletion and folder safety

Only an explicit manual action for a verified Uatu-created linked checkout is deletable; never the main checkout or external/unknown tree. The compact dialog title is `Delete worktree?`, identity `<parent display name> / <branch>`. Stopped copy: “The worktree’s files will be removed. The Git branch will be kept.” Running copy: “Its Uatu terminal and agent sessions will stop, then the worktree’s files will be removed. The Git branch will be kept.” Actions are Cancel and destructive Delete or Stop and delete. The latter explicitly authorizes stopping Uatu activity; there is no extra checkbox. No full path, IDs, ownership, status card, duplicate fields or configuration; simulation controls stay outside. Normal cases fit a phone viewport without scrolling.

Inspect tracked changes, untracked **and ignored** files, Git locks, nested worktrees, identity and known activity. Blockers replace normal consequences with a short actionable reason and Cancel/Close (retry only where meaningful), not a metadata view or force action. Explicitly authorized known Uatu runtime can stop and proceed; unrelated external activity remains a blocker, with no claim Uatu can stop unknown external applications. Fence new starts, await in-flight starts, stop Uatu activity, recheck, then non-force removal. Failed checks/stop/remove retain registration and files. Success closes the dialog and removes the row; active-context removal uses existing safe navigation. Unregister only after verified removal. Always preserve the branch: branch deletion and its UI are out of scope by explicit user decision.

Forget remains stop-then-unregister only; it never deletes checkout, branch or files or changes parent policy. External trees have open/refresh/forget, no automatic cleanup. Generic rename must preflight both direct and ancestor dependencies through Git metadata, including main checkout/common Git directory and linked trees absent from Hub registry. Unknown/unreadable dependency state fails closed where safety cannot be established. Stop authorization is not authorization to break Git links. Main workspace display-name editing remains safe; child names follow their local branch and branch rename is out of scope. Do not silently repair/move Git structures.

### 7. Shared API, CLI and thin skills after approval

Routes enforce authentication, cookie same-origin checks, current authorization and workspace/source context; jobs/results are scoped to the initiating user and redact secrets. Publish eventual DTOs/errors and live-topic changes through the existing public-contract machinery. UI cannot bypass safety and CLI does not run independent Git commands.

Proposed command family only: `uatu worktree list|create|open|remove` with structured JSON results and explicit source/Hub context. Final spelling, flags, credential transport and packaging are not existing supported commands. Resolve authenticated Hub context through a least-privilege revocable mechanism without tokens in command lines, outputs or skill prose; absence/expiry fails with actionable guidance rather than guessing a Hub. Design that transport and review its threat model after UX approval before integration.

Thin Claude/OpenCode skills explain persistent Uatu workspace requests, the CLI result/recovery contract, ownership and explicit open/stop/delete confirmation. They must not intercept native worktree tools/hooks, write provider ownership markers, or promise subagent base inheritance. Distribution is explicit/opt-in and must preserve user/project configuration. Check actual supported binaries then; no installation, existing CLI availability, or live compatibility is assumed by this plan.

## Risks / Trade-offs

- Shared refs/config and external races → serialize Uatu operations, trust Git checks, revalidate identity; disclose that external actors are outside the fence.
- Prototype can look complete without proving real semantics → serve the actual frontend and require cross-workspace context evidence, visibly mark simulation, and keep Git/backend/credential/PTY/provider acceptance tests separate after approval. Prior standalone-demo evidence does not satisfy the revised gate.
- Reusing the E2E server wholesale could activate filesystem/Git/terminal effects → reuse isolated serving and fake-service patterns only, inject in-memory dependencies, fail closed on unhandled routes, and assert the absence of real effects.
- Same-origin storage, pending responses and simulated streams can leak selections between workspace URLs → key fixtures and restoration by workspace, test round trips and navigation races, and reset all scenario-owned context deterministically.
- Unregistered descendants and separate common Git directories make rename checks harder → targeted dependency discovery tests, fail closed on ambiguity, no promise of arbitrary-host omniscience.
- Ignored data may be valuable and external use is unknowable → block removal on local data, respect locks, explicit warning and no force override in this scope.
- Polling overhead and stale inventories → bounded coalesced refresh, visible stale/error state, manual refresh and immediate Uatu invalidation.
- Version/submodule differences → probe supported Git capabilities and reject unsupported operations with diagnostics; define compatibility floors before shipping, test actual provider binaries separately.

## Migration Plan

1. Implement only the explicitly requested mock UX iteration and approved artifact reconciliation. Serve the real frontend and dashboard through isolated adapters, retain safety/recovery scenarios, rerun grouping/inheritance/context-restoration evidence, and stop for explicit UX approval; earlier demo completion is not acceptance.
2. After approval, add additive journal/provenance metadata; old registrations remain external/unknown unless creation provenance exists. Do not adopt by naming convention.
3. Implement service, guards, authenticated APIs and live contract together; wire approved UI, then CLI and opt-in skills. Existing create/clone/forget behavior outside the new guard remains unchanged.
4. Validate recovery from interrupted create/delete, API compatibility, real temp-repo integration, and provider cwd boundaries before enabling real operations.
5. Rollback disables new mutation entry points, keeps ordinary Git checkouts and branches, preserves recoverable journals/provenance, and leaves compatible registrations usable. Never delete resources during rollback or discard a pending journal to make older code start; resolve/recover or use a compatible version first.

## Open Questions

These are deferred implementation/UX choices within the fixed safety contract, not permission to bypass the gate:

- Grouping, parent-only fork actions, exact child branch names, fixed sibling destinations and live parent inheritance are approved iteration decisions, not open questions. The revised mock still requires final user UX approval.
- Exact bounded refresh cadence/backoff and supported Git/submodule matrix: determine through targeted post-approval tests.
- CLI spelling/flags, authenticated context transport, and opt-in skill packaging/discovery: propose and security-review after UX approval; no installed tool assumptions.
- Branch deletion and generic Details navigation are removed by approved simplification, not unresolved choices. Ref fetch is only adjacent to the editable branch combobox.
