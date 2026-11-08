## MODIFIED Requirements

### Requirement: Display sidebar file count breakdown
The sidebar SHALL display one quiet count of eligible file entries in the selected All, Recent, or Changed view after visibility, filename/path, and media-type filtering. The count SHALL include eligible entries outside the current viewport and SHALL exclude directory rows; All SHALL count files regardless of collapsed folders. Changed SHALL include any existing temporary active-file inclusion. The count MUST NOT display binary subcounts, hidden counts, or N-of-M wording. Its accessible name SHALL identify it as a file/result count.

#### Scenario: Counter shows only the total when the tree is uniform
- **WHEN** All contains three eligible text files
- **THEN** the quiet count is 3 and its accessible label identifies three files

#### Scenario: Counter surfaces the binary subcount
- **WHEN** All contains a mix of text and binary files
- **THEN** the count includes all eligible files without a binary subcount

#### Scenario: Counter never includes a hidden segment
- **WHEN** exposure or visibility rules omit files
- **THEN** the count reflects the eligible set and has no hidden segment

#### Scenario: Counter shows `N of M` form under the Changed filter
- **WHEN** Changed contains 12 eligible entries in a workspace with 1,840 indexed entries
- **THEN** the quiet count is 12 rather than 12 of 1,840

#### Scenario: Binary subcount under filter reflects the visible binary count
- **WHEN** two of Changed's 12 eligible files are binary
- **THEN** the quiet count remains 12 with no separate binary statistic

#### Scenario: Collapsed folders do not shrink the count
- **WHEN** All contains 128 eligible files and most containing directories are collapsed
- **THEN** the count remains 128 rather than counting mounted rows

### Requirement: Annotate tree rows with git status
When repository change data is available, the document tree SHALL annotate changed paths from the changed-files list using its existing Git-status presentation. Supported statuses SHALL include added, modified, deleted, renamed, untracked, and ignored; renamed annotations SHALL apply at the new path. Change annotations SHALL update when repository change data changes and SHALL coexist with All/Recent/Changed presentation controls. Independently supplied known Git-ignore classification SHALL permit ignored styling without waiting for repository change collection. Ignored files SHALL use a muted filename and faded file icon without a visible ignored-status label or badge. Selection, focus, recency cues, and playback actions SHALL remain legible and usable. Unknown ignore status MUST NOT be presented as confirmed ignored or confirmed clean. Recent SHALL use the same muted ignored treatment.

#### Scenario: Modified file shows a modified annotation
- **WHEN** repository change data reports an uncommitted modification
- **THEN** the tree annotates that file in its normal hierarchical position

#### Scenario: Untracked file shows an untracked annotation
- **WHEN** repository change data reports an unstaged new file
- **THEN** the corresponding row shows an untracked annotation

#### Scenario: Annotations clear when changes are committed
- **WHEN** a commit removes the changes and updated repository data confirms it
- **THEN** those change annotations clear

#### Scenario: No annotations when git is unavailable
- **WHEN** repository change data and ignore classification are unavailable
- **THEN** the tree still lists eligible files without inventing Git-status annotations

#### Scenario: Gitignored file visible in the tree shows the ignored annotation
- **WHEN** a visible file is known to be Gitignored
- **THEN** its filename is muted and file icon faded without repeated visible status text
- **AND** it remains selectable and distinguishable from clean tracked or untracked entries

#### Scenario: An ignored file is selected or playing
- **WHEN** a muted ignored row is selected or its clip is auditioned
- **THEN** selection and playback controls remain clearly distinguishable and actionable
