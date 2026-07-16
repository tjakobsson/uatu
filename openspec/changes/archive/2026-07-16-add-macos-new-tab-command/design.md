## Context

UatuCode Desktop uses a SwiftUI `WindowGroup`. Each generated native window gets independent `ContentView` state, including its own `WebPage`, selected folder, and `UatuServer`. AppKit already recognizes these windows as compatible with native tabbing: "Merge All Windows" combines them into a standard macOS tab group without a custom tab model.

SwiftUI currently supplies File > New Window with Command-N. The app adds its own focused-window commands, but it has no direct New Tab command. The implementation should expose AppKit's native tab creation rather than reproduce tab selection, layout, dragging, or grouping inside SwiftUI.

## Goals / Non-Goals

**Goals:**

- Make File > New Tab and Command-T create a blank UatuCode launcher tab in the focused native window group.
- Keep File > New Window and Command-N available for a separate window.
- Preserve the one-server-per-native-window lifecycle while windows are grouped, switched, detached, or moved as tabs.
- Use standard AppKit tab behavior and appearance.
- Define sensible behavior when no window is focused.

**Non-Goals:**

- Building a custom tab bar or representing multiple projects inside one `ContentView`.
- Duplicating the focused tab's folder, browser navigation, terminal, or server state.
- Sharing one `uatu serve` process between tabs.
- Persisting or restoring tab groups beyond the behavior SwiftUI and AppKit already provide.
- Changing the CLI, browser UI, server protocol, or release packaging.

## Decisions

### D1: Keep one native window per tab

A UatuCode tab remains an `NSWindow` created from the existing `WindowGroup`; AppKit only groups those windows visually. The new tab starts with a fresh `ContentView` and therefore shows the existing blank launcher. Choosing a folder then starts that tab's own server exactly as it does in a standalone window.

This preserves the established ownership boundary and allows native operations such as Move Tab to New Window and dragging between tab groups without migrating application state. A custom SwiftUI tab container was rejected because it would duplicate macOS window management and require a new multi-project state and process-lifecycle model.

### D2: Mark requested scenes as preferred native tabs before presentation

File > New Tab uses Command-T. The `WindowGroup` is data-driven by a lightweight UUID that SwiftUI persists with each scene. The command records a tab intent under a fresh UUID and opens a scene with that value. An `NSView` bridge reports its resolved `NSWindow` synchronously from `viewDidMoveToWindow()`, before first presentation, and matching requests set `NSWindow.tabbingMode` to `.preferred` with the same tabbing identifier as the focused Uatu window. AppKit then places the window into the focused native tab group as part of ordering it onscreen. AppKit remains responsible for tab presentation and grouping; SwiftUI remains responsible for creating the independent scene content.

Runtime verification on macOS 26 found that the app's SwiftUI `WindowGroup` does not provide a responder-chain target for `newWindowForTab:` even when its window is key. The bridge is therefore required, but retains only pending UUID-to-weak-parent intents and removes each intent as soon as its scene resolves. Resolving synchronously is essential because tabbing mode must be set before SwiftUI orders the window. The coordinator also keeps a weak last-content-window reference to bridge the brief interval where SwiftUI clears focused values while repeated new scenes resolve; the reference is accepted only while its window or selected tab remains visible, so closing all windows still takes the standalone fallback. It does not retain application-level tab or window state. UUID correlation makes rapid requests deterministic and avoids mistaking sheets, panels, or unrelated windows for the requested tab.

Explicitly calling `addTabbedWindow` after creating the SwiftUI scene was rejected after runtime testing: even when called synchronously from `viewDidMoveToWindow()`, AppKit visibly adjusted the existing window as it reparented the new window. Marking the new window `.preferred` before ordering produced the expected Safari-like transition with no flash or jump, including rapid repeated commands and multiple independent tab groups.

Changing the scene's keyboard shortcut from Command-N to Command-T was rejected because it would remove the conventional New Window shortcut and would not itself guarantee attachment to the focused tab group.

### D3: Preserve native New Window separately

