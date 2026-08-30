## Why

Desktop workspace navigation currently exposes Files, Preview, Chat, Terminal, Follow, Change Overview, and Git Log through different interaction patterns. A disposable interactive prototype and screenshot sequence will let the navigation hierarchy, surface combinations, and popover behavior be evaluated visually before production requirements or architecture are committed.

## What Changes

- Build an isolated, disposable desktop prototype of a narrow workspace navbar and its neighboring surfaces.
- Prototype navbar controls for Workspace, Preview, Chat, Terminal, Follow, and Settings, including selected, inactive, unavailable, and attention states where relevant.
- Model Files, Search, Changes, and History as related views in a workspace panel scoped to one of several fixture-only repository/worktree sessions.
- Preserve the existing Since base and Since last commit comparison lenses in the Changes view without introducing arbitrary commit selection.
- Let Playwright drive representative surface, workspace-switcher, repository-view, and settings interactions and capture deterministic desktop and narrow-viewport screenshots for review.
- Include a centered Settings modal containing a non-functional documentation-only preference so its capacity, placement, and language can be evaluated without deciding persistence or filtering semantics.
- Keep the prototype independent of production state, APIs, persistence, terminal sessions, OpenCode conversations, and document navigation.
- Treat all prototype behavior and visuals as disposable evidence. The spike MUST NOT establish product requirements or be promoted to production without a later spec-driven change.

## Capabilities

### New Capabilities

None. This spike creates no product capability.

### Modified Capabilities

None. Existing requirements remain authoritative and production behavior is unchanged.

## Impact

The spike may add isolated prototype markup, styling, fixture data, Playwright interaction coverage, and generated screenshot artifacts in test- or prototype-specific locations. It must not modify production routes, state ownership, persistence schemas, or existing capability specs. Any generated images should be clearly attributable to the spike and removable with the prototype.
