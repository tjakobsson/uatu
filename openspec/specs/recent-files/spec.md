# recent-files Specification

## Purpose
Help users locate files by their latest filesystem write, including generated exports, and browse live results without losing their place or accidentally opening a moving row.

## Requirements

### Requirement: Recent orders the current corpus by disk-write time
The Files pane SHALL offer a flat Recent view over the permitted files in the current scope and visibility settings, including text and binary files. Entries SHALL be ordered by descending filesystem modification time with deterministic path/root tie-breaking. Opening, committing, or merely discovering a file MUST NOT assign it a newer write time. Recent SHALL have no time cutoff and SHALL remain browsable with bounded mounted rows for large inventories.

#### Scenario: An ignored export was written most recently
- **WHEN** ignored files are shown and `renders/bass.wav` has the latest filesystem modification time
- **THEN** it is first in Recent even though Git does not track it
- **AND** opening another file does not move that other file to the top

#### Scenario: Equal timestamps remain deterministic
- **WHEN** several entries have the same modification time, including matching relative paths in different roots
- **THEN** their path/root tie-breaking order is stable across equivalent refreshes
- **AND** a content revision change still invalidates that file without inventing a later modification time

#### Scenario: Discovery finds an old file
- **WHEN** background discovery publishes a file written a week ago
- **THEN** its place reflects that write time rather than the time it was discovered

### Requirement: Recent rows identify the file and its age
Each Recent row SHALL show a filename, file-type icon, containing root-relative path, and quiet relative write age. Multi-root entries SHALL be distinguishable. Exact write time SHALL be available without requiring hover, through file details or an accessible row action. Ages SHALL advance while visible without refetching filesystem or Git data; future timestamps SHALL display as now rather than a negative age.

#### Scenario: Two exports have the same filename
- **WHEN** `renders/dry/test.wav` and `renders/wet/test.wav` appear in Recent
- **THEN** their containing paths distinguish them without opening Preview

#### Scenario: Ages advance while idle
- **WHEN** a visible row's write time becomes several minutes old without a file event
- **THEN** its age label advances without a server request

### Requirement: Files metadata search filters names and paths
The Files pane SHALL provide a filename/path query that works in All, Recent, and Changed without reading file contents. Switching Files view SHALL retain the query, and the count SHALL reflect its matching eligible files. This query SHALL remain distinct from project content search. Clearing it SHALL restore the selected view's eligible set.

#### Scenario: Search finds an export across folders
- **WHEN** the user enters `bass` in Recent
- **THEN** only entries matching that filename/path query appear, newest writes first
- **AND** no media bytes or source contents are read to produce the matches

#### Scenario: Query survives a view change
- **WHEN** the user switches from Recent to All with a nonempty query
- **THEN** the hierarchical view applies the same filename/path matching rules
- **AND** clearing the query restores the unqueried tree

### Requirement: Live Recent updates preserve activation and reading position
File additions, writes, renames, and deletions SHALL update Recent from existing indexed state while preserving activation, reading position, and deliberate selection.

#### Scenario: Structural updates respect an activation in progress
- **WHEN** a structural Recent update arrives during a pointer/touch activation
- **THEN** the update MUST NOT cause an activation begun on one file to activate another file
- **AND** structural updates SHALL wait until the activation settles, then preserve the surviving scroll anchor and file-keyed keyboard focus

#### Scenario: Updates and view switches do not navigate for the reader
- **WHEN** Recent updates or the user switches Files views
- **THEN** a reader below the top MUST NOT be jumped to the newest row
- **AND** updates and view switches MUST NOT choose a preview, clear intentional deselection, enable Follow, or start media playback

#### Scenario: A render arrives under a finger
- **WHEN** a user presses a row and a newer file arrives before the activation finishes
- **THEN** releasing activates the originally pressed file, or cancels if it was removed
- **AND** it never activates the replacement row at the same screen coordinate

#### Scenario: The user is browsing older exports
- **WHEN** the user has scrolled below the top and new files arrive
- **THEN** the surviving visible anchor remains in place and focus remains on the same file
- **AND** the user can scroll to the top to see the newest entries

#### Scenario: A file disappears during activation
- **WHEN** the pressed file is deleted before activation completes
- **THEN** no adjacent file is opened or played in its place

### Requirement: Hierarchical views show quiet write recency
The hierarchical file views SHALL keep their existing stable hierarchy while offering relative write ages for entries written within the last 24 hours and a small latest-write marker for the newest matching file. Recency annotations SHALL coexist with Git status without replacing it or adding repeated status labels. Their refresh MUST NOT reset directory expansion, select a file, or trigger filesystem work.

#### Scenario: The latest file is also ignored
- **WHEN** the newest visible file is ignored and was written moments ago
- **THEN** its recency cue remains legible alongside muted ignored styling
- **AND** its normal hierarchical position is retained

#### Scenario: A label ages out
- **WHEN** a file's write age passes 24 hours
- **THEN** its recent-age label is removed without a corpus refetch or tree expansion reset

### Requirement: Recent covers known files in ignored folders
Recent SHALL include files inside Git-ignored folders that are known to the index: files in listed levels and files captured by the live-write window. Recent SHALL NOT read unlisted ignored folders to find older writes. A file inside an unlisted ignored folder that was written before the session started SHALL appear in Recent once its level is listed.

#### Scenario: A render written during the session is in Recent
- **WHEN** Show ignored files is on and a script writes `build/renders/take-5.wav` inside an unlisted ignored `build/`
- **THEN** `take-5.wav` appears at the top of Recent and under the Audio filter

#### Scenario: Yesterday's render appears after expansion
- **WHEN** `build/renders/take-0.wav` was written before the session started and `build/renders/` has not been listed
- **THEN** it is absent from Recent until a client expands `build/renders/`, after which it is ordered by its write time
