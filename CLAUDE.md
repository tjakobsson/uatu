# CLAUDE.md — agent guidance for uatu

uatu is a local Bun-served PWA that watches a docs tree and previews
Markdown / AsciiDoc with an embedded terminal.
See `ARCHITECTURE.md` for the deeper picture (runtime, request lifecycle,
state lifecycle, terminal subsystem, follow-mode rules, how-to-extend
recipes).

## src/ folder map

`src/` is organized by feature. Three entrypoint files live at the root
(`app.ts`, `cli.ts`, `styles.d.ts`); everything else is in a folder named
after the running app's region or a coherent domain.

```
src/
├── app.ts          SPA entry — DOM queries, init calls, event wiring
├── cli.ts          CLI entry — `uatu hub` dispatch + the session child the
│                   hub spawns (internal `serve`) + its Bun.serve assembly
├── styles.d.ts     CSS module type declarations
├── index.html, styles.css, assets/, assets/fonts/
│                   (the bundled Hack Nerd Font Mono lives here — it's
│                   the default for *every* monospace surface in the
│                   app, served at /assets/fonts/, with siblings for
│                   the upstream license texts)
│
├── chat/           the agent chat surface — shared seam + machinery at
│                   the root (provider/types/adapter/agents/replay/
│                   receipts/client/validation/timeline-renderer/ui;
│                   ansi renders tool output as terminal text against the
│                   terminal's palette; conversation-totals folds priced
│                   usage carriers and task rows into the cost receipt, which
│                   receipt-view itemizes by agent, type, or model;
│                   task-inspection drives the running-task drill-down —
│                   an agent task's live child transcript, a shell task's
│                   output tail, and the re-read from disk that follows a
│                   run which streams nothing; surface says whether the
│                   chat is the surface in front, which the hub switcher's
│                   viewed acknowledgement also reads);
│                   agent-specific stacks below the seam in
│                   chat/opencode/ (the loopback server runtime, which
│                   decides the spawned server's generation from its
│                   readiness answer, + one stack per OpenCode generation:
│                   v1/ is the 1.x provider on `@opencode-ai/sdk` and its
│                   normalization, v2/ the 2.x provider on
│                   `@opencode/client`; the shared normalization core sits
│                   at the root) and chat/claude/ (probe runtime,
│                   per-conversation SDK sessions, transcript reader,
│                   model catalog, normalization). One conversation is
│                   owned by one agent for life; ids are agent-qualified
│                   on the wire (`<agentId>:<providerId>`). Each agent's
│                   `sdk-coverage.ts` holds the hand-kept annotations for
│                   the SDK coverage report (`bun run coverage:agents`,
│                   scripts/agent-coverage.ts → docs/agents/)
├── find/           ⌘F — active-surface tracking (which surface the user is
│                   working in, tracked from interaction, NOT from DOM focus),
│                   the shared find bar and its pluggable engines (preview and
│                   terminal), text indexing, matching, and highlight painting
├── shell/          boot, events, live-channel + live (the page's one
│                   brokered live stream and its lifecycle recovery),
│                   history, url, connection, pwa, follow,
│                   follow-rules, state, storage, freshness (client/server
│                   build-identity handshake), ui-mode (per-device
│                   touch/desktop mode on <html>), desktop-viewport (desktop
│                   visible rectangle and device safe areas), tab-bar (touch mode's
│                   bottom Files/Preview/Terminal tabs), worktree-dialog
│                   (the one client worktree dialog, embedded in both
│                   hub-nav's picker and the Hub dashboard) + worktree-live
│                   (its `worktrees` live-invalidation subscription),
│                   attention-notice (the in-page "needs your answer"
│                   notice for other workspaces) — the app-wide chrome and
│                   the appState singleton
├── preview/        the right pane — mounting rendered HTML, view-mode
│                   chooser, layout (split/stacked), diff view,
│                   mermaid trigger, anchors, image/binary fallbacks,
│                   metadata card, code-block decorations
├── sidebar/        the left pane — tree-view, panes
│                   shell/render, change-overview, git-log, files-filter,
│                   search-pane (⇧⌘F project search: pane + result model +
│                   open-and-jump); in touch mode the whole pane stack
│                   renders fullscreen as the Files tab
├── terminal/       the embedded xterm panel — client + server +
│                   auth + pty + pane-state + panel UI
├── cli/            CLI domain — parse (flags, usage text, and the refusal
│                   a user-shaped `serve` gets) and output (TTY banner +
│                   indexing status); cli.ts imports these
├── server/         routes (single source of truth for the HTTP route
│                   table + the shared fetch fallback), watch-session
│                   (live-reload engine), roots (resolution + scanning),
│                   search (content sweep over the watched roots),
│                   render-dispatch, static-files, navigation, port-probe
├── document/       document + repository git concerns — metadata, diff,
│                   classify, git-base-ref, git-data (the repository-level
│                   sweep: changed files, commit log, repo metadata),
│                   language detection
├── render/         source → HTML (markdown, asciidoc, mermaid sanitization)
├── ignore/         engine + config (the `.uatu.json ignore` block — the
│                   file's only block — and --no-gitignore)
├── hub/            `uatu hub` — self-hostable session server: config,
│                   state-dir, registry (stable workspace slugs), backend
│                   (SessionBackend seam + local-process impl), proxy
│                   (HTTP/WS + token brokering), live-broker (refcounted
│                   child-topic subscriptions fanned out to every page's
│                   one `/api/hub/live` stream, plus one hub-lifetime
│                   activity watch per running workspace; it also owns
│                   per-user presence, see presence.ts, which holds pushes
│                   while a session page is visible) + activity-marks
│                   (its finished/viewed marks, persisted in the state dir),
│                   auth (users + the server-side session store, one id over
│                   cookie/bearer transports + rate limit + CSRF),
│                   worktree-* (the linked Git worktree service — git
│                   probes, journal, reconciler, rename/delete guards — and
│                   its published JSON family at `worktree-api.ts`,
│                   `/api/hub/worktrees`), pages, server, main
├── watchdog/       main + capture — heartbeat-driven hang recovery
├── debug/          cache + metrics + the heartbeat integration test
├── pwa/            PWA assets, shared browser notification enrollment UI,
│                   and the hub's push-only service worker
└── shared/         html, types, license-check, version, worktree-contract
                    + worktree-branches (the worktree wire DTOs/errors and
                    branch/destination rules shared by client and Hub)
```

