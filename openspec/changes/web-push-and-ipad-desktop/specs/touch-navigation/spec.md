## ADDED Requirements

### Requirement: Desktop mode respects device safe areas
Desktop mode on a tablet SHALL retain the desktop arrangement while keeping sidebar controls, preview headings and actions, conversation controls, and the mode toggle inside the device's usable safe area. System status-bar treatments and application blur layers SHALL NOT obscure those controls. The layout SHALL account for top, side, and bottom insets after initial load, rotation, resizing, and live UI mode changes. Physical-device insets SHALL NOT be inferred solely from viewport width or primary pointer type, since attaching a keyboard or trackpad does not remove the device's safe areas.

#### Scenario: Installed iPad app enters desktop mode
- **WHEN** an 11-inch iPad Pro opens the installed Uatu PWA in landscape and switches to desktop mode
- **THEN** the sidebar identity and controls, preview heading/actions, and chat header remain legible and operable below the system status area
- **AND** no top-edge blur covers those controls

#### Scenario: Rotation preserves the way back
- **WHEN** the iPad rotates between landscape and portrait in desktop mode with the sidebar expanded or collapsed
- **THEN** controls remain inside the updated safe area and a mode toggle remains reachable

#### Scenario: A desktop browser has no device insets
- **WHEN** desktop mode runs in a browser reporting zero safe-area insets
- **THEN** the layout does not add an artificial tablet status-bar gap

### Requirement: Desktop mode follows the visible viewport during text entry
When a tablet uses desktop mode, the workspace SHALL fit the visible viewport during software-keyboard and hardware-keyboard accessory-bar transitions, including viewport panning. Focusing the chat composer SHALL keep the sidebar, preview, and chat headers visible while keeping the composer and send control above the occluded area. A small accessory-bar occlusion SHALL be handled even when it is smaller than the software-keyboard detection threshold. Chat and preview content SHALL scroll within their appropriate panes rather than requiring the user to scroll the whole workspace to recover its headers. Geometry SHALL recover after blur, keyboard dismissal, rotation, and mode switching without clearing drafts, changing the selected conversation/document, or repeatedly forcing page scroll.

#### Scenario: Magic Keyboard accessory bar appears
- **WHEN** a user with a Magic Keyboard attached to an 11-inch iPad Pro in installed-PWA desktop mode focuses the chat composer and iPadOS shows its input accessory bar
- **THEN** the workspace adjusts to the visible area
- **AND** the sidebar, preview, and conversation headers stay visible
- **AND** the composer and send button remain usable above the accessory bar

#### Scenario: Software keyboard pans the viewport
- **WHEN** the user focuses the composer with the software keyboard and the platform changes both visible viewport height and offset
- **THEN** desktop-mode geometry follows both measurements and keeps the headers and composer within the usable area

#### Scenario: Dismissal restores the workspace
- **WHEN** the keyboard or accessory bar dismisses after the user has typed a draft
- **THEN** the workspace returns to the available height without a blank keyboard-sized strip or stranded scroll offset
- **AND** the draft, selected conversation, and selected document are preserved

#### Scenario: Mode switches during editing
- **WHEN** the user switches between touch and desktop mode during an editing session
- **THEN** the target layout uses the current viewport and safe areas without stale padding or double-counted insets
- **AND** the draft and current conversation survive the switch
