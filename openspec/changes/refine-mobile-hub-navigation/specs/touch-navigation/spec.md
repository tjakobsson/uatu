## MODIFIED Requirements

### Requirement: UI mode defaults by pointer type and persists per device
The client SHALL resolve a UI mode, `touch` or `desktop`, at boot and stamp it on the document root: a per-device stored override wins when present; otherwise coarse-pointer devices, including phones and tablets, default to touch and fine-pointer devices to desktop. Layout SHALL be keyed on the mode, while input affordances gated on pointer coarseness, including the touch keybar, size steppers, and scroll-gesture routing, SHALL remain available in both modes on coarse-pointer devices. Switching modes SHALL take effect live, without a page reload, and SHALL persist per device. Existing workspace/base-path-scoped mode preferences SHALL retain their precedence; new Hub-wide navigation preferences MUST NOT replace them.

#### Scenario: iPad defaults to touch mode
- **WHEN** the app boots on a coarse-pointer tablet with no stored mode override
- **THEN** the UI renders in touch mode with the workspace navigation selector initially expanded

#### Scenario: Desktop browsers are untouched
- **WHEN** the app boots on a fine-pointer device with no stored override
- **THEN** it renders the desktop layout without the touch selector, edge handle, or additional mode chrome

#### Scenario: Override survives reload
- **WHEN** a coarse-pointer device has switched to desktop mode and reloads
- **THEN** it boots into the desktop layout using the existing stored override

### Requirement: The sidebar chrome offers the mode switch — never the tab bar
On coarse-pointer devices the UI SHALL offer a single mode toggle in the sidebar header, rendered inside Files in touch mode and in desktop chrome with a collapsed-sidebar rail variant in desktop mode. Desktop mode SHALL remain the desktop layout with its sidebar, Preview-and-Chat split work area, docked terminal, and no touch navigation selector. The toggle SHALL remain available at every viewport width in both modes. Workspace navigation SHALL contain the four surface tabs and, only for a confirmed Hub session, a separate Hub action; it MUST NOT contain a mode toggle. Switching modes SHALL preserve the existing normalization: terminal returns to its stored dock/display mode, entering desktop with Chat active opens the chat panel, entering touch selects Chat only when the user was last working in an open chat panel and otherwise selects Preview, and no touch-only surface promotion remains.

#### Scenario: iPad flips to the desktop rendering and back
- **WHEN** a coarse-pointer user activates the mode toggle in Files, works in desktop mode, and toggles again
- **THEN** each switch renders live into the target layout
- **AND** the last chosen mode is restored after reload

#### Scenario: The tab bar carries no mode control
- **WHEN** workspace navigation renders in touch mode
- **THEN** its tab list contains exactly Files, Preview, Chat, and Terminal
- **AND** any Hub action is a separately identified navigation action, not a fifth surface tab or mode switch

#### Scenario: Rotation cannot strand desktop mode
- **WHEN** a coarse-pointer device in desktop mode narrows below the wide breakpoint or collapses its sidebar
- **THEN** the existing mode toggle remains reachable and can restore touch mode

#### Scenario: Leaving touch mode on the Chat tab keeps the conversation visible
- **WHEN** a user on Chat switches to desktop mode
- **THEN** the chat panel remains open beside Preview in its existing presentation

### Requirement: Touch mode shows a bottom tab bar with four surfaces
In touch mode the client SHALL present the four existing surface tabs, Files, Preview, Chat, and Terminal, in an overlaid bottom navigation selector. The surface tabs SHALL retain tab-list semantics and an unambiguous selected state. Exactly one existing surface SHALL fill the available viewport at a time; showing, hiding, or resizing navigation MUST NOT mount another surface instance or change its state. A confirmed Hub session SHALL additionally offer a separate Hub navigation action; standalone and arbitrary-base-path sessions without a confirmed Hub SHALL omit that action. The selector and its collapsed edge handle MUST NOT render in desktop mode.

The selector SHALL begin expanded on workspace entry or return, without moving focus or automatically attaching/spawning work beyond existing restore semantics. After readiness it SHALL use the idle/dismissal rules below. Neither the selector nor the edge handle SHALL reserve a navigation gutter. Keyboard and safe-area constraints SHALL still keep required controls reachable; overlays MUST NOT change Terminal's rendering, buffer, keybar, font, or stored geometry.