Outside `src/`: `desktop/macos/` is **UatuCode Desktop**, the SwiftUI macOS
hub client (Xcode project `UatuCodeDesktop`). It is connect-only: no
embedded binary, no process supervision — it logs in to configured hubs
(session id in the Keychain, presented as `Authorization: Bearer` natively
and injected as the hub cookie for WebViews; see `ARCHITECTURE.md`). Its CI
is path-filtered (`.github/workflows/desktop-ci.yml`); it builds with plain
`xcodebuild`, no CLI build required.

## Conventions

- **`src/` is product code only.** Test harnesses live in `tests/`. The
  E2E Playwright server is at `tests/e2e/server.ts`, NOT in `src/`.
- **Tests are colocated.** `foo.ts` and `foo.test.ts` are siblings; no
  parallel test tree under `src/`.
- **The HTTP route table is declared once** in `src/server/routes.ts`
  via `buildRoutes(deps)`. `cli.ts` (prod) and `tests/e2e/server.ts`
  (e2e) both call it with mode-specific deps.
- **appState lives in `src/shell/state.ts`.** It's a module-level
  mutable singleton. Other modules import it directly; do not duplicate.
- **Cross-cutting helpers** like `escapeHtml` live in `src/shared/`.
  Don't reach into `app.ts` for them — that path has caused
  circular-import TDZ bugs.
- **`serve` is internal.** Users run `uatu hub`; a user-shaped `uatu serve`
  prints the hub bootstrap steps and exits non-zero. `serve` is reached only
  by the hub's spawn (`--exit-on-stdin-close`) and by source runs
  (`bun run src/cli.ts serve …`, e.g. `tests/e2e/base-path.e2e.ts`).
