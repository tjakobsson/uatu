## Context

The current `src/` layout is a flat folder of ~80 TypeScript files. The Astro docs site's `src/` was offered as a reference for grouping; this design borrows the *spirit* (named subfolders by concern, narrow root) but rejects the literal taxonomy (assets/components/content/pages) because uatu is not a content site — it is a CLI tool that mounts a single-page web UI plus a server, plus a terminal subsystem, plus a CLI entry point.

Diagnostic observations that shaped this design:

- `src/app.ts` is 4183 lines with 126+ top-level functions, ~190 DOM calls, 14 localStorage calls. By line range it cleanly splits into four roles: shell/boot, preview pane, sidebar, terminal panel.
- `setupTerminalPanel` alone is 724 lines inside `app.ts`, despite the rest of the terminal subsystem already living in dedicated `terminal-*` files.
- The production server's `Bun.serve({ routes: {...} })` call lives in `cli.ts` (line 259), and `e2e-server.ts` (line 51) has a parallel one. 12 of 14 routes are duplicated. `src/server.ts` (the 1477-line "server" file) contains *zero* of them — it exports building blocks only. The name is misleading.
- `app-score-explanation.test.ts` reads `app.ts` as a string and walks braces to extract the function body it wants to test. This is a workaround that exists only because the function is buried in a side-effecting monolith.
- `appState` is a module-local mutable at `app.ts:279`. Any extraction depends on first giving it an importable home.
- `tests/e2e/uatu.e2e.ts` is 2719 lines spanning Mermaid, diagram viewer, sidebar, change overview, git log, ignore policy, AsciiDoc, code blocks, follow mode. The repo already has split-off siblings (`document-tree.e2e.ts`, `terminal.e2e.ts`, `pwa.e2e.ts`, `files-pane-filter.e2e.ts`) — the precedent and pattern exist.

Constraints:

- No user-visible behavior change. Existing test suites (unit + E2E) must pass throughout.
- The project uses Bun (`bun test`, `Bun.serve`, `Bun.file`, `bun run`). Imports use `.ts`-extensionless paths resolved by Bun.
- Tests are colocated next to source today (`foo.ts` + `foo.test.ts`). Keep that convention.
- The work must be reviewable. Each extraction should be a self-contained step that can be PR'd and reverted independently.

## Goals / Non-Goals

**Goals:**

- Every part of `src/` lives in a folder named after a region of the running app or a clear domain.
- `src/app.ts` shrinks from 4183 lines to a thin entrypoint (target: < 200 lines) that wires shell + preview + sidebar + terminal.
- The HTTP route table is declared exactly once.
- E2E harness code lives under `tests/e2e/`, not `src/`.
- Test files retain colocation with the modules they cover (under the new folders).
- `app-score-explanation.test.ts` becomes a normal import-based unit test.
- `tests/e2e/uatu.e2e.ts` splits into feature-named files matching the new `src/` folder names.
- A new `ARCHITECTURE.md` exists at the repo root describing the runtime, folder layout, request/state lifecycles, terminal subsystem, modes, and extension points — sufficient for a new contributor (or AI agent) to orient in one sitting.

**Non-Goals:**

- No refactoring of business logic, no API changes, no signature changes beyond what extraction strictly requires.
- No new abstractions speculatively introduced (no pane-manager primitive, no testing-utility package). YAGNI applies.
- No upgrade of dependencies, no change to the bundler config beyond path updates.
- No documentation of the easter-egg behavior — internal architecture docs only.
- Not redesigning the prod-vs-e2e auth split; the route extraction just moves duplication into one place.

## Decisions

### D1. Target folder layout

`src/` after the refactor:

```
src/
├── assets/                  ← unchanged
├── shell/                   ← boot, events, history, URL, connection, PWA, state
├── preview/                 ← markdown / asciidoc / mermaid / diff / image / metadata-card / anchors / code-block / view-mode / layout
├── sidebar/                 ← panes, tree-view, git-log, change-overview, files-filter, score-explanation, selection-inspector
├── terminal/                ← panel, client, server, auth, pty, backend, clipboard, config, pane-state
├── server/                  ← routes (NEW), session, watch, document, navigation, scope, statics
├── document/                ← document-metadata, document-diff, file-classify, file-languages, git-base-ref
├── render/                  ← markdown.ts, asciidoc.ts (rendering of source to HTML — distinct from preview's *mounting* of rendered HTML)
├── review/                  ← review-load (the score / change-overview data layer)
├── ignore/                  ← ignore-engine, uatuignore-warning
├── watchdog/                ← watchdog, watchdog-capture
├── debug/                   ← debug-cache, debug-metrics
├── pwa/                     ← pwa-assets test (the SW + manifest live in assets/)
├── shared/                  ← shared.ts, version.ts, license-check, heartbeat
├── app.ts                   ← thin wire-up; <200 lines target
├── cli.ts
├── index.html
└── styles.css / styles.d.ts
```

**Alternatives considered:**

