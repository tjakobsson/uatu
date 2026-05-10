## Context

Today the document tree is rendered by ~80 lines of HTML-string templating in `src/app.ts` (`renderNodes`, `renderTreeMtime`, `shouldDirRenderOpen`, `FOLDER_ICON_SVG`) plus a 1-second `setInterval` that walks `.tree-mtime[data-mtime]` spans and rewrites their text. Filtering is layered across four sources of truth: a hardcoded directory denylist, `.gitignore`, `.uatuignore`, and binary classification. The `Files` pane has a per-Mode All/Changed toggle that swaps between the full tree and a flat changed-files list. Manual directory open-state is preserved across re-renders with an additive ancestor-reveal model. uatu has no React or Preact; the SPA is plain TypeScript + Bun + chokidar.

[`@pierre/trees`](https://github.com/pierrecomputer/pierre/tree/main/packages/trees) (Apache-2.0, currently `1.0.0-beta.3`) is a path-first file-tree library by The Pierre Computer Co. It ships a vanilla entry, a React entry, a web-components entry, and an SSR entry; internally it uses Preact. Its public API takes path arrays and exposes selection, focus, search, git status, drag-drop, rename, and icon hooks.

This change replaces the hand-rolled tree wholesale, retreats to a deliberately smaller surface, and folds the layered filtering into a single source of truth (`.uatu.json` + built-in defaults + `.gitignore`).

## Goals / Non-Goals

**Goals:**
- Render the tree through `@pierre/trees`' vanilla entry.
- Reduce filtering to a single configuration model: built-in defaults + `.uatu.json tree.exclude` + optional `.gitignore`.
- Replace the All/Changed Files-pane split with ambient git-status row annotations on a single tree.
- Retire `.uatuignore` cleanly, with a startup warning for users who still have one.
- Preserve uatu's existing extension-keyed icon registry; do not adopt a third-party icon set.
- Keep pinned-document mode (`scope.kind === "file"`) unchanged.

**Non-Goals:**
- Adopt React. The vanilla entry is the contract; we do not introduce a React runtime.
- Preserve the live-mtime label. It is deliberately deferred.
- Preserve the additive ancestor-reveal open-set semantics. We accept the library's defaults.
- Re-implement search, drag-drop, or in-place rename. Those library features remain unused for now.
- Migrate `.uatuignore` contents into `.uatu.json` automatically.
- Adopt `@pierre/vscode-icons` or any other icon set the library bundles.

## Decisions

### D1. Use the vanilla entry, not the React entry

**Decision:** Consume `@pierre/trees` from the `.` (vanilla) export only.

**Why:** uatu has no React today and adopting it just to get a tree would expand the dependency surface (`react`, `react-dom`, peerDeps) far beyond what this change needs. The vanilla entry pulls in `preact` and `preact-render-to-string` transitively (the library uses Preact internally), but we never import them at our own boundary — we feed paths in and read selection out.

**Alternatives considered:**
- React entry → rejected; not justified by this change alone.
- Web-components entry → rejected; we don't have a web-components story and it adds a parallel rendering boundary for no win.
- SSR entry → rejected; uatu's SPA shell is server-rendered as a single string today, but the tree itself is hydrated client-side.

### D2. One filter source of truth, with built-in defaults always applied

**Decision:** Filtering is `defaults ∪ .uatu.json tree.exclude`, and `.gitignore` honored by default with two opt-outs (`--no-gitignore` and `tree.respectGitignore: false`). The hardcoded built-in defaults (`node_modules`, `.git`, `dist`, `build`, `.next`, `.turbo`, `.cache`, `coverage`, `.DS_Store`) always apply.

**Why:** Three filter sources today (`ignore-engine.ts` denylist, `.uatuignore`, `.gitignore`) make precedence non-obvious — readers had to consult code to know which file controls what. Folding everything into one configuration block in `.uatu.json` plus an always-on default set matches the VS Code mental model (`files.exclude` defaults + workspace overrides).

**Why built-in defaults are not user-overridable in this change:** Allowing users to *remove* `node_modules` from defaults is a separable concern (and would require a `tree.includeDefaults` or `tree.excludeBuiltins` field). Out of scope here. Users who genuinely want `node_modules` visible can take it up in a follow-up.

**Alternatives considered:**
- Keep `.uatuignore` as a fallback when `.uatu.json` has no `tree.exclude` → rejected; "one source of truth" is the whole point.
- Auto-migrate `.uatuignore` to `.uatu.json` on first run → rejected; uatu is pre-1.0, the population of users with `.uatuignore` files is small, and silent file rewrites are surprising. A loud one-line warning at startup is enough.
- Make built-in defaults a CLI flag → rejected; defaults this universal don't need a knob.

### D3. Hard cut for `.uatuignore`, with a startup warning only

**Decision:** Detect `.uatuignore` at session start, emit one stderr warning per session naming the file's absolute path and pointing to `.uatu.json tree.exclude`, then ignore its contents entirely.

**Why:** A clean break is consistent with "retreat to clean slate." Auto-migration is more code and surprising side effects (renaming the user's file, rewriting their `.uatu.json`). Honoring it as a fallback drags forward the very ambiguity we're removing.

**Alternatives considered:**
- Silent ignore → rejected; users would be surprised when patterns stop applying.
- Auto-migrate once → rejected per above.
- Honor it forever as a fallback → rejected; defeats the purpose.

### D4. Git status as ambient annotation, not a tree mode

**Decision:** Wire review-load's changed-files list into `@pierre/trees`' `setGitStatus(...)` API. Remove the All/Changed toggle entirely.

**Why:** "Changed" was always a filtered view of "All"; you could never act on a modified file in context, only in isolation. Annotation puts the same information *in context* and matches every editor file tree readers know. We already compute the data — review-load already reports `added`/`modified`/`deleted`/`renamed` per path.

**Open implementation question:** Deleted files have no path in the tree (they're gone from the working tree). They were previously listed in the Changed view. They remain accessible through Git Log and direct URLs, but lose their dedicated sidebar surface. Acceptable trade-off for the clean-slate retreat; revisit if it bites.

**Alternatives considered:**
- Keep the toggle, add annotation as a bonus → rejected; doesn't deliver the simplification win.
- Add a "Show only changed" filter mode in `@pierre/trees`' search → deferred; the library has search modes that could host this later, but it's not the default we want.

### D5. Defer the live-mtime ticker as a separate change

**Decision:** Drop the per-row mtime label and the 1s `setInterval` ticker for this change. Re-introduce in a follow-up once we understand `@pierre/trees`' row-annotation surface.

**Why:** The mtime ticker is uatu-distinctive but it's also the most fragile coupling against any third-party tree library: anything that re-renders rows will fight the per-row text mutation. Better to land the swap on a clean slate, learn the library's row-annotation contract, then restore the feature in a way that fits.

**Trade-off:** uatu loses its most visible "see what just changed" cue for users who don't have a git working tree. The git-status annotations cover users who do. The mtime cue is on the deferred list.

**Alternatives considered:**
- Force the ticker into a row-annotation slot in this change → rejected; risky and noisy in a clean-slate change.
- Replace with a CSS pulse on recently-touched rows → deferred; design-worthy but separable.

### D6. Pin `@pierre/trees` to an exact version

**Decision:** Use an exact pin (`"@pierre/trees": "1.0.0-beta.3"`), not a caret range.

**Why:** The library is in beta. Their public API (icon hooks, git-status hooks, annotation slots) is likely to move. An exact pin makes upgrades explicit code changes rather than `bun install` surprises. Renovate (already configured) will surface available bumps as PRs.

**Alternatives considered:**
- `^1.0.0-beta.3` → rejected; beta versions can introduce breakage on patch bumps.
- Vendor the source into `src/vendor/trees/` → rejected for now; Apache-2.0 permits this and we keep the option open if the upstream churn becomes painful, but vendoring upfront forfeits upstream maintenance for a hypothetical problem.

### D7. Adopt `@pierre/trees`' built-in `'standard'` icon set (revised after spike)

**Decision:** Use the library's built-in icon set (`icons: { set: 'standard', colored: true }`) rather than wiring `fileIconForName` through. Retire `src/file-icons.ts` and its sprite-on-the-fly approach.

**Why (revised post-spike):** The original D7 (keep uatu's 7-icon registry) was based on the assumption that adopting a bundled icon set meant pulling in `@pierre/vscode-icons` (a ~1000-icon devDep — bundle bloat). The spike (`1.0.0-beta.3`) revealed the library ships a `'standard'` set of ~50 inline icons (typescript, markdown, json, css, etc.) at zero additional bundle cost — `set: 'none'` and `set: 'standard'` both bundle the same library code. The user's "make it work like VS Code" directive lands better with the richer built-in set than uatu's 7-category fallback (markdown / asciidoc / code / config / image / archive / generic). Aesthetic control is still available later via `byFileName`/`byFileExtension` overrides on top of the built-in set.

**Alternatives considered:**
- Keep `fileIconForName` + sprite sheet → rejected; more adapter code, less VS Code-like out of the box.
- Use `set: 'minimal'` → rejected; too sparse.
- Use `set: 'complete'` → rejected for now; richer than needed and may include icons we don't want.
- Pull in `@pierre/vscode-icons` → still rejected; bundle cost is real for that one.

**Migration:** `src/file-icons.ts` and its tests are deleted. uatu's bespoke 7 SVGs go with it. The `document-tree` spec's "Use uatu's file-type icon registry for tree rows" requirement is REPLACED by "Use the library's built-in `'standard'` icon set with sensible defaults" (spec delta updated in the same change).

### D8. New `tree-filtering` capability instead of folding into `document-watch-index`

**Decision:** Create a new `tree-filtering` spec rather than expanding `document-watch-index`.

**Why:** The filtering rules (built-in defaults, `.uatu.json` schema, `.gitignore` opt-out interaction, `.uatuignore` retirement) are a coherent unit that's worth a dedicated spec. `document-watch-index` already covers a lot of ground (binary classification, the watch loop, static fallback serving, follow mode); piling more in obscures what each requirement is about. A separate capability also makes future changes (built-in-default overrides, per-directory `.uatu.json`, etc.) easier to scope.

**Alternatives considered:**
- Fold into `document-watch-index` → rejected per above.
- Make it part of `document-tree` → rejected; filtering is a watch-side concern, not a render-side one.

## Risks / Trade-offs

- **[Beta upstream moves under us]** → Pin exact version; let Renovate surface bumps; treat each bump as a deliberate code change. If churn becomes painful, fall back to vendoring the source under our control (the Apache-2.0 license permits this).
- **[Bundle size grows]** → `preact` (~3 KB gz) + `preact-render-to-string` + `@pierre/path-store` get pulled in. Modest but real. Acceptable trade-off for the simplification; revisit if it ships an unacceptable browser payload.
- **[Live-mtime regression]** → uatu loses its signature ticker. Mitigated by git-status annotations covering most "what changed?" use cases for users with a git working tree. Plan: follow-up change to restore mtime visibility once we know the library's annotation API.
- **[Manual-open-state regression]** → If users relied on the additive ancestor-reveal model, they will see different behavior. Acceptable per the clean-slate goal; revisit if it bites.
- **[`.uatuignore` users get a one-time surprise]** → Mitigated by the loud startup warning. Anyone reading their terminal output once will know what to do.
- **[Cross-platform path normalization]** → The library uses forward-slash canonical paths. uatu's existing tree builder (`buildTreeNodes`) already produces forward-slash relative paths; the adapter must be defensive on Windows in particular (no platform sep leaks in). Test case in tasks.md.
- **[Library expansion semantics surprise users]** → If the library auto-expands or auto-collapses in ways users find jarring, we accept it for this change and capture user feedback for a follow-up. No bespoke open-set tracking.
- **[Beta version may not expose every hook we need]** → The git-status API and icon API are advertised in their docs but we have not verified the exact shape against `1.0.0-beta.3`. Tasks.md includes a verification step before adapter implementation. If a hook is missing, we may need to vendor a small patch or wait for a release.

## Migration Plan

1. Add `@pierre/trees@1.0.0-beta.3` (exact pin) to `package.json`.
2. Implement the `.uatu.json tree.*` reader (new module), with sensible JSON-Schema-style validation that surfaces errors via the existing review-load warnings path.
3. Replace `src/ignore-engine.ts` with a new module that composes built-in defaults + `.uatu.json tree.exclude` + `.gitignore` (or not, per opt-outs) using the existing `ignore` package.
4. Build the adapter: `TreeNode[]` → path array; selection callback → existing routing flow; review-load changed-files → `setGitStatus(...)`; `fileIconForName` → `setIcons(...)`.
5. Wire the adapter into the `Files` pane in place of `renderNodes`.
6. Delete `renderNodes`, `renderTreeMtime`, `shouldDirRenderOpen`, `FOLDER_ICON_SVG`, the 1s `setInterval`, the All/Changed toggle plumbing, and the `· hidden` counter branch.
7. Add the `.uatuignore` startup warning.
8. Remove `.uatuignore` references from `file-classify.ts`, `file-icons.ts`, `server.ts`, `shared.ts`.
9. Strip dead `.tree-*` selectors from `src/styles.css`.
10. Tests: adapter unit tests; filter-loader unit tests; end-to-end test verifying selection + git-status annotations.

**Rollback:** Revert the change. The proposal does not modify on-disk artifacts users own — `.uatu.json` is additive (existing fields untouched), `.uatuignore` is left in place. Users on the new version who added `tree.exclude` entries to `.uatu.json` would still find them honored by a future re-introduction; no destructive migration steps to undo.

## Open Questions

- **Do binaries deserve a distinct visual treatment in the new tree?** The clean-slate decision says: no, they're clickable rows like any other, with the click routing to a preview-unavailable view. If the loss of "muted / non-clickable" styling makes binaries indistinguishable in a sea of text files, we may want a subtle row treatment in a follow-up. Defer to feedback after landing.
- **Should `tree.exclude` be a single string array or a richer object?** The proposal uses a string array (`string[]`) for simplicity and gitignore-syntax familiarity. A richer shape (e.g. `{ patterns: string[]; reason?: string }`) is conceivable but unjustified now. Single array unless a follow-up surfaces a need.

## Spike Findings (`1.0.0-beta.3`)

Verified against the actual installed package. All four verification questions resolved without gaps:

- **Vanilla entry & paths input:** `new FileTree({ paths: readonly string[], ... })` — exactly as designed.
- **Icon API shape:** `FileTreeIconConfig` is a static configuration object (`set: 'none' | 'minimal' | 'standard' | 'complete'`, a `spriteSheet` SVG string of `<symbol>` definitions, plus `byFileName` / `byFileExtension` / `byFileNameContains` / `remap` maps), NOT a per-row callback. This shifts the adapter shape slightly: we build a single sprite sheet from `fileIconForName`'s SVG output at startup and pass `byFileExtension` keyed by extension. Documented as a small adaptation in tasks 6.3 and 7.7. Use `set: 'none'` to disable built-ins entirely.
- **Git-status API:** `setGitStatus(entries?: readonly GitStatusEntry[])` where `GitStatusEntry = { path: string; status: 'added' | 'deleted' | 'ignored' | 'modified' | 'renamed' | 'untracked' }`. Direct map from review-load's existing status set; no adapter wrangling.
- **Selection observer:** `onSelectionChange: (selectedPaths: readonly string[]) => void` plus `getSelectedPaths(): readonly string[]`. Sufficient for routing.

Bonus findings (not blocking, but inform follow-ups):

- **`renderRowDecoration: FileTreeRowDecorationRenderer`** is a first-class option for per-row annotations, with `FileTreeRowDecorationText` and `FileTreeRowDecorationIcon` decoration kinds. This is the home for the deferred live-mtime feature in a follow-up change.
- **`initialSelectedPaths` + `resetPaths(paths, options)`** preserves selection across re-feeds when the selected path is still present. Wire this in task 6.6 instead of carrying our own preservation logic.
- **`initialExpansion: 'closed' | 'open' | number`** matches uatu's preferred VS Code default behavior (`'closed'`) directly. No bespoke open-set tracking needed.
- **Search is first-class** via `setSearch` / `openSearch` / `getSearchMatchingPaths` plus `FileTreeSearchMode` (`'expand-matches' | 'collapse-non-matches' | 'hide-non-matches'`). Out of scope for this change, but no extra work to enable later — a single `search: true` option exposes it.