#### Scenario: One surface at a time
- **WHEN** a workspace becomes ready in touch mode
- **THEN** its existing active surface fills the available content area and the selector is initially expanded above it
- **AND** no additional bottom navigation gutter reduces that area

#### Scenario: Tab switching swaps surfaces
- **WHEN** the user selects Chat, then Terminal, then Preview
- **THEN** the existing surface owners activate each selected surface and the tab state follows
- **AND** drafts, attached terminal panes, output, and other in-page state survive exactly as under the existing tab-switch lifecycle

#### Scenario: No false Hub destination
- **WHEN** a touch client runs outside a confirmed Hub session
- **THEN** it offers the four surface tabs without a broken Hub or Return destination

#### Scenario: Re-rendering does not reopen navigation
- **WHEN** a live state update refreshes workspace content after the selector has collapsed
- **THEN** it does not reopen the selector or change the active surface, focus, or idle policy

## ADDED Requirements

### Requirement: Overlay navigation has accessible automatic and explicit dismissal
The default idle delay SHALL be seven seconds, beginning after workspace readiness and resetting on a navigation selection. A held pointer, keyboard navigation, or non-pointer focus within the selector SHALL prevent timed dismissal. Pointer-origin focus alone MUST NOT permanently disable the default timeout. Leaving the selector's bounds while a pointer remains pressed MUST NOT end held-pointer protection. An accessible client-local Keep Open preference SHALL remove automatic and outside-interaction dismissal, while preserving explicit Close, Escape, and leaving the workspace. Hidden destinations SHALL be inert and absent from the focus order.

Explicitly opening navigation by keyboard SHALL place focus in it; explicit dismissal SHALL restore focus to the handle or another valid trigger. Automatic entry expansion MUST NOT steal focus. The selector SHALL handle Escape only while it owns the interaction and no higher-priority dialog owns dismissal; otherwise existing find, chat, and terminal handling SHALL continue unchanged.

In automatic mode, tapping or typing in workspace content outside the selector and its related Preview file controls SHALL dismiss the selector without consuming, duplicating, or changing the original content interaction. Keep Open SHALL suppress that outside-interaction dismissal. Hover alone SHALL neither keep the selector open indefinitely nor reset the idle interval. Related Preview file-navigation actions SHALL remain usable without causing the control group to jump under the user's pointer.

#### Scenario: Default idle dismissal
- **WHEN** an expanded, ready selector receives no qualifying interaction for seven seconds
- **THEN** it collapses without changing the active surface or terminating work

#### Scenario: Focus without a key event
- **WHEN** focus moves into a selector control without a preceding keyboard event
- **THEN** the idle timer does not dismiss that focused navigation

#### Scenario: Finger leaves before release
- **WHEN** a pointer is held down on navigation and moves beyond its bounds
- **THEN** the selector stays open until release or cancellation before resuming the idle policy

#### Scenario: More time is available
- **WHEN** the user chooses Keep Open in Hub navigation preferences
- **THEN** navigation remains open while they read or interact with content until explicitly dismissed or they leave the workspace

#### Scenario: Standalone users can configure dismissal
- **WHEN** a touch workspace has no confirmed Hub
- **THEN** a non-tab navigation-preferences action provides Keep Open and placement settings without exposing a broken Hub destination

#### Scenario: Content interaction dismisses without being lost
- **WHEN** the selector is expanded in automatic mode and the user taps or types in Chat or Terminal content
- **THEN** the selector dismisses and the content receives the original interaction exactly once

#### Scenario: Keep Open suppresses outside dismissal
- **WHEN** Keep Open is selected and the user interacts with workspace content
- **THEN** the selector remains open and that content interaction continues normally

#### Scenario: Hover is not activity
- **WHEN** the pointer only hovers over navigation without held input or qualifying focus
- **THEN** hovering does not prevent the normal idle dismissal

### Requirement: A movable edge handle restores the bottom selector
Collapsed touch navigation SHALL expose a small, identifiable edge arrow with at least a 44 by 44 CSS-pixel target. Dragging SHALL allow placement along either edge, clamp it to the current visible viewport and safe areas, and snap to the selected edge on release. A drag MUST NOT activate navigation; cancellation SHALL restore a committed placement. Tapping the arrow SHALL reveal the selector at the bottom, independently of the arrow's position. Keyboard users SHALL be able to reposition and reset the handle without dragging. Stored placement SHALL adapt to rotation and viewport changes rather than leaving the control offscreen.

