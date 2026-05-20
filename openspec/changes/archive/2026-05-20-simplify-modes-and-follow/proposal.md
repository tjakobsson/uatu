## Why

The Author / Review Mode distinction has accumulated coordination cost that exceeds its product value. The same boolean — `appState.followEnabled` — is currently written from eight+ call sites because each one has to reconcile Mode + scope kind + URL state + tree-library callbacks. That reconciliation surface is the substrate of two recurring flaky e2e tests (issue #45 and the `follow-mode auto-switch` flake on main CI run 26170946651), and of a sizable per-mode persistence subsystem that doubles the size of the e2e suite without doubling its coverage. The product UX has also drifted: the in-UI "pin" affordance is already gone, "Review mode" overlaps with what users do anyway when they look at a diff, and the natural agent-collaboration workflow — *let me see whichever file the agent just touched* — is exactly what Follow already does on its own. Simplifying to a single mode with Follow as the only behavioral toggle aligns the model with how the tool is used, collapses the race surface, and lets ~25–35 e2e tests be deleted.

## What Changes

- **BREAKING** Remove the Author / Review Mode concept entirely. The top-level Mode segmented control, mode-dependent sidebar brand chrome, mode-dependent connection indicator, and mode-aware preview chrome are deleted.
- **BREAKING** Remove the `--mode=author|review` CLI flag from `uatu watch`. The flag is silently ignored (warning printed) for one release, then removed.
- **BREAKING** Remove per-Mode persistence of pane visibility / sizing and the Files-pane `All / Changed` filter. A single set of preferences applies, migrating from the prior Author-mode key on first boot.
- Introduce a new `follow-mode` capability that owns the toggle's behavior, write-sites, and reaction to SSE file events. The capability defines four rules:
  1. **User clicks a tree row** → selection moves to that file, follow turns off.
  2. **User clicks the Follow chip** → follow toggles. Turning on jumps to the newest changed file in the current session.
  3. **File changes on disk + follow on** → selection moves to the changed file.
  4. **File changes on disk + follow off** → selection unchanged; if the changed file IS the selection, reload it in place; otherwise just refresh the tree.
- Tighten the user-vs-programmatic distinction in tree mount: `handleTreeSelectDocument` MUST only flip `followEnabled = false` when the callback originates from a real user click, not when `@pierre/trees` fires it for initial / programmatic selection.
- All previously Review-only sidebar panes (`Change Overview`, `Git Log`, the Diff view) remain available in the single-mode app. They become always-available panes the user can toggle in/out via the existing per-pane visibility controls.
- The review-load score's headline label collapses to a single mode-independent label.
- The Diff view's mode-dependent refresh behavior (Author-mode auto-refresh vs. Review-mode stale-content hint) collapses to a single behavior: auto-refresh on disk change.
- Boot semantics preserved: first selection is the newest-mtime file (today's behavior), Follow defaults ON, URL direct links (`/some/file.md`) force Follow OFF on arrival.
- The CLI single-file invocation (`uatu watch some-file.md`) survives. That is a watch-scope concept independent of the deleted UI-mode concept.

## Capabilities

### New Capabilities

- `follow-mode`: Owns the Follow toggle's behavior, the single boolean `followEnabled`, the four authoritative rules linking selection / file events / clicks, and the user-vs-programmatic distinction at the tree-mount callback boundary.

### Modified Capabilities

- `sidebar-shell`: Remove the "Provide a top-level Author/Review Mode control", "Compose sidebar panes per Mode with independent persistence", and "Make the active Mode visually unambiguous" requirements. Remove Mode-dependent clauses from "Render review-load summary in the Change Overview pane" (single headline label) and "Render bounded commit history in the Git Log pane".
- `document-routing`: Remove the "pinned scope" branch from "Open a document by direct URL" (no in-UI pinning concept; CLI single-file scope handles the equivalent case via its own message). Keep "Force follow mode off when arriving via a direct document URL" — that behavior survives unchanged.
- `document-diff-view`: Replace the "Diff view participates in Author auto-refresh and Review stale-content hints" requirement with a single mode-independent behavior: auto-refresh on disk change. Remove the "Diff view selection is not captured by the Selection Inspector" scenario's Review-mode framing.
- `watch-cli-startup`: Remove the `--mode=author|review` flag from the CLI surface.

## Impact

**Code deleted entirely**
- `src/shell/mode.ts` (whole file)
- `appState.mode` field and the `Mode` type in `src/shared/types.ts`
- Mode UI markup in `src/index.html` (mode segmented control, mode pill, mode-aware brand subtitle)
- Per-mode storage keys: `PANES_KEY_PREFIX_*`, `FILES_PANE_FILTER_KEY_PREFIX`, and the migration shims that read them
- The `--mode=author|review` flag handler in `src/cli.ts`
- Mode-dependent review-burden headline switching in `src/sidebar/change-overview.ts` and `src/shared/types.ts`

**Code simplified in place**
- `src/shell/boot.ts` collapses from six mode/scope-aware branches setting `followEnabled` to two (default `/` and URL direct-link).
- `src/shell/events.ts` collapses the `mode === "review"` branch out of the SSE handler — a single non-branching event-driven path remains.
- `src/sidebar/tree-mount.ts:47` gains an explicit user-click guard so library-fired initial-mount callbacks no longer race with boot's `followEnabled = true`.
- `src/sidebar/panes.ts` drops `paneDefsForMode` in favor of a single pane registry.
- `src/sidebar/files-filter.ts` reads/writes a single preference key.

**E2E surface**
- `tests/e2e/mode.e2e.ts` (~20 tests) deletes entirely.
- Per-mode persistence cases across `change-overview.e2e.ts`, `files-pane-filter.e2e.ts`, and `sidebar.e2e.ts` simplify or merge (~5–15 tests reducible).
- Both currently-flaky tests gain a clean fix grounded in the new model rather than retry-as-bandaid.

**User-visible UX**
- One BREAKING surface: users who relied on per-mode pane layouts will see their Author-mode layout become the new default and Review-mode layout discarded. Migration: read the Author key on first boot; warn-and-discard the Review key.
- `--mode` CLI flag: silently ignored with a deprecation warning for one release, removed thereafter.

**Out of scope but related**
- Issue #40 (macOS watch freeze) shares the `src/shell/events.ts` substrate but its root cause (overlapping refreshes / lock contention in chokidar/FSEvents) is orthogonal and is NOT addressed by this change. A separate change should debounce / serialize the refresh dispatch.