- *Group by runtime (server/client/shared):* clean for a server-rendered SPA, but uatu's terminal feature spans both halves; splitting terminal across two folders fragments a coherent subsystem.
- *Group by tech (hooks/services/utils):* indistinct from a flat tree; doesn't help navigation.
- *Keep flat:* fails the AI-ergonomics criterion (4183-line `app.ts` continues to dominate any agent's context window per edit).

### D2. `app.ts` decomposition target

Four extraction zones with one new singleton:

| Source range in app.ts | Lines | Target |
|---|---|---|
| `const appState = { ... }` (≈ 279-336) | ~57 | `src/shell/state.ts` |
| `loadInitialState` (1006-1136) | 131 | `src/shell/boot.ts` |
| `connectEvents` (1138-1236) | 99 | `src/shell/events.ts` |
| `pushSelection/pushReviewScore/pushCommitPreview/popstate/scrollToFragment` (593-790) | 198 | `src/shell/history.ts` |
| URL resolvers (891-960) | 70 | `src/shell/url.ts` |
| `setConnectionState/syncConnectionDisplay` (3317-3343) | 27 | `src/shell/connection.ts` |
| `injectPwaLinks/SW registration` (971-1005) | 35 | `src/shell/pwa.ts` |
| Anchor handlers (447-590) | 143 | `src/preview/anchors.ts` |
| Mermaid trigger + theme inputs (1238-1268) | 31 | `src/preview/mermaid.ts` |
| Single/split rendering (1270-1475) | 206 | `src/preview/mount.ts` |
| Image / binary fallbacks (1477-1580) | 104 | `src/preview/image.ts`, `src/preview/binary.ts` |
| Metadata card (1581-1660) | 80 | `src/preview/metadata-card.ts` |
| Score-explanation (1664-1864) | 200 | `src/sidebar/score-explanation.ts` |
| Line numbers + copy buttons (1893-1960) | 68 | `src/preview/code-block.ts` |
| Sidebar render + pane state (2078-2470) | 393 | `src/sidebar/shell.ts` + `src/sidebar/panes.ts` |
| Change Overview + Git Log render (2471-2640) | 170 | `src/sidebar/change-overview.ts` + `src/sidebar/git-log.ts` |
| View / layout / diff sync (2647-3170) | 524 | `src/preview/view-mode.ts` + `src/preview/layout.ts` + `src/preview/diff.ts` |
| Mode + filter (3172-3320) | 149 | `src/shell/mode.ts` + `src/sidebar/files-filter.ts` |
| Sidebar collapse/width + build badge (3343-3445) | 103 | `src/sidebar/shell.ts` |
| `setupTerminalPanel` (3446-4170) | 724 | `src/terminal/panel.ts` |

`src/app.ts` after extraction: imports from each subfolder, mounts the four zones in the correct order, exports nothing. The total goal is a file you can read in one screen.

### D3. State module shape

`src/shell/state.ts` exports the singleton plus type guards:

```ts
export const appState = { /* ...same fields as today... */ };
export type AppState = typeof appState;
```

This is the minimum viable extraction. **It's still a module-level mutable** — we are not introducing a reactive store, a state-machine library, or pure-function reducers. Those would be separate, larger changes. The narrow goal is "make it importable so other modules can stop depending on app.ts."

**Alternatives considered:**

- *Pass `appState` as a function argument everywhere:* would touch every function signature in every extracted module. The cost-benefit doesn't clear the bar for a refactor that aims to be mechanical.
- *Switch to a signals / store library:* out of scope; would be its own proposal.

### D4. Route extraction

`src/server/routes.ts` exports a `buildRoutes` function:

```ts
export type BuildRoutesOptions = {
  mode: "prod" | "e2e";
  /* deps that vary between prod and e2e: watch session, terminal server,
     workspace root, auth handlers, idle timeout, etc. */
};

export function buildRoutes(deps: BuildRoutesOptions): Record<string, ...>;
```

Both call sites become:

```ts
// cli.ts
server = Bun.serve({
  port, hostname, idleTimeout: SERVE_IDLE_TIMEOUT_SECONDS,
  routes: buildRoutes({ mode: "prod", ...deps }),
  websocket: terminalServer?.websocketHandlers ?? undefined,
});

// tests/e2e/server.ts
server = Bun.serve({
  port: E2E_PORT, hostname, idleTimeout: SERVE_IDLE_TIMEOUT_SECONDS,
  routes: buildRoutes({ mode: "e2e", ...deps }),
  websocket: terminalServer?.websocketHandlers ?? undefined,
});
```

E2E-only routes (`/__e2e/terminal-token`, `/__e2e/reset`) are added when `mode === "e2e"`. The prod-only `/debug/metrics` route is added when `mode === "prod"`.

**Alternatives considered:**

- *Generalize prod server to accept a fixture-mode flag* (option 4 from the exploration): more ambitious — would eliminate `e2e-server.ts` entirely. Rejected for this change because it requires extending CLI semantics (`--mode e2e` is observable and auditable, so it needs its own design). Note as follow-up.
- *Leave duplication, only move file:* rejected because the duplication is the actual cost; moving the file without unifying routes preserves the drift hazard.

### D5. Rename `src/server.ts` → `src/server/session.ts`?

The current `src/server.ts` is a library of building blocks (createWatchSession, renderDocument, resolveWatchRoots, etc.), not "the server." Naming it `server.ts` is misleading.

Decision: **move to `src/server/session.ts`** alongside `src/server/routes.ts`. The whole `src/server/` folder is "things needed to serve uatu." The file currently called `server.ts` becomes one of several siblings under `server/` (with `routes.ts`, plus possible later splits for navigation, scope, statics).

**Alternatives considered:** keep `server.ts` and add `routes.ts` next to it — leaves the misleading name. Rename to `server-lib.ts` — clunky.

### D6. E2E harness location

Move `src/e2e-server.ts` → `tests/e2e/server.ts` and `src/e2e.ts` → `tests/e2e/config.ts`. Update `playwright.config.ts`:

```ts
webServer: { command: "bun run tests/e2e/server.ts", ... }
```

This is the conventional Node/TS layout: `src/` is product, `tests/` is everything for testing. Dependency direction stays one-way (tests/ → src/, never the reverse).

### D7. E2E file split

`tests/e2e/uatu.e2e.ts` splits along the same feature lines as the new `src/` folders:

```
tests/e2e/
├── config.ts                  ← was src/e2e.ts
├── server.ts                  ← was src/e2e-server.ts
├── tree-helpers.ts            ← unchanged
├── mermaid.e2e.ts             ← inline rendering + diagram viewer (~600 lines from uatu.e2e.ts)
├── sidebar.e2e.ts             ← collapse, panes, mode-specific panes
├── change-overview.e2e.ts     ← change overview + untracked indicators
├── git-log.e2e.ts             ← git log controls + commit preview URLs
├── ignore-policy.e2e.ts       ← .uatu.json, --no-gitignore, gitignored annotations
├── asciidoc.e2e.ts            ← AsciiDoc cheat sheet, TOC nav
├── code-blocks.e2e.ts         ← copy buttons, line numbers
├── follow-mode.e2e.ts         ← follow mode + manual selection
├── preview-renderers.e2e.ts   ← image / binary / single-file mode / connection indicator
├── files-pane-filter.e2e.ts   ← unchanged
├── document-tree.e2e.ts       ← unchanged
├── terminal.e2e.ts            ← unchanged
└── pwa.e2e.ts                 ← unchanged
```

Tests retain their original assertions and helpers. Shared setup that crosses files moves into `tests/e2e/tree-helpers.ts` or a new `tests/e2e/fixtures.ts` if duplication appears.

### D8. Ordering — extraction first, folder cosmetics last

```
1. tests/e2e split            ← independent, low-risk warmup
2. appState → shell/state.ts  ← unblocks every other extraction
3. score-explanation lift     ← deletes brace-counting test smell
4. boot + events lift         ← validates the shell seam
5. terminal panel lift        ← biggest single line-count win
6. route table extraction +   ← fixes the diff finding;
   e2e-server.ts move           also closes the file-location question
7. remaining file moves       ← cosmetic; do last when the
   into folders                 layout has stabilized
```

Each step is a separate commit. Steps 2-6 each must keep all tests green before the next begins. Step 7 is the cosmetic pass — it's where most of the import churn happens, but by then the file *shapes* are right.

**Alternative considered:** folders-first (step 7 before 2-6). Rejected because it produces import churn twice — once for the move, again when each extracted function leaves its origin file.

### D9. File-size guidance

The structure spec sets a *soft* target: aim for individual `.ts` files under ~500 lines, with the understanding that some files (e.g. `server/routes.ts` with all 14 routes inline) may legitimately exceed it. The rule is "if a file grows past 500 lines, ask whether it's doing one thing or several." Not a hard cap.

### D10. CLAUDE.md / agent guidance updates

This refactor is partly motivated by AI ergonomics. The change must update `CLAUDE.md` (and any sibling `AGENTS.md` / `.cursorrules` / `.opencode/` guidance) to reference the new folder structure and convention.

### D11. ARCHITECTURE.md onboarding document

A new `ARCHITECTURE.md` at the repo root captures the runtime architecture in a single document. Sections:

1. **What uatu is** — 3-sentence pitch ("a local Bun-served PWA that watches a docs tree and previews Markdown / AsciiDoc with a review-load score and an embedded terminal").
2. **The 30-second map** — single Mermaid `flowchart` showing CLI → Bun server → browser SPA → terminal subsystem, with the four big boundaries labelled.
3. **Folder tour** — annotated `src/` and `tests/e2e/` trees with one or two sentences per folder.
4. **Request lifecycle** — Mermaid `sequenceDiagram` for an `/api/document` fetch: browser → routes.ts → session → renderer → response. Mention SSE separately.
5. **State lifecycle** — Mermaid `sequenceDiagram` for an SSE state event: server emits → `events.ts` receives → mutates `appState` → re-renders preview / sidebar.
6. **Terminal subsystem** — Mermaid `flowchart` for xterm.js ↔ WebSocket ↔ PTY plus the cookie-auth gate.
7. **Review vs Author modes** — a small table of what each mode changes, with pointers into `src/shell/mode.ts`.
8. **How to extend** — concrete recipes: adding a new sidebar pane, supporting a new file kind, adding a route, adding an E2E test.
9. **Run & test** — `bun run dev`, `bun test`, `bun test:e2e`, `bun run build`, `bun run check:licenses`.

**Format choice — Mermaid in Markdown.** GitHub renders it inline, uatu renders it natively in the preview pane, AI tools read it as text. No build step, no separate `.svg` files to maintain. The doc lives in the repo so it ages with the code.

**Cross-references.** `README.md` gains a "For contributors → see ARCHITECTURE.md" line. `CLAUDE.md` gains a one-line pointer at the top. Specific source paths in the doc must match the post-refactor layout.

**Timing.** Written last, after step 9 (folder cosmetics) has stabilized. Writing it earlier means rewriting it.

**Alternatives considered:**

- *ASCII diagrams only:* readable everywhere, but Mermaid is strictly better when the rendering tool exists (and uatu IS the rendering tool). ASCII is fine as a fallback for tabular data.
- *Separate docs/ folder with multiple files:* premature; ten pages of architecture doc deserve splitting, but the initial ARCHITECTURE.md will be one focused file.
- *ADRs (Architectural Decision Records):* deferred. The OpenSpec change history already captures decisions per change; a parallel ADR folder would duplicate. Revisit if the project takes outside contributors.

## Risks / Trade-offs

- **[Wide-blast import churn]** → All extractions are mechanical and tooled (`tsc --noEmit` + `bun test`). Order steps so each individual commit is reviewable.
- **[`appState` extraction leaves a singleton]** → Acknowledged in D3 as a deliberate scope limit. Document in `src/shell/state.ts` that this is a transitional shape, not the long-term target.
- **[Route extraction introduces conditional logic (`mode: "prod" | "e2e"`)]** → The conditional is explicit and small. The alternative (full generalization to runtime flags) is a larger separate proposal; bundling it here would scope-creep the refactor.
- **[E2E split might miss shared test setup]** → After splitting, run the full E2E suite and watch for any test that was implicitly depending on side effects from an earlier test in the same file. The repo already runs Playwright with `fullyParallel: false` and `workers: 1`, so global state hazards are bounded.
- **[`tests/e2e/server.ts` imports from `src/server/`]** → Acceptable: tests-to-source is the conventional dependency direction. Add an ESLint rule (or doc-only convention) that `src/` MUST NOT import from `tests/`.
- **[Bundler / build path drift]** → `scripts/build.ts` may reference specific source paths. Audit after step 7 and update.
- **[Two PRs touching app.ts conflict heavily]** → Each step's commit must land before the next is opened. Avoid parallel work on app.ts during the migration window.
- **[Agent-readable architecture docs may go stale]** → Update CLAUDE.md and any agent guidance files as part of the change (D10). Add a check to the verify step.

## Migration Plan

- Each step in D8 is a separate commit on a single feature branch.
- After each commit, `bun test` and `bun test:e2e` must pass.
- The change is reverted by branch reset if any single step destabilizes the build; partial progress is acceptable to keep.
- No data migration, no schema change, no config-file format change.
- No coordinated release. Internal refactor only; no release notes entry beyond a one-line CHANGELOG mention.

## Open Questions

- **`render/` vs `preview/` naming**: is the file currently named `markdown.ts` (which produces HTML from Markdown source) better placed in `render/` (alongside `asciidoc.ts`) or `preview/` (alongside mount + view-mode)? The current draft places them under `render/` because they're the source-to-HTML transformation, while `preview/` deals with mounting that HTML into the DOM. Confirm before step 7.
- **`pwa/` folder**: only one test file (`pwa-assets.test.ts`). Worth a folder or move to `shared/`?
- **`heartbeat.test.ts` location**: only the test exists in `src/`. Is the heartbeat *implementation* somewhere already (`watchdog.ts`?) or is the test orphaned? Audit.
- **Terminal panel `setupTerminalPanel` boundary**: it currently uses several module-local `terminalSetupRan` flags. Confirm that lifting to `terminal/panel.ts` doesn't change observable boot-once semantics.
