## MODIFIED Requirements

### Requirement: Diff view renders the active file's git diff against the resolved review base

The preview pane SHALL expose a **Diff** view that renders the git diff of the currently selected file against the base implied by the active compare target. When the compare target is `base`, the base ref SHALL be resolved in the same priority order used by the review-burden meter (configured `review.baseRef` → `origin/HEAD` → `origin/main` → `origin/master` → `main` → `master`), falling back to staged and unstaged worktree changes against `HEAD` when no remote base is resolvable. When the compare target is `last-commit`, the Diff view SHALL compare the selected file against `HEAD` (staged and unstaged worktree changes). The Diff view SHALL render only the hunks for the selected file — never the diff for other files in the repository. The rendered output SHALL be produced by the `@pierre/diffs` library (vanilla-JS entry) for normal-sized diffs, via one of two input shapes:

- **Two-blob path** — when the server payload carries both `oldContents` and `newContents`, the client SHALL feed them to Pierre as `oldFile` / `newFile`. This path enables Pierre's "N unmodified lines" chevrons to interactively expand surrounding context drawn from the blobs.
- **Patch-only path** — when blobs are absent (the per-blob size cap was exceeded), the client SHALL parse the unified-diff `patch` string via the library's patch-input API and feed Pierre the resulting metadata. The chevrons still render but expansion is bounded by the context git embedded in the patch.

Pierre SHALL NOT be invoked on the normal Source view or Rendered view — its scope is the Diff view only.

#### Scenario: A modified Markdown file shows added and deleted lines against the review base
- **WHEN** a user selects a Markdown file that has been modified against the resolved review base
- **AND** the active compare target is `base`
- **AND** activates the Diff view
- **THEN** the preview body renders only that file's diff, with added and deleted lines visually distinguished

#### Scenario: A modified source file shows the file's diff
- **WHEN** a user selects a `.ts` file that has been modified against the resolved review base
- **AND** the active compare target is `base`
- **AND** activates the Diff view
- **THEN** the preview body renders only that file's diff with syntax-aware highlighting

#### Scenario: Diff view follows the last-commit compare target
- **WHEN** the active compare target is `last-commit`
- **AND** a user activates the Diff view for a file with both committed-since-base and uncommitted changes
- **THEN** the rendered diff shows only the file's staged and unstaged changes against `HEAD`
- **AND** the diff does not include changes already committed between the review base and `HEAD`

#### Scenario: Blob-bearing payload enables expand-context chevrons
- **WHEN** the diff payload carries both `oldContents` and `newContents`
- **THEN** the Diff view feeds them to Pierre's two-blob input
- **AND** the rendered "N unmodified lines" chevrons can be clicked to reveal surrounding unchanged lines drawn from the blob contents

#### Scenario: Patch-only payload still renders with chevrons but expansion is bounded
- **WHEN** the diff payload carries only the `patch` string (no blobs)
- **THEN** the Diff view parses the patch and renders via Pierre's metadata input
- **AND** the rendered "N unmodified lines" chevrons appear but cannot expand beyond the context git embedded in the patch

#### Scenario: The Diff view never renders unrelated files
- **WHEN** a user activates the Diff view for file A while other files B and C have unrelated changes
- **THEN** only file A's hunks appear in the preview
- **AND** files B and C do not appear in the diff output
