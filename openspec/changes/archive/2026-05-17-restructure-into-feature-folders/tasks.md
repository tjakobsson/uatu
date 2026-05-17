## 1. E2E Split (warmup, independent)

Cataloging revealed 15 feature buckets (113 tests), not 9. Added: mode, url-routing, metadata-card, selection-inspector, view-and-layout, diff-view. File names mirror existing `openspec/specs/` capability names.

- [x] 1.1 Catalog every `test(...)` block in `tests/e2e/uatu.e2e.ts` and tag each with a feature (mermaid, sidebar, change-overview, git-log, ignore-policy, asciidoc, code-blocks, follow-mode, preview-renderers, mode, url-routing, metadata-card, selection-inspector, view-and-layout, diff-view) — actual source contained 115 tests, not 113
- [x] 1.1a Create `tests/e2e/fixtures.ts` exposing the shared `beforeEach` setup and `waitForPreviewToSettle` / `sidebarPanesFitVisibleHeight` helpers
- [x] 1.2 Create `tests/e2e/mermaid.e2e.ts` (13 tests)
- [x] 1.3 Create `tests/e2e/sidebar.e2e.ts` (3 tests)
- [x] 1.4 Create `tests/e2e/change-overview.e2e.ts` (12 tests)
- [x] 1.5 Create `tests/e2e/git-log.e2e.ts` (2 tests)
- [x] 1.6 Create `tests/e2e/ignore-policy.e2e.ts` (2 tests)
- [x] 1.7 Create `tests/e2e/asciidoc.e2e.ts` (6 tests)
- [x] 1.8 Create `tests/e2e/code-blocks.e2e.ts` (2 tests)
- [x] 1.9 Create `tests/e2e/follow-mode.e2e.ts` (4 tests)
- [x] 1.10 Create `tests/e2e/preview-renderers.e2e.ts` (11 tests)
- [x] 1.10a Create `tests/e2e/mode.e2e.ts` (20 tests)
- [x] 1.10b Create `tests/e2e/url-routing.e2e.ts` (12 tests)
- [x] 1.10c Create `tests/e2e/metadata-card.e2e.ts` (4 tests)
- [x] 1.10d Create `tests/e2e/selection-inspector.e2e.ts` (8 tests)
- [x] 1.10e Create `tests/e2e/view-and-layout.e2e.ts` (9 tests)
- [x] 1.10f Create `tests/e2e/diff-view.e2e.ts` (7 tests)
- [x] 1.11 Run `bun test:e2e` with both `uatu.e2e.ts` and the new files present (277 tests, all green — proves the split preserves coverage)
- [x] 1.12 Delete `tests/e2e/uatu.e2e.ts`
- [x] 1.13 Run `bun test:e2e` (162 passing); commit bbda920

## 2. Lift appState to shell/state.ts

