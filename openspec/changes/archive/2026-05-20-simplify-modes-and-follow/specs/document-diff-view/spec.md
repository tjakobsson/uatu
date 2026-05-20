## MODIFIED Requirements

### Requirement: Diff view auto-refreshes when the active file changes on disk

The Diff view SHALL re-fetch the document-diff endpoint and re-render against the unchanged base whenever the active file changes on disk. This behavior is uniform across the application — there is no Mode-dependent variant — and matches the auto-refresh behavior of the Rendered and Source views. The base ref MUST NOT be re-resolved on a file-content change alone — base resolution happens at fetch time and is not invalidated by worktree changes.

#### Scenario: Diff view auto-refreshes on file change
- **WHEN** the Diff view is active for a file
- **AND** the underlying file changes on disk
- **THEN** the Diff view re-fetches the document-diff endpoint and re-renders without user action

#### Scenario: Base ref is not re-resolved on file-content changes
- **WHEN** the Diff view is active for a file
- **AND** the underlying file changes on disk
- **THEN** the system does NOT re-run base-ref resolution
- **AND** the re-rendered Diff continues to compare against the same base that was resolved at fetch time

### Requirement: Diff view selection is not captured by the Selection Inspector

The Diff view SHALL NOT produce `@path#L<a>-<b>` references via the Selection Inspector pane. The whole-file source `<pre>` distinguishing class (used by single Source view and the Source pane of split layouts) MUST NOT appear on Diff-view DOM, so the existing Selection Inspector detection treats Diff selections as non-source. The Selection Inspector's existing hint ("Switch to Source view to capture a line range.") MAY appear when text is selected in Diff view; no Diff-specific hint is required.

#### Scenario: Selecting text in Diff view does not produce a line-range reference
- **WHEN** the user has the Diff view active for a file
- **AND** marks a contiguous run of text inside the rendered diff
- **THEN** the Selection Inspector does not produce an `@path#L<a>-<b>` reference

#### Scenario: Diff view DOM omits the source-pre distinguishing class
- **WHEN** the Diff view is rendered for any document
- **THEN** the preview body does not contain a `<pre>` element carrying the whole-file source-view distinguishing class

## REMOVED Requirements

### Requirement: Diff view participates in Author auto-refresh and Review stale-content hints
**Reason**: With the Author / Review Mode distinction removed, there is no longer a meaningful place to differentiate "auto-refresh while editing" from "stale-content hint while reviewing". The Diff view collapses to a single behavior — auto-refresh on disk change — which is captured by the new "Diff view auto-refreshes when the active file changes on disk" requirement above. The stale-content-hint UX is not preserved for the Diff view in this change; if a need to pause refreshes mid-read resurfaces, it should be introduced as a Diff-local "freeze" affordance in a separate change.
**Migration**: No user input is required. After upgrade, the Diff view always auto-refreshes on disk change, matching the behavior previously seen only in Author mode.
