## ADDED Requirements

### Requirement: Ignored folders load their contents when expanded
The tree SHALL show each Git-ignored folder entry as a folder row with the muted ignored treatment, following Show ignored files like ignored files do. A folder whose level has not been listed SHALL be expandable even though its contents are unknown. Expanding it by pointer, touch, or keyboard SHALL request that level's listing and show its files and subfolders in alphabetical tree order when the listing arrives, merged with any of its files already known from live writes. While the listing is pending, the row SHALL indicate loading without moving focus or selection. A failed listing SHALL leave the folder expandable and show a retry affordance on the row. Collapsing and expanding a listed folder again SHALL NOT request it again. Programmatic expansion during mount, reveal of a selected file, or filter reconciliation SHALL NOT request listings, except for the ancestors needed to reveal an explicitly selected file. The file count SHALL include known files only; files inside levels nobody has listed are not counted.

#### Scenario: Expanding `build/` lists its first level
- **WHEN** the user expands the muted `build/` row that has not been listed
- **THEN** a loading indication appears on that row and is replaced by `build/`'s files and subfolders
- **AND** focus stays on the `build/` row

#### Scenario: A live render is visible before expansion completes
- **WHEN** `build/renders/take-5.wav` was captured from a live write and the user expands `build/` and then `build/renders/`
- **THEN** `take-5.wav` is shown together with the rest of the listed files, once each

#### Scenario: A listing fails
- **WHEN** the listing request for `node_modules/` fails
- **THEN** the folder stays expandable and offers a retry, and the rest of the tree is unchanged

#### Scenario: Show ignored files off hides ignored folders
- **WHEN** Show ignored files is off
- **THEN** ignored folder rows and their known contents are hidden, except paths revealed by an `ignore.exclude` negation

#### Scenario: The count reflects known files
- **WHEN** `node_modules/` has not been listed
- **THEN** the file count does not include its contents, and listing a level adds that level's eligible files to the count
