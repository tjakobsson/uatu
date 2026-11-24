## MODIFIED Requirements

### Requirement: Diff view renders the active file's git diff against the resolved compare base

The preview pane SHALL expose Diff for only the selected file's hunks against the active compare target. Normal-sized diffs SHALL use the vanilla-JS `@pierre/diffs` entry with blob or patch input; normal Source and Rendered views SHALL NOT invoke Pierre.

#### Scenario: Compare targets select the review base without unrelated hunks
- **WHEN** compare target is `base`
- **THEN** the base SHALL be the pull request's base when the repository's checked-out branch has an open pull request whose base is available locally
- **AND** otherwise the base SHALL resolve automatically in order `origin/HEAD` → `origin/main` → `origin/master` → `main` → `master`, falling back to staged/unstaged changes against `HEAD` when no remote base resolves
- **WHEN** target is `last-commit`
- **THEN** selected-file comparison SHALL be against `HEAD` for staged/unstaged changes
- **AND** only selected-file hunks SHALL render, never unrelated repository files

#### Scenario: Pierre inputs control available context expansion
- **WHEN** payload carries `oldContents` and `newContents`
- **THEN** the client SHALL feed them as `oldFile` / `newFile`, enabling "N unmodified lines" chevrons to expand surrounding blob context
- **WHEN** blobs are absent because the per-blob cap was exceeded
- **THEN** the client SHALL parse unified `patch` through Pierre's patch-input API and feed resulting metadata; chevrons still render but expansion is bounded by Git's embedded patch context

#### Scenario: A modified Markdown file shows added and deleted lines against the resolved base
- **WHEN** a user selects a Markdown file that has been modified against the resolved base
- **AND** the active compare target is `base`
- **AND** activates the Diff view
- **THEN** the preview body renders only that file's diff, with added and deleted lines visually distinguished

#### Scenario: A modified source file shows the file's diff
- **WHEN** a user selects a `.ts` file that has been modified against the resolved base
- **AND** the active compare target is `base`
- **AND** activates the Diff view
- **THEN** the preview body renders only that file's diff with syntax-aware highlighting

#### Scenario: Diff view follows the last-commit compare target
- **WHEN** the active compare target is `last-commit`
- **AND** a user activates the Diff view for a file with both committed-since-base and uncommitted changes
- **THEN** the rendered diff shows only the file's staged and unstaged changes against `HEAD`
- **AND** the diff does not include changes already committed between the resolved base and `HEAD`

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

#### Scenario: Rendered and Source views do not invoke @pierre/diffs
- **WHEN** a user activates the Rendered or Source view for any document
- **THEN** the `@pierre/diffs` library is not loaded or invoked for that render

#### Scenario: A file in a pull request into a non-default branch
- **WHEN** the checked-out branch has a pull request with base `release/2.0`, that base is available locally, and the compare target is `base`
- **AND** a user activates the Diff view for a file the pull request changes
- **THEN** the diff shows the file's changes since the merge base with `release/2.0`
- **AND** commits that exist on the default branch but not on `release/2.0` do not appear as changes

## ADDED Requirements

### Requirement: Diff line numbers stay compact where width is scarce
Every diff (the document Diff view and a pull request's Files changed) SHALL, in touch mode and at phone widths (640px and below), draw its line-number column compactly: a smaller font, only as wide as its digits need, less padding and a 2px change bar. Unified view keeps one number column. Elsewhere the column keeps the renderer's default. Line-number activation, keyboard comment entry and accessible names SHALL be unchanged.

#### Scenario: A phone gives the code the width
- **WHEN** a unified diff of a file under 100 lines is shown on a 390×844 touch device
- **THEN** its line-number column, change bar included, is at most 26px wide (the default is 42px)

#### Scenario: Line-number comment entry is unchanged
- **WHEN** the reviewer taps a line number in Files changed on that device
- **THEN** the inline composer opens for that line

#### Scenario: Desktop keeps its column
- **WHEN** a diff is shown in desktop mode at 1440×900
- **THEN** the line-number column keeps its default size

### Requirement: A file in the current pull request links to its review
The document Diff view of a file the workspace's current pull request changes SHALL offer, in its header row beside the layout toggle, a compact `Review this file in #<n>` link that opens that pull request's Files changed scrolled to the file, where its lines take comments. Other files SHALL show no link.

#### Scenario: Reviewing from the document Diff
- **WHEN** the user opens `docs/pr-review.md`'s Diff while #642, which changes it, is the current pull request, and activates `Review this file in #642`
- **THEN** #642's Files changed opens scrolled to `docs/pr-review.md`, and the URL names the file

#### Scenario: A file outside the pull request
- **WHEN** the user opens the Diff of a file #642 does not change
- **THEN** the Diff view shows no review link

