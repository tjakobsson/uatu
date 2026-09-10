# preview-file-navigation Specification

## Purpose
Provide persistent, accessible touch Preview controls for returning to Files and browsing sibling files without changing workspace rendering, client scope, or existing selection semantics.

## Requirements

### Requirement: Touch Preview exposes persistent file navigation
In touch mode, Preview SHALL expose a translucent overlaid Back to Files control and applicable Previous/Next file controls. They SHALL remain visible after the workspace selector collapses, default to the bottom left, support a right-side device preference in Hub Settings, and move above the selector while it is visible or dismissing. Their placement SHALL account for the selector's actual height, safe areas, keyboard-visible viewport, and enlarged text. They MUST NOT reserve document space or appear in Files, Chat, Terminal, or desktop mode. Rendering and header actions inside Preview SHALL otherwise remain unchanged.

#### Scenario: Controls remain after selector dismissal
- **WHEN** the workspace selector retracts while a file is open in touch Preview
- **THEN** file controls settle toward the bottom edge and remain available

#### Scenario: Controls clear enlarged navigation
- **WHEN** the expanded selector wraps at an accessibility text size
- **THEN** file controls move above its measured bounds rather than overlapping it at a fixed-height assumption

#### Scenario: Other surfaces remain unchanged
- **WHEN** Files, Chat, Terminal, or desktop mode is active
- **THEN** the Preview file overlay is absent

### Requirement: Back to Files preserves the current selection
Back to Files SHALL reveal the existing Files surface without changing the selected document, Follow, compare target, filter, tree expansion state, or workspace identity. The selected file SHALL remain selected and reachable through the existing tree reveal behavior. It MUST NOT create a second tree or reload the workspace.

#### Scenario: Return from an image
- **WHEN** the user views an image and activates Back to Files
- **THEN** Files becomes active with that image still selected
- **AND** returning to Preview does not select a different document

### Requirement: Sibling navigation uses the current root and effective scope
Previous and Next SHALL traverse indexed files sharing the current file's stable root identity and exact parent directory, within this client's effective watch scope. They SHALL use the Files tree's default file ordering: dot-prefixed names first, then case-insensitive alphabetical order with consistent tie handling. Directories SHALL not be entries, descendants SHALL not be included, and traversal SHALL not wrap. All indexed file kinds SHALL retain their existing Preview behavior, including supported image rendering and unsupported-binary fallback; the feature MUST NOT rewrite ordinary binary-link behavior.

The Files All/Changed chip SHALL remain a presentation filter, not a silent change to sibling scope: sequence membership uses the current effective corpus, preserves the chosen filter, and uses the existing selected-file reveal cue when needed. A pinned file scope or CLI single-file launch MUST NOT be widened by sibling navigation. Unknown, stale, or ambiguous identity MUST NOT be resolved by guessing from basename or display path.

#### Scenario: Images in one directory
- **WHEN** the current root contains three images in `images/` and another under `images/archive/`
- **THEN** Previous/Next traverse only the three direct siblings in their Files ordering

#### Scenario: Duplicate relative paths in different roots
- **WHEN** another watched root contains a file with the same relative path
- **THEN** navigation remains in the current root and does not select that other file

#### Scenario: A narrowed client does not widen itself
- **WHEN** the effective client scope or CLI launch exposes only the current file
- **THEN** sibling navigation does not request an unscoped corpus or select a file outside that scope

#### Scenario: Changed filtering is preserved
- **WHEN** the Files chip is Changed and the next scoped sibling is unchanged
- **THEN** navigation keeps the filter, selects the intended file, and uses the existing reveal behavior rather than resetting the chip

### Requirement: File actions use normal user-selection semantics
A successful Previous/Next action SHALL be ordinary user document navigation: select the target by stable document identity, reveal Preview, disable Follow through its existing user-intent rule, update the tree and history, preserve unrelated preferences, and use the existing renderer/load-race protections. It MUST NOT reload the workspace, recreate chat or terminal resources, introduce another Follow control, or simulate a search result as a production interface. Browser Back/Forward SHALL restore the same document identity under existing routing rules.

#### Scenario: A filename contains spaces or reserved characters
- **WHEN** the next file's name contains spaces, `#`, or `?`
- **THEN** the correct file is selected and its URL remains correctly encoded

#### Scenario: Late response is superseded
- **WHEN** the user changes destination while an earlier document request is unfinished
- **THEN** the earlier response does not replace the later selection or report false success

### Requirement: Single-file and boundary states are distinct
With a fresh index confirming exactly one file in the current sibling set, both direction arrows SHALL be hidden while Back to Files remains available. For a multi-file set, an unavailable direction SHALL remain visible in a clearly lighter disabled gray, expose disabled semantics, and identify the actual first/last-file boundary accessibly. Commit, review-score, and empty previews without a file destination SHALL retain Back to Files but omit inapplicable direction arrows. A load failure for a known file destination SHALL remain recoverable as a file context.

#### Scenario: Single-file directory
- **WHEN** the current file is the only scoped direct sibling in its directory
- **THEN** neither Previous nor Next appears
- **AND** Back to Files remains available

#### Scenario: Multi-file boundary
- **WHEN** the user reaches the first or last file of a multi-file sequence
- **THEN** the unavailable direction is visibly lighter and disabled, with an accurate boundary description
- **AND** the available direction continues to work

#### Scenario: Non-file preview
- **WHEN** Preview displays a commit or review score rather than a file
- **THEN** Back to Files remains available without misleading file-step arrows

### Requirement: Index and load failures provide explicit recovery
Loading, unavailable index, document-load timeout, missing target, and a genuine sequence boundary SHALL be distinct states. A stale or failed index MUST NOT be presented as first/last-file state or proof of a single-file directory. Directional actions SHALL be disabled while their target cannot be safely determined, while Back to Files remains usable. Failures SHALL show concise visible and accessible feedback with an explicit retry where meaningful; refreshing the entire workspace MUST NOT be required to retry.

A timed-out selection SHALL retain its intended target until success, superseding user navigation, cancellation, or a refreshed index proves it absent. Retry SHALL revalidate that exact identity and current scope before opening it; it MUST NOT silently choose a replacement. Error and Retry controls SHALL remain reachable at enlarged text sizes and after selector placement changes.

#### Scenario: Failed refresh is not a boundary
- **WHEN** an index refresh fails while a middle file remains displayed
- **THEN** the UI reports an index failure with Retry and Back to Files
- **AND** it does not claim that the file is simultaneously first and last

#### Scenario: Target disappeared before retry
- **WHEN** a timed-out destination is absent from the refreshed current-scope index
- **THEN** the UI explains that the target is unavailable and does not open a guessed replacement

#### Scenario: Recovery keeps the workspace
- **WHEN** a retry succeeds after a transient index failure
- **THEN** file navigation resumes without reloading the workspace or discarding other surface state
