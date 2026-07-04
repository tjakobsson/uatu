# appState field ownership

## Why

`appState` is a 16-field mutable singleton that 19 modules read and 14 mutate directly (~82 assignment sites) across `shell/`, `preview/`, and `sidebar/` — no field has an owner, so understanding who can change `selectedId` or `viewMode` requires a repo-wide grep, and the three UI folders have effectively fused into one module. The exception proves the fix: `followEnabled`/`selectedId` transitions are governed by follow-mode's four named rules and are the best-understood state in the app.

## What Changes

- Every `appState` field is assigned exactly one owning module, which exposes named mutator functions (e.g. `setViewMode()`, `setFilesPaneFilter()`); reading stays open to all modules.
- Direct assignment (`appState.<field> = …`) outside the owner module is eliminated; call sites go through the owner's mutators.
- Proposed ownership map (refined during implementation, one owner per field enforced regardless):
  - `shell/follow.ts`: `followEnabled`, `selectedId` (already true via the four rules — codified, not changed)
  - `shell/events.ts` (SSE) + `shell/boot.ts`: `roots`, `repositories`, `scope`, `staleHint`
  - `preview/view-mode.ts` / `preview/layout.ts`: `previewMode`, `viewMode`, `viewLayout`, `splitRatio`, `diffStyle`, `wrap`
  - `sidebar/panes.ts` / `sidebar/files-filter.ts` / `sidebar/git-log.ts`: `panes`, `filesPaneFilter`, `gitLogLimit`
  - `sidebar/change-overview.ts`: `compareTarget`
- Mutators that persist preferences own their localStorage write, removing scattered persist-on-assign call sites.
- No state framework, no reactivity layer, no behavioral change — this is an ownership and call-shape discipline only.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `module-structure`: the "appState is importable from a single module" requirement is extended — each field gains a single owning module, and cross-module mutation happens only through the owner's exported mutator functions.

## Impact

- `src/shell/state.ts` — unchanged shape; gains nothing (mutators live with their owners, keeping state.ts a dumb container).
- ~14 mutating modules across `shell/`, `preview/`, `sidebar/` — direct assignments replaced with mutator calls; owners gain small exported functions.
- Unit tests — mutators are directly testable, which also chips at the thin unit coverage in `shell/` and `preview/`.
- ARCHITECTURE.md — state-lifecycle section gains the ownership table.
- **Sequencing**: independent of the other three proposals; largest diff surface, lowest urgency — schedule last.
