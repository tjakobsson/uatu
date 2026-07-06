## Purpose

Define how a uatu session derives its project identity — a human label and a stable hue from the watched roots — and where that identity surfaces (tab title, favicon, and the Change Overview repository badge) so simultaneous instances on different projects are distinguishable at a glance.

## Requirements

### Requirement: Session derives a stable project label
The client SHALL derive a project label from the state payload's roots: the first root's label when one root is watched, and `<first-label> +N` (where N is the count of additional roots) when several are watched. When the payload carries no roots, the label SHALL be absent and identity surfaces SHALL fall back to plain `uatu` branding.

#### Scenario: Single root uses its label
- **WHEN** the state payload contains one root labeled `my-project`
- **THEN** the derived project label is `my-project`

#### Scenario: Multiple roots use first label plus count
- **WHEN** the state payload contains three roots and the first is labeled `docs`
- **THEN** the derived project label is `docs +2`

#### Scenario: No roots falls back to plain branding
- **WHEN** the state payload contains no roots
- **THEN** the tab title is `uatu` and no project marker is shown

### Requirement: Session derives a stable identity hue from root paths
The client SHALL derive an identity hue (0–359) from a hash of the session's watched-entry paths (each root's `id`, which is the watched file or directory's absolute path — NOT `RootGroup.path`, which degrades to the parent directory for file-scoped roots), sorted so CLI argument order does not affect the result. The same set of watched entries SHALL always produce the same hue, and the hue SHALL be derived from paths — not labels — so identically named projects in different locations get different hues.

#### Scenario: Hue is stable across sessions
- **WHEN** the identity hue is derived twice for the same set of root paths
- **THEN** both derivations produce the same hue

#### Scenario: Root order does not change the hue
- **WHEN** the same root paths are provided in a different order
- **THEN** the derived hue is unchanged

#### Scenario: Same-named projects in different paths differ
- **WHEN** two sessions watch `/a/docs` and `/b/docs` respectively
- **THEN** their identity hues are derived from the differing paths and are independent of the shared `docs` label

#### Scenario: File-scoped sessions in one directory differ
- **WHEN** two sessions watch `/repo/README.md` and `/repo/CHANGELOG.md` respectively
- **THEN** their identity hues derive from the file paths themselves, not the shared parent directory, and are independent of each other

### Requirement: Tab title carries the project label
The client SHALL set `document.title` to `<project-label> — uatu` whenever a state payload is applied (initial boot and live refreshes), so re-derivation is idempotent and reflects root changes without a reload.

#### Scenario: Title set on boot
- **WHEN** the app boots against a session watching a root labeled `my-project`
- **THEN** `document.title` is `my-project — uatu`

#### Scenario: Title tracks state refreshes
- **WHEN** a subsequent state payload changes the watched roots
- **THEN** `document.title` reflects the newly derived label

### Requirement: Favicon is tinted with the identity hue
The client SHALL install a favicon as a dynamically generated SVG `link rel="icon"` element: a rounded square filled with the identity hue at fixed saturation and lightness, bearing the project label's first character in a contrasting color. Re-applying identity SHALL update the existing link element rather than accumulate duplicates. When no roots are present, no dynamic favicon SHALL be installed.

#### Scenario: Favicon installed with project hue and initial
- **WHEN** the app boots against a session watching a root labeled `my-project`
- **THEN** a `link[rel="icon"]` element exists whose SVG data URL contains the identity hue and the character `m`

#### Scenario: Re-apply updates in place
- **WHEN** identity is applied twice
- **THEN** exactly one dynamic favicon link element exists

### Requirement: Change Overview names each repository with an identity badge
The client SHALL render each repository's name in the Change Overview pane as a badge tinted with an identity hue derived from that repository's watched roots' paths — the same derivation the favicon uses, so a single-repository session's badge color matches the favicon exactly. The badge SHALL carry a tooltip (`title` attribute) listing the full path of every watched root belonging to that repository. The sidebar brand block SHALL NOT carry a separate project label — the Change Overview badge is the in-app marker.

#### Scenario: Badge shows the repository name with hue and paths tooltip
- **WHEN** the app boots against a session watching a repository labeled `docs`
- **THEN** the Change Overview names the repository with a badge reading `docs`
- **AND** the badge background uses the identity hue
- **AND** the badge tooltip lists the watched roots' full paths

#### Scenario: Badge matches the favicon color for single-repository sessions
- **WHEN** the session watches a single repository and the badge and favicon are rendered
- **THEN** both derive their color from the same identity hue
