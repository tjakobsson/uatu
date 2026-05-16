## MODIFIED Requirements

### Requirement: Render review-load summary in the Change Overview pane
The browser UI SHALL render repository and review-load data in the `Change Overview` pane when that data is available. The pane MUST show whether the watched root is inside a git repository, the current branch or detached commit, dirty status, resolved review base or fallback mode, cognitive-load level, and score. The pane MUST NOT list raw mechanical statistics such as changed-file count, touched-line count, diff-hunk count, or directory spread directly in the sidebar. When the workspace contains at least one untracked entry — including entries excluded from the score by `.uatu.json review.ignoreAreas` — the pane MUST additionally render a categorical indicator that surfaces the presence of untracked files; the indicator answers a workspace-state question ("are there untracked files at all?") and therefore considers both `reviewLoad.changedFiles` and `reviewLoad.ignoredFiles`. That indicator MUST NOT include a count and MUST NOT render when no untracked entries are present in either array. The score MUST be clickable and MUST open a detailed scoring explanation in the main preview area. The pane MUST label the score as review burden or cognitive load and MUST NOT present it as code quality or correctness. The score's *headline label* in the pane SHALL depend on the active Mode: when Mode is **Author**, the headline label MUST be "Reviewer burden forecast"; when Mode is **Review**, the headline label MUST be "Change review burden". The numeric score, level pill, drivers, thresholds, configured area lists, warnings, the untracked categorical indicator, and the contents of the score-explanation preview MUST be identical in both Modes. The score-explanation preview MUST, when `reviewLoad.changedFiles` contains untracked entries, expose the untracked subcount as a distinct factual change-shape input alongside the existing mechanical drivers; this subcount describes the score and therefore MUST be sourced from `changedFiles` only (excluding `ignoredFiles`). It MUST appear only inside the score-explanation preview and MUST NOT alter the numeric review-burden score. If review-load data is unavailable, the pane SHALL show a clear unavailable or non-git message instead of failing to render.

#### Scenario: Git-backed change has review-load data
- **WHEN** the browser receives repository metadata and a computed review-load result
- **THEN** the `Change Overview` pane shows the branch or detached commit, dirty status, review base, cognitive-load level, and score
- **AND** the pane does not show raw mechanical statistics such as `Changed files`, `Touched lines`, `Diff hunks`, or `Directory spread`

#### Scenario: Watch root has no git repository
- **WHEN** the browser receives a non-git repository state for the watched root
- **THEN** the `Change Overview` pane states that no git repository is available
- **AND** the document preview and `Files` pane remain usable

#### Scenario: Review settings contain a warning
- **WHEN** the review-load result includes a settings warning such as invalid `.uatu.json`
- **THEN** the `Change Overview` pane displays that warning
- **AND** the pane still displays any available default review-load result

#### Scenario: Score drivers distinguish configured and factual inputs
- **WHEN** a user clicks the review-burden score
- **THEN** the main preview renders configured risk, support, and ignore area matches with their configured area names
- **AND** mechanical drivers such as files, hunks, lines, and directories are labeled as factual change-shape inputs
- **AND** Follow mode is disabled
- **AND** the browser URL changes to a linkable score-explanation state

#### Scenario: Score explanation remains active during refresh
- **WHEN** a user has opened the score explanation from `Change Overview`
- **AND** the watch session receives a file-change refresh
- **THEN** the main preview remains on the score explanation
- **AND** Follow mode remains disabled

#### Scenario: Score explanation compares the numeric score
- **WHEN** a user opens the score explanation from `Change Overview`
- **THEN** the main preview explains that the score is an additive review-burden index, not a percentage or code-quality score
- **AND** the preview shows the configured or default low, medium, and high thresholds
- **AND** the score total and threshold cards use the corresponding low, medium, and high background colors
- **AND** the preview explains whether the current score is below or above those thresholds
- **AND** the preview does not render a separate `Changed Files` section

#### Scenario: Mechanical statistics have inline explanations
- **WHEN** a user opens the score explanation from `Change Overview`
- **THEN** mechanical statistics such as `Changed files`, `Touched lines`, `Diff hunks`, and `Directory spread` expose help markers
- **AND** hovering or focusing a help marker shows a tooltip that explains what that statistic means in review-burden scoring
- **AND** the explanation does not require clicking the marker

#### Scenario: Author Mode shows the forecast headline label
- **WHEN** the `Change Overview` pane is rendered with review-load data and Mode is **Author**
- **THEN** the score's headline label reads "Reviewer burden forecast"

#### Scenario: Review Mode shows the change-review headline label
- **WHEN** the `Change Overview` pane is rendered with review-load data and Mode is **Review**
- **THEN** the score's headline label reads "Change review burden"

#### Scenario: Switching Mode does not change the score number or level
- **WHEN** the `Change Overview` pane is rendered with review-load data
- **AND** the user toggles Mode between **Author** and **Review**
- **THEN** only the headline label string changes
- **AND** the numeric score, level pill color, drivers, thresholds, and configured-area summaries remain identical

#### Scenario: Score-explanation preview content is independent of Mode
- **WHEN** the user opens the score explanation from `Change Overview` in either Mode
- **THEN** the score-explanation preview renders identical content
- **AND** the preview does not contain Mode-dependent text

#### Scenario: Untracked categorical indicator appears when untracked files are present
- **WHEN** the changed-files list received by the browser contains at least one entry with the untracked status
- **THEN** the `Change Overview` pane renders a categorical indicator that the change includes untracked files
- **AND** the indicator does not display a count
- **AND** the rest of the pane (branch, commit, dirty status, base, score, level) renders unchanged

#### Scenario: Untracked categorical indicator is absent when no untracked files are present
- **WHEN** the changed-files list received by the browser contains no entries with the untracked status
- **THEN** the `Change Overview` pane does NOT render the untracked categorical indicator
- **AND** the pane shows no placeholder, empty row, or "0 untracked" affordance for that category

#### Scenario: Score-explanation preview breaks out the untracked subcount
- **WHEN** the changed-files list contains at least one untracked entry
- **AND** the user opens the score explanation from `Change Overview`
- **THEN** the preview renders the untracked subcount as a distinct factual change-shape input
- **AND** the preview's numeric review-burden score is identical to the score that would be computed if untracked entries had been reported with status `"A"` rather than `"?"`

#### Scenario: Untracked indicator renders when all untracked files are ignored by `ignoreAreas`
- **WHEN** the changed-files list contains no untracked entries
- **AND** the ignored-files list contains at least one untracked entry (i.e. an untracked path that matches a `.uatu.json review.ignoreAreas` pattern)
- **THEN** the `Change Overview` pane renders the untracked categorical indicator
- **AND** the score-explanation preview does NOT render the untracked subcount row (the score is unaffected by ignored entries)

#### Scenario: Untracked indicator is identical across Author and Review modes
- **WHEN** the changed-files list contains at least one untracked entry
- **AND** the user toggles Mode between **Author** and **Review**
- **THEN** the untracked categorical indicator continues to render in the `Change Overview` pane
- **AND** the indicator text does not change between Modes
