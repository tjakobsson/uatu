## 1. Verify Native Window Behavior

- [x] 1.1 Run the desktop app on macOS 26 and verify whether the SwiftUI `WindowGroup` responder chain handles `newWindowForTab:` with a focused window; record the result and chosen path in `design.md`.
- [x] 1.2 Verify the no-open-window case for `newWindowForTab:` and determine whether it naturally creates a standalone scene or requires an explicit SwiftUI window-opening fallback.
- [x] 1.3 With two running folders merged as native tabs, verify that switching, detaching, regrouping, and closing one tab preserve the server lifecycle required by the delta spec.

## 2. Add Native New Tab

- [x] 2.1 Add File > New Tab with Command-T to the desktop scene commands, correlating the requested SwiftUI scene and marking its native window as a preferred AppKit tab before presentation.
- [x] 2.2 Add the minimal standalone-launcher fallback for Command-T with no focused window; if task 1.1 found that SwiftUI does not service the native action, add the narrowest scene-to-`NSWindow` bridge needed to attach the new window through AppKit without an application-level tab registry.
- [x] 2.3 Preserve SwiftUI's standard File > New Window and Command-N behavior and confirm a new window is not forcibly attached to the focused tab group.
- [x] 2.4 Change server cleanup from `onDisappear` to a scene-scoped native close signal only if task 1.3 demonstrates that a non-closing tab operation stops its server.

## 3. Verification

- [x] 3.1 Add focused automated coverage for any command-routing or fallback logic that can be exercised independently of AppKit UI; if the final implementation is responder-only, document why native interaction remains manually verified instead of adding a test-only abstraction.
- [x] 3.2 Build the bundled `uatu` binary and the `UatuCodeDesktop` Xcode scheme using the same path exercised by desktop CI.
- [x] 3.3 Manually verify Command-T with one focused window, multiple separate window groups, and no open window; confirm each new tab starts on the blank launcher and Command-N still creates a separate window.
- [x] 3.4 Manually verify two tabs serving different folders: switching and moving tabs preserve both sessions, closing one tab stops only its server, and quitting the app stops all remaining servers.

## 4. Safari-Like Tab Navigation

- [x] 4.1 Preserve AppKit's existing Control-Tab / Control-Shift-Tab behavior and add Window-menu commands for Command-1 through Command-8 positional selection and Command-9 last-tab selection using the focused native tab group.
- [x] 4.2 Build and manually verify next, previous, numbered, last-tab, unavailable-destination, and single-window behavior.
- [x] 4.3 Filter SwiftUI's generated per-tab window rows so the Window menu shows one entry per native tab group or standalone window, then build and manually verify grouped and separate-window behavior.
