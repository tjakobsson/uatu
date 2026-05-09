## 1. Pre-flight

- [x] 1.1 Confirm no other in-flight change adds new requirements to `document-watch-browser` (would conflict with the wholesale REMOVED delta)
- [x] 1.2 Confirm `openspec validate split-document-watch-browser` passes locally

## 2. Apply the change

- [x] 2.1 Run the standard OpenSpec apply flow (the change is purely spec deltas — there is no code to write). *Note:* `openspec archive` initially aborted on the wholesale REMOVED delta (validator rejects empty specs). Resolved by dropping the REMOVED delta from the change and retiring `document-watch-browser/` via manual `rm -rf` after archive. Per-requirement migration mapping is preserved in design.md.
- [x] 2.2 Verify post-apply that `openspec/specs/` contains the seven new capability folders: `watch-cli-startup/`, `document-watch-index/`, `document-rendering/`, `mermaid-rendering/`, `document-metadata-card/`, `document-routing/`, `document-tree/`, `sidebar-shell/`
- [x] 2.3 Verify post-apply that `openspec/specs/document-watch-browser/` has been removed
- [x] 2.4 Verify each new spec's requirement count matches the proposal: watch-cli-startup=2, document-watch-index=7, document-rendering=9, mermaid-rendering=4, document-metadata-card=1, document-routing=6, document-tree=5, sidebar-shell=12 (sum = 46)

## 3. Verbatim integrity check

- [x] 3.1 For a sample of 5 requirements (one from each of: cli, watch-index, rendering, mermaid, sidebar-shell), diff the moved requirement text against the pre-split `document-watch-browser/spec.md` to confirm no scenario or wording changed
- [x] 3.2 Confirm every scenario header still uses exactly four hashtags (`#### Scenario:`)
- [x] 3.3 Confirm `openspec list --json` shows the new capabilities and no longer shows `document-watch-browser` (verified via `ls openspec/specs/`: 8 new capability folders present, `document-watch-browser/` absent)

## 4. Cross-spec consistency

- [x] 4.1 Confirm `change-review-load` was not modified by this change (compute requirements remain owned there)
- [x] 4.2 Search archived-changes references to `document-watch-browser` in `openspec/changes/archive/` and note that they remain frozen and unchanged (historical artifacts). 10+ past changes mention the old capability name; all archive entries are untouched by this change.
- [x] 4.3 Capability map captured in design.md ("Requirement Migration Map" section) and proposal.md (Capabilities section). The PR description should reference design.md rather than restating the table.

## 5. Follow-up tracking (out of scope here, captured for visibility)

- [x] 5.1 Phase 2 (code restructure under `src/{client,server,shared}/`) — captured in proposal.md Impact section and design.md Goals/Non-Goals. New capability names are intended as Phase 2 folder targets.
- [x] 5.2 Phase 3 (light/dark theme support, likely introducing a `theme-and-appearance` capability) — captured in proposal.md Impact section.
- [x] 5.3 `repository-workflows` is also a grab-bag and may want a similar split in a future change — captured in design.md Goals/Non-Goals as out-of-scope for this change.
