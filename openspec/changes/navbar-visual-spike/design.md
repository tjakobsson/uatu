## Context

See `proposal.md` for motivation. The production desktop shell currently combines a collapsible pane-stack sidebar, an always-present Preview, a collapsible Chat strip, and an independently docked Terminal. Touch mode already names Files, Preview, Chat, and Terminal as surfaces, but its one-surface-at-a-time behavior does not map directly to desktop, where several surfaces can be visible together.

The spike needs realistic visual density and interaction transitions without coupling to the production DOM, mutable `appState`, server payloads, terminal PTYs, or OpenCode. Product code under `src/` must remain untouched, and the prototype must be removable as a unit.

## Goals / Non-Goals

**Goals:**

- Evaluate a permanent narrow left navbar that replaces the desktop sidebar header, collapsed rail, terminal entry row, and collapsed Chat strip as the primary surface launcher.
- Compare how navbar controls communicate three distinct concepts: surface visibility, current interaction focus, and unseen activity.
- Evaluate a separately toggled Workspace side panel that relates Files, Search, Changes, and History to the active repository/worktree context, with Preview, Chat, and Terminal independently participating in the work area.
- Evaluate a switcher where several worktree sessions remain visibly open while one context is displayed at a time.
- Evaluate Settings as a centered modal with room for additional categories.
- Capture reproducible screenshots at representative desktop and constrained desktop widths, including interaction sequences rather than only static alternatives.
- Make unresolved choices visible in the evidence, especially the state where every primary surface is hidden and the wording of the documentation-only setting.

**Non-Goals:**

- Reuse or migrate production shell state.
- Decide persistence, multi-device synchronization, filtering, Follow eligibility, search scope, or direct-link semantics for the documentation-only setting.
- Decide worktree creation, lifecycle, process ownership, persistence, synchronization, side-by-side display, or production session architecture.
- Replace the existing touch tab bar or settle responsive touch behavior.
- Implement production accessibility, keyboard shortcuts, focus routing, animations, or screen-reader semantics beyond enough labels and state attributes to drive the prototype.
- Preserve the prototype after its screenshots have informed a later product proposal.

## Decisions

### Keep the prototype outside `src/`

Place the prototype in a dedicated test/prototype location and serve or load it only from a spike-specific Playwright test. Keep its markup, styles, fixture data, and minimal interaction state together so deletion is mechanical. This is preferred over feature flags or production-route conditionals because those create integration and cleanup risk for evidence that is intentionally non-production.

Alternative considered: modify the real shell behind a query parameter. Rejected because production boot, persistence, Chat, Terminal, and responsive behavior would constrain the visual experiment and make accidental retention likely.

### Model interactions with fixture state, not product controllers

Use a small in-memory state model for visible surfaces, active surface, Follow, workspace-panel view, selected worktree fixture, switcher visibility, Settings visibility, and the illustrative documentation-only control. Render representative static Files, Search, Changes, History, Preview, Chat, and Terminal content with realistic labels and density. No interaction may issue network requests or write browser storage.

Alternative considered: connect the prototype to the E2E workspace server. Rejected because live data adds nondeterminism without improving the navigation decision.

### Treat desktop surface buttons as independent toggles

Workspace, Preview, Chat, and Terminal can be visible simultaneously. The accepted neutral pressed tile and dot communicate visibility, a stronger monochrome edge marker communicates the last interacted surface, and existing-style badges communicate attention. Follow remains a boolean toggle rather than a surface. This avoids falsely presenting desktop surfaces as mutually exclusive tabs or relying on color alone.

### Unify repository context in the Workspace panel

The navbar's Workspace control toggles one side-panel region. Its header identifies the active repository and worktree, and its view switch exposes Files, Search, Changes, and History without adding separate repository-tool controls to the navbar. Switching views preserves the panel and active worktree context. This groups file navigation and repository evidence without deciding the production pane architecture.

Alternative considered: retain separate Change Overview and Git Log popovers. Rejected for the second screenshot round because review identified that files, changes, history, and future worktree navigation need to be evaluated together.

### Model several live worktree sessions with a switcher

The Workspace panel header opens an anchored switcher listing fixture contexts such as `uatu / main`, `uatu / navbar-study`, and `uatu / docs-refresh`. Each row shows branch/path identity and quiet status metadata. Selecting a row changes the representative panel and document context while the other rows remain listed as open sessions. This evaluates navigation density only; it does not define how sessions are created, hosted, persisted, synchronized, or shown side by side.

