## Why

UatuCode Desktop already participates in macOS native window tabbing through its SwiftUI `WindowGroup`, but opening a tab requires first creating separate windows and invoking "Merge All Windows". A standard File > New Tab command with Command-T would make opening projects in one native tabbed window as direct and familiar as Safari while preserving UatuCode's existing per-window isolation.

## What Changes

- Add a native "New Tab" menu command with the standard Command-T shortcut.
- Add Safari-like tab navigation shortcuts: Command-1 through Command-8 select positional tabs, Command-9 selects the last tab, and Control-Tab / Control-Shift-Tab move forward and backward.
- Create the new tab in the focused window's native macOS tab group and show UatuCode's blank folder launcher in it.
- Preserve Command-N as "New Window" for users who want a separate window.
- Preserve one independent `ContentView`, `WebPage`, folder selection, and `UatuServer` lifecycle per native window/tab.
- Ensure tab switching, tab detachment, and moving tabs between native window groups do not restart or stop their servers; closing a tab stops only that tab's server.
- Fall back to opening a standalone launcher window when there is no focused window to receive a new tab.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `desktop-macos-shell`: Extend native window and menu behavior with New Tab creation, Command-T, and explicit lifecycle guarantees for tabbed windows.

## Impact

- **Desktop app:** SwiftUI scene commands and, if required by the native responder path, a small AppKit integration point under `desktop/macos/UatuCodeDesktop/`.
- **Process lifecycle:** The existing one-server-per-window invariant remains unchanged, but shutdown handling must distinguish closing a native tab/window from merely switching or regrouping tabs.
- **Tests and verification:** Add focused desktop coverage where practical, plus native-window verification for creating, switching, detaching, regrouping, and closing tabs.
- **Dependencies and server APIs:** No new dependencies and no changes to the bundled CLI, HTTP routes, browser UI, or release format.
