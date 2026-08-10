## ADDED Requirements

### Requirement: A surface-directed shortcut SHALL bring its surface forward

A keyboard shortcut that acts on a specific surface SHALL make that surface the
active tab before it acts, so its affordance is never mounted or focused inside
a hidden subtree. `⌘F` targets the preview and SHALL activate the Preview tab;
`⇧⌘F` targets the Search pane in the sidebar stack and SHALL activate the Files
tab. This is the shortcut counterpart of the existing rule for preview-bound
navigations: a shortcut the user pressed is an act of intent, so it may promote
a surface, whereas programmatic activity (follow-mode Rules C/D, file events)
still MUST NOT. A shortcut that consumes the key and suppresses the host's own
handling MUST NOT leave the user with nothing visible to use.

#### Scenario: Find brings the Preview tab forward
- **WHEN** the Files tab is active and the user presses `⌘F` on a hardware keyboard
- **THEN** the Preview tab becomes active and the find bar opens on it with its input focused

#### Scenario: Project search brings the Files tab forward
- **WHEN** the Preview or Terminal tab is active and the user presses `⇧⌘F` on a hardware keyboard
- **THEN** the Files tab becomes active with the Search pane visible and its query input focused

#### Scenario: The shortcut is not consumed without an effect
- **WHEN** a surface-directed shortcut suppresses the host's native handling of that key
- **THEN** the corresponding surface is visible and the affordance it opened is usable

#### Scenario: Programmatic activity still does not promote a surface
- **WHEN** a watched-file event or a follow-mode Rule C/D update changes the tree while the Files tab is active
- **THEN** the Files tab remains active and no surface is promoted