Alternative considered: persistent worktree tabs. Deferred because a switcher scales to more contexts without permanently reducing document width; tabs can be compared in a later product change if the switcher proves too hidden.

### Present Settings as a centered modal comparison

Settings opens a centered modal over a dimmed workspace. The modal includes a category rail, a general-settings region, and the illustrative documentation-only control so the review can evaluate a structure that can grow beyond one setting. Clicking the Settings control again or the modal close control dismisses it. The modal remains fixture-only and does not decide persistence, category taxonomy, focus trapping, or production dialog semantics.

Alternative considered: retain the compact anchored Settings popover used in the first screenshot round. Rejected after review because it does not leave enough room for future settings.

### Preserve Files/Search and repository views in one side-panel region

The Workspace panel includes Files, Search, Changes, and History views so project search and repository information have an explicit conceptual home after removal of the production pane stack. The screenshot sequence captures each non-default view and records the proposed relationship for later discussion.

Alternative considered: make Search another navbar popover. Rejected for the prototype because large result sets need persistent vertical and horizontal space and should remain scoped to the selected worktree context.

### Preserve the existing comparison lenses in Changes

The Changes view includes the current full-width segmented control labeled `Compare against`, with `Since base` active by default and `Since last commit` as the alternate. It presents repository identity and the current fact vocabulary: Branch, Commit, Status, Base, and Changes. Selecting `Since last commit` changes the active segment and the Changes anchor from the resolved base ref to `vs HEAD`. The fixture state is per selected worktree context and remains in memory only.

The view does not show changed-file totals, added/removed counts, burden metrics, or a changed-file list because those are not part of the current Change Overview contract. An arbitrary commit picker is also excluded from this spike: adding one would introduce comparison semantics beyond the existing product behavior and needs a separate product proposal.

### Capture a fixed review matrix

Playwright captures deterministic full-page PNGs for:

1. Default: navbar, Files, and Preview visible; Follow enabled; Chat and Terminal hidden.
2. Chat opened: Files, Preview, and Chat visible with no collapsed Chat strip.
3. Preview hidden: Chat expands into the released work area.
4. Terminal opened: Terminal participates below the current work row and its navbar state is selected.
5. Workspace panel in Changes view with Since base active and representative repository facts.
6. Workspace panel in Changes view with Since last commit active and the Changes anchor updated to `vs HEAD`.
7. Workspace panel in History view with representative commit history.
8. Centered Settings modal open with category space and the illustrative documentation-only control.
9. Workspace panel in Search view with representative results.
10. Workspace switcher open with several live worktree fixture contexts.
11. Alternate worktree selected, changing the panel and preview context while other sessions remain open.
12. No primary surface: a quiet launcher is shown as one candidate behavior.
13. Constrained desktop width: the same chrome at a narrower viewport to reveal crowding and overlay issues.

Screenshots belong under the change directory so the visual evidence and the disposable plan can be reviewed and removed together.

## Risks / Trade-offs

- [Prototype looks polished enough to be mistaken for an approved design] -> Watermark the page and screenshots as a visual spike, and state in the UI that behavior is non-production.
- [Static fixture content misrepresents real density] -> Use labels and content lengths taken from current surfaces, including long paths, commit subjects, status rows, and realistic Chat controls.
- [Worktree fixtures imply settled lifecycle behavior] -> Label them as open visual contexts and avoid creation, hosting, persistence, or synchronization claims.
- [Isolation hides integration constraints] -> Record structural constraints from the current shell in the screenshot review, but defer integration design to the later production proposal.
- [Selected versus active styling remains ambiguous] -> Capture states where multiple surfaces are visible but only one is active, and evaluate the distinction explicitly during review.
- [Generated screenshots become stale repository artifacts] -> Keep them under this change and remove or archive the entire spike after decisions are transferred to a product proposal.
- [The docs-only toggle implies settled semantics] -> Label it as an illustrative workspace setting and avoid persistence or filtering claims in prototype copy.

## Migration Plan

There is no production migration. Apply creates only the isolated prototype, its spike-specific Playwright driver, and screenshot evidence. After review, either delete the prototype and retain summarized decisions in a new spec-driven product change, or delete the whole spike if the direction is rejected. No prototype code may be moved into `src/` as part of this change.