#### Scenario: Moving the handle does not move the selector
- **WHEN** the user drags the arrow to the right edge and activates it
- **THEN** the selector opens at its bottom position and does not travel from or open beside the arrow

#### Scenario: Cancelled gesture is not activation
- **WHEN** a drag is cancelled after movement
- **THEN** the handle returns to a committed position and no destination is selected or opened

#### Scenario: Keyboard repositioning
- **WHEN** the handle is focused and the user invokes its documented directional or reset keys
- **THEN** its placement changes within the available bounds without navigating the workspace

### Requirement: New mobile controls scale and preserve existing attention signals
New Hub and workspace navigation controls SHALL support 200% text enlargement, at least 44 by 44 CSS-pixel interactive targets, keyboard operation, meaningful accessible names, selected/disabled state, and focus restoration. Layout SHALL wrap, grow, or scroll rather than achieving a fit by leaving essential text unscaled. Safe areas and visual-viewport changes SHALL be respected without adding a permanent navigation gutter. The Terminal-specific contrast treatment SHALL apply only to the overlays, not to Terminal itself.

Enabled normal-size text SHALL maintain at least 4.5:1 contrast, and essential control graphics SHALL maintain at least 3:1 contrast against their effective background. Translucency MUST NOT make enabled controls illegible over documents, images, or Terminal. Disabled boundary arrows SHALL use explicit disabled semantics and descriptions rather than relying on their lighter gray alone.

Existing Terminal unseen-output and Chat attention indications SHALL remain observable in the expanded selector, with an accessible explanation. The collapsed handle SHALL indicate pending attention without changing, consuming, or clearing the underlying surface's state. Selecting the relevant surface SHALL continue to use that surface's existing acknowledgement rules.

#### Scenario: Enlarged controls remain usable
- **WHEN** Hub and overlay text is enlarged to 200% at narrow or short viewport sizes
- **THEN** destination labels, Return labels, Preview controls, and form completion actions enlarge and remain reachable without horizontal page overflow

#### Scenario: Background work is not hidden by collapsed navigation
- **WHEN** an existing surface attention indicator becomes active while navigation is collapsed
- **THEN** the handle exposes an attention indication
- **AND** opening navigation identifies the relevant surface without clearing its signal

### Requirement: Navigation motion is local and interruptible
The selector SHALL reveal and dismiss at its final bottom position using a brief opacity transition, with no genie deformation, distant geometry matching, travel, scaling, or bounce. The reference timing SHALL be approximately 180 ms in and 280 ms out. Controls SHALL be usable during reveal; reversing an unfinished transition SHALL continue from its current visual state. Reduced Motion SHALL use an immediate state change. Reduced Transparency and increased contrast settings SHALL retain legibility and state information.

#### Scenario: A distant handle does not produce a flying control
- **WHEN** the handle is far from the bottom selector and the user opens navigation
- **THEN** the bar fades in locally and accepts input without waiting for a geometry animation

#### Scenario: Reduced motion
- **WHEN** Reduced Motion is requested
- **THEN** selector visibility changes without spatial or opacity animation

### Requirement: Navigation presentation preserves the existing session lifecycle
Within a workspace, navigation presentation and surface switching SHALL preserve the existing live client state and terminal attachments. Navigating to Hub pages or another workspace SHALL retain the application's existing full-page navigation, server-owned session lifetime, and restoration rules. A cosmetic navigation action MUST NOT stop a workspace, spawn or kill a PTY, dispose a provider's accepted work, or add an implicit takeover. The UI MUST NOT claim that an unloaded browser view or unfinished client-only operation remained mounted.

#### Scenario: Hub navigation is not Stop
- **WHEN** the user follows the Hub action from a running workspace
- **THEN** the existing document navigation occurs without calling Stop or terminating the workspace's server-owned resources
- **AND** returning uses existing resume and attachment semantics, not a new automatic shell

#### Scenario: Surface switching is not page navigation
- **WHEN** the user switches among Files, Preview, Chat, and Terminal
- **THEN** the current workspace document remains active with its existing surface instances and background state