- [x] 2.1 Create `src/shell/` directory
- [x] 2.2 Create `src/shell/state.ts` exporting `appState` and the `AppState` type (also moves: `safeLocalStorage`, `PreviewMode`, pane infrastructure types/consts, `readPaneState`/`defaultPaneState`, `FilesPaneFilter` cluster, `readGitLogLimitPreference`/`isGitLogLimit` — all the things appState's initialization depends on)
- [x] 2.3 Replace the in-`app.ts` `appState` declaration with `import { appState, ... } from "./shell/state"`; remove moved declarations from app.ts
- [x] 2.4 Run `bun test` (553 passing) and `bun test:e2e` (162 passing); commit

## 3. Lift score-explanation to sidebar/score-explanation.ts

- [x] 3.1 Create `src/sidebar/` directory
- [x] 3.2 Move `buildScoreExplanationHTML` and its pure-function helpers (`renderReviewConfigurationList`, `renderScoreDriverList`, `renderScoreDriverItem`, `renderConfiguredAreaItem`, `mechanicalDriverHelp`) from `app.ts` to `src/sidebar/score-explanation.ts`. `renderReviewScoreDetails` (DOM-coupled) and `renderCommitMessage` / `curatedRow` (unrelated to score rendering) stay in app.ts. `escapeHtml` / `escapeHtmlAttribute` / `capitalize` duplicated as locals in the new module — a future `shared/html.ts` move will deduplicate.
- [x] 3.3 Export `buildScoreExplanationHTML` (the only function `app.ts` still needs to call)
- [x] 3.4 Update `app.ts` to import from `./sidebar/score-explanation`; remove the moved declarations
- [x] 3.5 Move `src/app-score-explanation.test.ts` to `src/sidebar/score-explanation.test.ts` and rewrite as an import-based test that exercises `buildScoreExplanationHTML` directly. The brace-counting helpers and source-file reads are gone; the Mode-independence property is now asserted on actual output (6 tests, up from 3).
- [x] 3.6 Run `bun test` (556 passing, +3 from new tests); commit

## 4. Lift shell/boot + shell/events

- [x] 4.1 Move `loadInitialState` to `src/shell/boot.ts` (162 lines)
- [x] 4.2 Move `connectEvents` to `src/shell/events.ts` (126 lines)
- [x] 4.3 Cross-references to renderers still in app.ts (renderSidebar, loadDocument, renderEmptyPreview, etc.) are imported from `../app` for now — section 6 will move those to their proper feature folders. 14 functions in app.ts gained `export`: `applyStaleHint`, `findDocumentById`, `findDocumentByRelativePath`, `forgetDocumentCache`, `loadDocument`, `renderCommitMessage`, `renderEmptyPreview`, `renderReviewScoreDetails`, `renderSidebar`, `setupTerminalPanel`, `syncFilesPaneFilterControl`, `syncFollowToggle`, `syncModeControl`, `syncStateGeneration`.
- [x] 4.4 `app.ts` now imports each shell function from its new home and invokes via named imports
- [x] 4.5 Move history routing to `src/shell/history.ts` (207 lines: pushSelection, pushReviewScore, pushCommitPreview, replaceSelection, scrollToFragment, buildDocumentPath, buildCommitPreviewPath, cssEscape, popstate handler wrapped as `attachPopstateHandler()`)
- [x] 4.6 Move URL resolvers to `src/shell/url.ts` (90 lines: reviewScoreRepositoryIdFromUrl, commitPreviewParamsFromUrl, resolveCommitPreview, activateCommitPreview, renderCommitPreview, renderCommitPreviewUnavailable + CommitPreviewParams/Resolution types)
- [x] 4.7 Move connection helpers to `src/shell/connection.ts` (64 lines: ConnectionRawState type, setConnectionState, syncConnectionDisplay, renderBuildBadge)
- [x] 4.8 Move PWA helpers to `src/shell/pwa.ts` (43 lines: injectPwaLinks + service-worker registration wrapped as `registerServiceWorker()`)
- [x] 4.9 Run `bun test` (556 passing) and `bun test:e2e` (162 passing); commit e11f081. **app.ts shrunk 3879 → 3342 (-537 lines, -14%). tsc errors went 212 → 205 (-7, narrowing improvements from extraction).**

## 5. Lift terminal/panel.ts and unify the terminal/ folder

- [x] 5.1 Create `src/terminal/` directory
- [x] 5.2 Move `setupTerminalPanel` (now 748 lines including the helper consts and types it depends on) to `src/terminal/panel.ts`; exported
- [x] 5.3 `escapeHtml` / `escapeHtmlAttribute` not duplicated — `setupTerminalPanel` doesn't reference them, so they stay in app.ts (used by 20+ call sites still in app.ts)
- [x] 5.4 `git mv src/terminal.ts → src/terminal/client.ts`
- [x] 5.5 `git mv src/terminal-server.ts → src/terminal/server.ts`
- [x] 5.6 `git mv src/terminal-auth.ts → src/terminal/auth.ts`
- [x] 5.7 `git mv src/terminal-pty.ts → src/terminal/pty.ts`
- [x] 5.8 `git mv src/terminal-backend.ts → src/terminal/backend.ts`
- [x] 5.9 `git mv src/terminal-clipboard.ts → src/terminal/clipboard.ts`
- [x] 5.10 `git mv src/terminal-config.ts → src/terminal/config.ts`
- [x] 5.11 `git mv src/terminal-pane-state.ts → src/terminal/pane-state.ts`
- [x] 5.12 Each `*.test.ts` moved alongside its subject (terminal-integration.test.ts → integration.test.ts; terminal-token.test.ts → token.test.ts — these are integration tests without a direct source-file match). Test imports updated; one fix: `terminal/token.test.ts`'s `createWatchSession` import points at root `../server`, not the sibling `./server`.
- [x] 5.13 `app.ts` re-exports `setupTerminalPanel` from `./terminal/panel` because `shell/boot.ts` imports it from `../app`. Plain import works for app.ts's own call site too.
- [x] 5.14 Run `bun test` (556 passing) and `bun test:e2e` (162 passing — one flake on `document-tree.e2e.ts:231` on the first run, passed in isolation and on re-run, unrelated to this change); commit 2b5044c. **app.ts now 2617 lines (cumulative -1566 / -37% from original 4183). src/terminal/ holds 18 files.**

## 6. Extract preview/ and sidebar/ modules from app.ts

Done in 6 cohesive batches, tsc verified between each. Batch breakdown:
- Batch 1: preview/ rendering pipeline (anchors, mermaid, mount, image, binary, metadata-card, code-block, header)
- Batch 2: preview/ view-mode + layout + diff
- Batch 3: sidebar/ (panes, shell, change-overview, git-log, files-filter, tree-mount, selection-inspector-mount)
- Batch 4: shell/ completions (mode, stale-hint-mount, follow)
- Batch 5: shell/storage utilities
- Batch 6: final wire-up

- [x] 6.1 `src/preview/anchors.ts` (168 lines: in-page + cross-doc anchor handlers, cssEscape, `installAnchorHandlers()` boot wrapper)
- [x] 6.2 `src/preview/mermaid.ts` (37 lines: handleMermaidTriggerClick, currentMermaidThemeInputs)
- [x] 6.3 `src/preview/mount.ts` (335 lines: document payload cache, applyDocumentPayload, single/split rendering, loadDocument, fetchDocumentView, RenderedDocument + metadata types)
- [x] 6.4 `src/preview/image.ts` (67 lines) and `src/preview/binary.ts` (29 lines)
- [x] 6.5 `src/preview/metadata-card.ts` (120 lines: render + open-state persistence + toggle listener)
- [x] 6.6 `src/preview/code-block.ts` (137 lines: line numbers + copy buttons + showCopyConfirmation + copyToClipboard) and `src/preview/header.ts` (65 lines: setPreviewType / clearPreviewType / setPreviewBase)
- [x] 6.7 `src/preview/view-mode.ts` (181 lines: view-toggle sync, hideViewToggle, applyViewMode, extensionToLanguage) and `src/preview/diff.ts` (150 lines)
- [x] 6.8 `src/preview/layout.ts` (241 lines: layout chooser, split resizer, auto-stack observer)
- [x] 6.9 `src/sidebar/panes.ts` (277 lines: pane mount/persist/visibility — the data types like PaneId stayed in shell/state.ts per section 2)
- [x] 6.10 `src/sidebar/shell.ts` (221 lines: renderSidebar, sidebar collapse + width, build badge wiring)
- [x] 6.11 `src/sidebar/change-overview.ts` (204 lines)
- [x] 6.12 `src/sidebar/git-log.ts` (107 lines: render + initGitLogControls + persistGitLogLimit + baseModeLabel + capitalize)
- [x] 6.13 `src/sidebar/files-filter.ts` (53 lines: applyFilesPaneFilter + syncFilesPaneFilterControl)
- [x] 6.14 `src/sidebar/tree-mount.ts` (56 lines: ensureTreeView + disposeTreeView + handleTreeSelectDocument + the tree-view singleton)
- [x] 6.15 `src/sidebar/selection-inspector-mount.ts` (50 lines: the renderSelectionInspector DOM glue; the library file at `src/selection-inspector.ts` is unrelated and stays at root until section 9)
- [x] 6.16 `src/shell/mode.ts` (134 lines: applyMode + syncModeControl + primaryReviewBaseLabel)
- [x] 6.17 `src/shell/stale-hint-mount.ts` (48 lines: applyStaleHint + syncStaleHint. `-mount` suffix to distinguish from the library file `src/stale-hint.ts` which stays at root until section 9)
- [x] 6.18 `src/shell/follow.ts` (43 lines: syncFollowToggle)
- [x] 6.19 `copyToClipboard` + `showCopyConfirmation` landed in `src/preview/code-block.ts` alongside the copy-button helpers (most cohesive location)
- [x] 6.20 `src/shell/storage.ts` (59 lines: activeDocumentPath, isPreviewSourceView, findDocumentByRelativePath, findDocumentById, syncStateGeneration)
- [x] 6.21 Run tests + commit a9b4a8c. **app.ts shrunk 2617 → 417 lines (-2200, -84%). Cumulative since section 1: 4183 → 417 (-90%). tsc errors went 205 → 67 (-138 — new files use locally-aliased DOM refs that narrow correctly inside function bodies, which the old hoisted-function declarations in app.ts couldn't).**

## 7. Extract route table to server/routes.ts

- [x] 7.1 `git mv src/server.ts → src/server/session.ts` (1477 → 1479 lines; +2 for a `WatchSession` type alias export that `routes.ts` needs)
- [x] 7.2 `git mv src/server.test.ts → src/server/session.test.ts`
- [x] 7.3 Create `src/server/routes.ts` (231 lines) exporting `buildRoutes(deps)` with a clean discriminated-union deps shape: `BuildRoutesDeps = ProdRouteDeps | E2ERouteDeps` where each branch shares `{ assets, getSession }` and adds mode-specific fields (`debug`/`getMetricsSnapshot` for prod, `handleE2EReset` for e2e)
- [x] 7.4 Lifted the route table from `cli.ts` into `buildRoutes`. The session is taken as a factory (`() => WatchSession`) so e2e-server can rebuild it across `/__e2e/reset` calls.
- [x] 7.5 Prod mode adds `/debug/metrics` (gated by `deps.debug`; otherwise returns 404)
- [x] 7.6 E2E mode adds `/__e2e/terminal-token` and `/__e2e/reset` (the reset handler is taken from `deps.handleE2EReset`, factored out of the inline e2e-server route)
- [x] 7.7 `src/cli.ts` shrunk 657 → 535 (-122). Now calls `Bun.serve({ routes: buildRoutes({ mode: "prod", ... }), ... })`. `fetch:` and `websocket:` handlers stay inline (they close over call-site-local state — `terminalServer`, `navigationFetch`)
- [x] 7.8 `src/e2e-server.ts` shrunk 409 → 292 (-117). Same shape, `mode: "e2e"`
- [x] 7.9 Run `bun test` (556 passing) and `bun test:e2e` (162 passing modulo a flake); commit 225f6d4. **Route literals like `"/api/state"` now appear only inside `src/server/routes.ts` (verified by grep). Spec requirement "the HTTP route table is declared in exactly one place" is satisfied.** (A follow-up fix in commit 9110071 had to spread `buildRoutes(...)` inside an inline routes literal at the call site so Bun's compile-mode bundler could still wire up the HTMLBundle chunk URLs — the route literals still live in routes.ts, the `"/": index` mapping is inline at the call sites.)

## 8. Move E2E harness to tests/e2e/

- [x] 8.1 `git mv src/e2e-server.ts → tests/e2e/server.ts`; updated 14 relative imports (`./assets/*`, `./index.html`, `./review-load`, `./shared`, `./server/session`, `./server/routes`, `./terminal/auth`, `./terminal/backend`, `./terminal/server`) to `../../src/*`. Sibling `./e2e` → `./config`.
- [x] 8.2 `git mv src/e2e.ts → tests/e2e/config.ts` (the file has only `node:fs` / `node:path` imports, no relative imports to update)
- [x] 8.3 `playwright.config.ts` updated: `import { E2E_PORT } from "./tests/e2e/config"` and `command: "bun run tests/e2e/server.ts"`
- [x] 8.4 Updated 10 `tests/e2e/*.e2e.ts` files that imported `workspacePath` from `../../src/e2e` to import from `./config` instead. Grep confirms no remaining `src/e2e*` references in source or config.
- [x] 8.5 Run `bun test:e2e` (161 passing + the document-tree.e2e.ts:231 flake); commit 5e1c2d9. **src/ now contains only product code. The spec requirement "src/ contains shipped product code only" is satisfied — `src/e2e-server.ts` and `src/e2e.ts` no longer exist; the harness lives next to the tests it serves.**

## 9. Fold remaining flat files into feature folders

**Done in one mechanical pass.** `src/` root now contains only the three entrypoints (`app.ts`, `cli.ts`, `styles.d.ts`), shared static resources (`index.html`, `styles.css`, `assets/`), and 13 feature folders.

**Resulting folder layout:**
- `src/debug/` (6 files): cache, metrics, metrics-route.test, heartbeat.test
- `src/document/` (9 files): metadata, diff, classify, languages, git-base-ref + tests
- `src/ignore/` (4 files): engine, warning + tests
- `src/preview/` (14 files): rendering + mounting (now incl. mermaid-viewer, diff-view)
- `src/pwa/` (1 file): assets.test
- `src/render/` (6 files): markdown, asciidoc, preview (sanitizer) + tests
- `src/review/` (2 files): load + test
- `src/server/` (5 files): routes, session, port-probe + tests
- `src/shared/` (7 files): html, types (formerly `shared.ts`), license-check, version + tests
- `src/shell/` (13 files): boot, events, history, url, connection, pwa, mode, follow, state, storage, stale-hint, stale-hint-mount + 1 test
- `src/sidebar/` (15 files): tree-view, tree-config, selection-inspector + the section-6 panes
- `src/terminal/` (18 files): full subsystem from section 5
- `src/watchdog/` (4 files): main, capture + tests


- [x] 9.1 `src/document-metadata*` → `src/document/metadata*`
- [x] 9.2 `src/document-diff*` → `src/document/diff*`
- [x] 9.3 `src/document-diff-view*` → `src/preview/diff-view*` (view, not data — under preview/)
- [x] 9.4 `src/file-classify*` → `src/document/classify*`
- [x] 9.5 `src/file-languages.ts` → `src/document/languages.ts`
- [x] 9.6 `src/git-base-ref*` → `src/document/git-base-ref*`
- [x] 9.7 `src/markdown*` → `src/render/markdown*`
- [x] 9.8 `src/asciidoc*` → `src/render/asciidoc*`
- [x] 9.9 `src/mermaid-viewer.ts` → `src/preview/mermaid-viewer.ts`
- [x] 9.10 `src/preview*` → `src/render/preview*` (sanitization + Mermaid replacement)
- [x] 9.11 `src/review-load*` → `src/review/load*`
- [x] 9.12 `src/ignore-engine*` → `src/ignore/engine*`
- [x] 9.13 `src/uatuignore-warning*` → `src/ignore/warning*`
- [x] 9.14 `src/watchdog*` (the main file) → `src/watchdog/main*` (preferred over `index.ts` because index.ts colocated with `*.test.ts` is confusing)
- [x] 9.15 `src/watchdog-capture*` → `src/watchdog/capture*`
- [x] 9.16 `src/debug-cache*` → `src/debug/cache*`
- [x] 9.17 `src/debug-metrics*` → `src/debug/metrics*`
- [x] 9.18 `src/debug-metrics-route.test.ts` → `src/debug/metrics-route.test.ts`
- [x] 9.19 `src/tree-view*` → `src/sidebar/tree-view*`
- [x] 9.20 `src/tree-config*` → `src/sidebar/tree-config*`
- [x] 9.21 `src/selection-inspector*` → `src/sidebar/selection-inspector*`
- [x] 9.22 `src/stale-hint*` → `src/shell/stale-hint*` (companion to the existing `shell/stale-hint-mount.ts` from section 6; the library file is `stale-hint.ts`, the DOM glue stays `stale-hint-mount.ts`)
- [x] 9.23 `src/heartbeat.test.ts` → `src/debug/heartbeat.test.ts` (the test uses `createCachePaths` from debug-cache and `start1HzSnapshotTick` from debug-metrics — landed in debug/ not watchdog/)
- [x] 9.24 `src/pwa-assets.test.ts` → `src/pwa/assets.test.ts` (one non-import fix: the test's `__dirname`-relative path got bumped one level up to still resolve `../assets`)
- [x] 9.25 `src/license-check*` → `src/shared/license-check*`. **`package.json` `check:licenses` script updated**: `bun run src/license-check.ts` → `bun run src/shared/license-check.ts`
- [x] 9.26 `src/version*` → `src/shared/version*`
- [x] 9.27 `src/shared.ts` → `src/shared/types.ts` (renamed to avoid `src/shared/shared.ts` redundancy)
- [x] 9.28 `src/port-probe*` → `src/server/port-probe*`
- [x] 9.29 Run `bun test` (556 passing) and `bun test:e2e` (162 passing, no flakes this run); commit 1a782f9. **app.ts root size: 405 lines. cli.ts: 535. styles.d.ts: 4. Total non-folder content at `src/` root: 944 lines of code across 3 entrypoint files. The 90% reduction from 4183 lines is now distributed across 13 feature folders.** (Final app.ts reduction to 133 lines came later in commits f767da7 and 9110071.)

## 10. Update build, docs, and configuration

- [x] 10.1 `scripts/build.ts` was already updated by section 9's agent to reference `../src/shared/version` and `src/cli.ts` (entry). Other paths in scripts/ are CLI-shaped, no further changes needed.
- [x] 10.2 `tsconfig.json` uses `"include": ["src/**/*.ts"]` — globs naturally cover the new folder layout. `bun test` discovers `*.test.ts` via Bun's default and also works under any depth.
- [x] 10.3 `README.md` references were audited: `bun run src/cli.ts watch ...` (still correct, entrypoint unchanged) and example `.uatu.json` paths like `src/auth/**` (just illustrative config, not real paths). No changes needed.
- [x] 10.4 **Created `CLAUDE.md` at repo root.** Describes the `src/` folder taxonomy with the one-line purpose of each folder, the entrypoints, and the conventions: src/ is product code only, tests are colocated, the route table is single-source-of-truth, appState lives in `shell/state.ts`, cross-cutting helpers live in `shared/`. Includes the `bun run dev / test / test:e2e / build / check:licenses` commands.
- [x] 10.5 `.opencode/` contains OpenSpec skills, not architecture guidance — no update needed. No `AGENTS.md` exists.
- [x] 10.6 Added `### Internal` section to the Unreleased block in CHANGELOG.md describing the refactor in one paragraph (4183 → 405 line shrinkage, 13 folders, route-table single source, E2E split, no user-visible behavior change).
- [x] 10.7 Run `bun run check:licenses` (337 packages audited, OK), `bun test` (556 passing), `bun test:e2e` (162 passing); commit 001af3a.

## 11. Verify against spec scenarios

Walked through each requirement scenario in `specs/module-structure/spec.md`. All scenarios satisfied.

- [x] 11.1 Each spec scenario walked through; results below.
- [x] 11.2 `"/api/state"`: only declared as a route-table key in `src/server/routes.ts`. The one other occurrence (in `src/shell/boot.ts`) is the client-side `fetch("/api/state")` call — a consumer of the route, not a redeclaration. Spec intent satisfied.
- [x] 11.3 `const appState = {`: appears only in `src/shell/state.ts`.
- [x] 11.4 No `src/terminal-*.ts` files at the `src/` root (all 18 terminal files moved to `src/terminal/` in section 5).
- [x] 11.5 `src/app.ts` is **189 lines** (under the 200-line target). Reached by extracting the four big click handlers + three render functions into their feature folders in the final pass.
- [x] 11.6 `tests/e2e/uatu.e2e.ts` does not exist (split into 15 feature-named files in section 1).
- [x] 11.7 `src/e2e-server.ts` and `src/e2e.ts` do not exist (moved to `tests/e2e/server.ts` and `tests/e2e/config.ts` in section 8).
- [x] 11.8 `playwright.config.ts` references `tests/e2e/server.ts` as its `webServer.command`.
- [x] 11.9 `src/sidebar/score-explanation.test.ts` imports `buildScoreExplanationHTML` directly via `import { buildScoreExplanationHTML } from "./score-explanation"` — no `readFile(app.ts)` or brace-counted body extraction.
- [x] 11.10 `src/` has no imports from `tests/` (verified by grep — the dependency direction is one-way as the spec requires).

## 12. Write ARCHITECTURE.md (onboarding document)

- [x] 12.1 Created `ARCHITECTURE.md` (327 lines) at repo root with all nine sections.
- [x] 12.2 Section 1 (What uatu is): 3-sentence pitch — local Bun-served PWA, Markdown/AsciiDoc + Mermaid, review-burden score, embedded terminal.
- [x] 12.3 Section 2 (30-second map): Mermaid flowchart showing CLI → server → SPA → terminal, plus chokidar→server and the PTY boundary. Four-line summary of the four transports (HTTP, SSE, WS, chokidar).
- [x] 12.4 Section 3 (Folder tour): annotated tree of every `src/` folder with one-line per file purpose. Reflects the post-refactor layout exactly.
- [x] 12.5 Section 4 (Request lifecycle): Mermaid sequenceDiagram for `/api/document?id=...` showing browser → routes → session → render/markdown → response. Plus a second Mermaid sequence for the SSE `/api/events` stream. Failure paths (404, 415) called out.
- [x] 12.6 Section 5 (State lifecycle): Mermaid sequenceDiagram for an SSE state event mutating `appState` and the Mode-gate that prevents Review from swapping the active preview.
- [x] 12.7 Section 6 (Terminal subsystem): Mermaid flowchart of xterm.js ↔ WebSocket ↔ PTY plus the cookie-auth gate and the Bun PTY availability check.
- [x] 12.8 Section 7 (Modes): table comparing Author vs Review across Follow defaults, file-system event handling, stale-hint, Files-pane filter, pane visibility, sidebar headline, visual cues.
- [x] 12.9 Section 8 (How to extend): four concrete recipes — new sidebar pane, new file kind, new HTTP route, new e2e test.
- [x] 12.10 Section 9 (Run & test): all five primary `bun run` commands plus tighter-loop variants (single test, single e2e, `--no-gitignore`, `--mode review` boot).
- [x] 12.11 Added "For contributors" section to `README.md` linking to `ARCHITECTURE.md` (and to `CLAUDE.md` as the quick-reference variant).
- [x] 12.12 `CLAUDE.md` (created in section 10) already opens with "See `ARCHITECTURE.md` for the deeper picture..."
- [x] 12.13 Path-existence audit: every `src/...` path mentioned in `ARCHITECTURE.md` exists in the tree. (Three apparent false positives — `src/index`, `src/sidebar/git-log`, `src/sidebar/your-pane` — are regex artifacts where the matcher dropped the `.html` / `.test.ts` extension or matched a hypothetical placeholder.)
- [x] 12.14 5 ```` ```mermaid ```` blocks present (spec requires ≥ 4). Eats own dogfood — `bun run dev` rendering of ARCHITECTURE.md will exercise the same Mermaid pipeline that other repo `*.md` files use.
- [x] 12.15 Reviewed end-to-end. Doc explains *where things live* and *how pieces talk*, not what code does line-by-line. Examples (e.g., 700-line `terminal/panel.ts`) reference source paths instead of reproducing function bodies.
