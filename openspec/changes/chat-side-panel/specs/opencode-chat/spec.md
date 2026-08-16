## ADDED Requirements

### Requirement: Desktop presents Preview and Chat as a persistent split
In desktop mode the work area SHALL present Preview and Chat side by side with
a draggable divider between them; Chat SHALL NOT be movable or dockable. The
split position SHALL be persisted as a fraction of the work-area width so
window resizing preserves the proportion, and it SHALL be restored across
reloads. A collapsed Chat SHALL render as a slim strip at the work area's
right edge carrying a visible reopen affordance, and expanding SHALL restore
the retained fraction. When the viewport is too narrow to present both
surfaces at their minimum usable widths, Chat SHALL auto-collapse with its
open preference preserved and SHALL be restored when the viewport grows.
Chat panel state MUST NOT alter the terminal's dock, sizing, visibility, or
persistence behavior: a bottom-docked terminal SHALL span beneath both
Preview and Chat, and a right-docked terminal SHALL keep the work area's
right edge, with Chat between Preview and the terminal.

#### Scenario: Split proportion survives reload and resize
- **WHEN** a desktop user drags the divider to a new position, resizes the
  window, and reloads the page
- **THEN** Preview and Chat retain their fractional share of the work area
  throughout, subject to each surface's minimum width

#### Scenario: Collapsed panel reopens at its prior share
- **WHEN** the user collapses Chat and later activates the strip's reopen
  affordance
- **THEN** Chat expands to the fraction it had before collapsing

#### Scenario: Narrow viewport yields to Preview
- **WHEN** the viewport shrinks below the width needed for both surfaces and
  later grows past it again
- **THEN** Chat auto-collapses while Preview remains usable
- **AND** Chat reopens automatically because the open preference was preserved

#### Scenario: Right-docked terminal keeps the right edge
- **WHEN** the terminal is docked right and Chat is open
- **THEN** the terminal occupies the work area's right edge exactly as it does
  with Chat collapsed
- **AND** Chat sits between Preview and the terminal

#### Scenario: Revealing chat content expands a collapsed panel
- **WHEN** an action that presents Chat content (such as find-in-chat) targets
  a collapsed panel
- **THEN** the panel expands to its retained fraction rather than acting on an
  invisible surface

## MODIFIED Requirements

### Requirement: Chat adapts to desktop, touch, and software-keyboard viewports
In desktop mode Preview and Chat SHALL be co-visible primary surfaces sharing
the main work area alongside the existing sidebar and independently dockable
terminal; there SHALL NOT be a mode that replaces Preview with Chat.
Collapsing, expanding, or resizing the Chat panel MUST NOT remount either
surface or lose its state. In touch mode Chat SHALL occupy its own
full-screen tab surface. The composer SHALL remain reachable above the visual
viewport and safe-area inset while the software keyboard is present, and
keyboard opening, resizing, or dismissal MUST NOT hide the input or cause the
current reading position to jump.

#### Scenario: Preview updates while the conversation stays visible
- **WHEN** a desktop user prompts the agent and it modifies the currently
  previewed document
- **THEN** the live preview updates while the conversation, its streaming
  output, and the composer remain visible

#### Scenario: Desktop collapse and reopen preserves both surfaces
- **WHEN** a desktop user collapses the Chat panel and reopens it
- **THEN** the same conversation, draft, loaded history, and reading position
  are retained
- **AND** the Preview document and scroll position are unchanged
- **AND** terminal attachment and visibility are unchanged

#### Scenario: iPhone keyboard keeps composer visible
- **WHEN** a touch user focuses the Chat composer and the software keyboard
  reduces the visual viewport
- **THEN** the composer remains fully visible above the keyboard and bottom
  safe area
- **AND** the timeline resizes without placing the active content behind the
  composer

### Requirement: Conversation file references navigate through UatuCode safely
Workspace-relative file references in assistant content or normalized
file-change activity SHALL offer navigation to the corresponding UatuCode
document preview when the target is within the watched roots. Activating such
a reference SHALL open the document in Preview and reveal the referenced line
when supplied; in desktop mode this MUST NOT hide, collapse, or resize the
Chat panel, and in touch mode it SHALL switch to the Preview tab. Absolute
paths outside the watched roots, traversal attempts, and unresolved targets
MUST NOT be exposed as navigable workspace links.

#### Scenario: Assistant references a watched source line
- **WHEN** assistant content references `src/app.ts:42` and that file is in
  the watched workspace
- **THEN** activating the reference opens that document in Preview at line 42
- **AND** in desktop mode the conversation remains visible beside it

#### Scenario: Outside path is not navigable
- **WHEN** provider output references an absolute path outside every watched
  root or contains traversal outside the workspace
- **THEN** Chat renders it as inert text rather than a UatuCode navigation
  action