- **Client URLs go through `appUrl()`** (`src/shared/app-url.ts`) — never a
  root-relative `/api`/`/assets` literal; `shared/app-url-discipline.test.ts`
  enforces it. This is what makes a session relocatable under
  `--base-path` (which the hub relies on).
- **Tests never write into `openspec/`.** E2E screenshots and evidence
  reports go to Playwright's `test-results/` and the HTML report through
  `tests/e2e/evidence.ts`. A change's `screenshots/` folder is PR evidence,
  assembled at PR time by running the relevant suite with
  `UATU_E2E_SCREENSHOTS_DIR=openspec/changes/<change>/screenshots`; it
  travels with the change to the archive. `tests/evidence-discipline.test.ts`
  fails any test that names a change folder.
- E2E tests live in `tests/e2e/` under feature-named files
  (`mermaid.e2e.ts`, `sidebar.e2e.ts`, `document-tree.e2e.ts`, etc.) —
  there is no monolithic `uatu.e2e.ts`.
- **The follow-mode capability** owns the Follow toggle, its four rules
  (Rule A user click, Rule B chip click, Rule C/D file event), and the
  `TreeView.withProgrammaticUpdate(fn)` guard that distinguishes real
  user clicks from library-fired callbacks. Spec at
  `openspec/specs/follow-mode/spec.md`.

## Release-note discipline

- Public release notes describe the user-visible delta from the latest stable
  `v*` tag. Git history may retain the feature work and subsequent corrections
  that produced that final behavior.
- Before preparing or merging a `fix` PR, determine whether the broken behavior
  exists in the latest stable release. Stable regressions remain visible
  `fix(...)` entries. A correction that only stabilizes functionality added
  after the latest stable tag keeps its truthful `fix(...)` PR/commit title,
  but the PR body must contain a Release Please override before squash merge:

  ```text
  BEGIN_COMMIT_OVERRIDE
  chore(scope): stabilize the unreleased feature before release
  END_COMMIT_OVERRIDE
  ```

- Routine dependency updates are `chore(deps)` and hidden. Only dependency
  updates that remediate a known vulnerability use visible `fix(deps)` notes;
  name the security reason rather than merely the version bump.
- Curate generated notes through overrides on the source PR, not by editing the
  Release Please PR. If an override is added after merge, rerun the Release
  Please workflow so it rereads the merged PR body.

## Commands

- `bun run dev` — dev hub at `http://127.0.0.1:4702/` (`dev/hub.json`, user
  `dev` / password `dev`) with `testdata/watch-docs` registered and opened
- `bun test` — unit suite, one file at a time (about 3 min on a CI runner)
- `bun run test:ci` — the same suite as CI runs it: `bun test --parallel=4`
  (four worker processes, each file isolated) with `tests/unit-timings.json`
  starting the slowest files first; the longest file,
  `src/hub/worktree-lifecycle.integration.test.ts`, sets the floor (on a
  6-core laptop about 80 s, against about 280 s one file at a time). Refresh
  the timings with `bun run test:ci --update-timings` when files move a lot
- When developing Uatu inside a Hub-managed workspace, credential tests may
  discover Uatu's projected Git/SSH wrappers. Use a clean tool environment for
  those tests; do not change product behavior to accommodate nested projection.
- `bun run test:e2e` — the whole Playwright suite, both projects (848 tests,
  4 workers, `fullyParallel`, retries only on CI; about 15–20 min on a
  4-core runner). CI runs the `e2e` project in two shards and `perf` in its
  own job, then merges their blob reports into one HTML report.
- `bun run test:e2e:perf` — only the `perf` project: tests tagged `@perf`
  that hold a frame, interaction, or load budget (chat-follow-stability,
  the long-output shell test, hub-live-stream), at most 2 workers.
  `bun run test:e2e:no-perf` (the `e2e` project) skips them. Tag a new
  budget test `@perf`; make deterministic work counters its pass criterion
  and keep wall-clock time as evidence or a loose guard.
- `bun run build` — compile the single-file `dist/uatu` binary
- `bun run check:licenses` — license audit