The automatically supplied File > New Window command and Command-N remain unchanged. Users can therefore choose whether a new launcher appears as a tab in the focused group or as a separate top-level window.

### D4: A new tab does not duplicate the current project

New Tab opens the launcher rather than reopening the focused folder. Starting another server for the same folder would duplicate filesystem watchers, allocate another local port, and create independent terminal sessions that look deceptively shared. The launcher also matches the existing semantics of a newly created window.

### D5: Bind server shutdown to the native window-close notification

Runtime verification found that `ContentView.onDisappear` is not a true window-close signal: focusing another SwiftUI window can make the previous window's content disappear and stop its server. Native tab switching has the same lifecycle risk.

Each `ContentView` resolves its owning `NSWindow` and binds its `UatuServer` to that exact window's `NSWindow.willCloseNotification`. Switching, detaching, and regrouping do not emit this notification; closing the window/tab does. The existing app-termination registry remains the separate all-children shutdown path.

### D6: No focused window falls back to a standalone launcher

When Command-T is invoked without a focused window or tab group, UatuCode opens a normal launcher window. This keeps the command useful after the last window closes while avoiding an invisible or disabled global shortcut.

### D7: Navigate native tab order with Safari-like shortcuts

Tab navigation operates directly on the focused window's `NSWindowTabGroup`. AppKit already supplies Control-Tab and Control-Shift-Tab for native tab groups, so UatuCode preserves those system commands rather than duplicating them. Command-1 through Command-8 select the corresponding zero-based entry in `NSWindowTabGroup.windows`; Command-9 selects the final entry regardless of tab count, matching Safari. Commands are disabled when their destination does not exist and live in the Window menu rather than the embedded web content.

### D8: List tab groups rather than tab backing windows

AppKit represents every native tab as an `NSWindow`, and SwiftUI's default Window menu consequently lists every tab as though it were a separate window. Replacing SwiftUI's automatic window-list command group or changing `NSWindow.isExcludedFromWindowsMenu` interferes with automatic tab attachment, so UatuCode leaves the window model and native command group unchanged. Instead, it filters the generated `makeKeyAndOrderFront:` menu rows: the selected tab's row remains visible and rows targeting non-selected members of the same multi-window tab group are hidden. The filter reruns when AppKit adds Window-menu items and when a window becomes key.

## Risks / Trade-offs

- **[SwiftUI does not service `newWindowForTab:` for this `WindowGroup`]** -> Correlate requested scenes through the data-driven `WindowGroup` and set AppKit's preferred tabbing mode before presentation.
- **[New scene creation is asynchronous]** -> Correlate the request and resolved native window with the data-driven scene UUID rather than relying on notification ordering or a timeout; configure the window synchronously in `viewDidMoveToWindow()`.
- **[Tab switching or regrouping triggers `onDisappear`]** -> Confirmed during runtime verification; cleanup now observes the owning native window's close notification instead.
- **[Command-T conflicts with content handled by the embedded web view]** -> Define the shortcut in the macOS menu command layer so the application-level New Tab behavior wins consistently, as it does in native browser shells.
- **[Automated UI coverage is expensive in the current desktop target]** -> Keep any pure command-routing logic testable where practical, require an Xcode build, and record a concise native-window manual verification matrix in the implementation tasks.

## Migration Plan

This is additive and requires no persisted-data or configuration migration. Ship the desktop app with the new command; rollback consists of removing the command and any tab-creation bridge while leaving existing native Merge All Windows behavior intact.

## Resolved Findings

- SwiftUI's macOS 26 `WindowGroup` does not respond directly to `newWindowForTab:` in this app, so New Tab uses the minimal AppKit tabbing-policy bridge described in D2.
- With no key window there is no native tab destination; the command directly invokes SwiftUI's `openWindow(id:)` action, producing the required standalone launcher.
- The desktop Xcode project has no test target. The remaining behavior is native scene creation, focus routing, and AppKit tab grouping, so introducing test-only window abstractions would not exercise the integration that can regress. Verification therefore uses compiler diagnostics, Debug and CI-equivalent Release builds, process-level server checks, and the native interaction matrix in the tasks.
