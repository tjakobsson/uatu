## Context

See proposal.md for motivation. What shapes the approach:

- Both WebKit hosts are `WKWebView`s with a `WKUIDelegate`: `WebViewHost` (the uatu SPA) implements `createWebViewWith`, `runJavaScriptAlertPanelWithMessage`, and `runJavaScriptConfirmPanelWithMessage`; `BrowserTab` (one per split-browser tab) implements only `createWebViewWith`. Neither implements `runJavaScriptTextInputPanelWithPrompt` (prompt) or `runOpenPanelWith` (file chooser).
- WKWebView's contract for the missing methods is that the completion handler is called with the default answer immediately: false for confirm, nil for prompt, nothing for alert, no files for the chooser. That is the "muted dialog".
- The hosts already present alert/confirm as `NSAlert` sheets on `webView.window`, falling back to `runModal()` when the view has no window. Browser tabs that are not selected are not in the view hierarchy (`BrowserTabWebView` mounts only the selected tab), so `webView.window` is nil for them — the fallback would run an app-modal dialog for a page the user cannot see.
- The project has no test target; CI runs `xcodebuild`.

## Goals / Non-Goals

**Goals:**
- Every JavaScript dialog and the file chooser present natively in both hosts with correct return values.
- One presenter shared by both hosts.
- A background tab's dialog never blocks the selected tab or runs app-modal.

**Non-Goals:**
- `beforeunload` (WebKit handles it as a confirm only in Safari; WKWebView exposes no delegate for it).
- HTTP auth challenges, media-capture permission, geolocation, and web notifications — separate delegate surfaces, none reported broken.
- Restyling `NSAlert`.

## Decisions

**D1. A shared `WebDialogPresenter` used by both `WKUIDelegate`s.**
A small `@MainActor` enum/struct with `alert(message, in window)`, `confirm(...)`, `prompt(message, default, in window)`, and `openPanel(parameters, in window)`, each taking a completion handler. Both delegates forward to it. Alternative: copy the methods into `BrowserTab` — that is how the two drifted apart in the first place.

**D2. Dialogs are sheets on the web view's window; a tab without a window defers instead of going modal.**
For the uatu host, `webView.window` is always set once shown, so the sheet path stands and the `runModal()` fallback stays for the pre-window edge. For a `BrowserTab`, a nil window means the tab is not selected: the presenter is queued on the tab and run when `BrowserTabWebView` mounts it (the tab already observes selection through the split), which gives the spec's background-tab rule for free. In the implementation the trigger is the tab web view's own `viewDidMoveToWindow` (a small `WKWebView` subclass): `makeNSView` runs before the view has a window, and the window callback also covers the split being reopened, not only a tab switch. If the tab is closed while a dialog is pending, the completion handler is called with the default answer so WebKit is never left hanging.

**D3. `prompt()` is an `NSAlert` with an `NSTextField` accessory view.**
Standard AppKit pattern: message text, a 300-pt-wide single-line field prefilled with the default, OK/Cancel; OK returns the field's string, Cancel returns nil. The field is made first responder when the sheet begins so typing works without a click.

**D4. The file chooser is `NSOpenPanel` honouring `WKOpenPanelParameters`.**
`allowsMultipleSelection` from the parameters, `canChooseDirectories` from `allowsDirectories`, files only otherwise; the completion gets the chosen URLs or nil on cancel. Presented as a sheet on the window like the dialogs, with the same deferral rule for background tabs.

**D5. Completion handlers are called exactly once, on the main actor.**
Every path — sheet response, modal response, deferred-then-presented, closed-while-pending — ends in one call. WebKit crashes on a second call and hangs the page on none.

## Risks / Trade-offs

- [A page in a background tab waits indefinitely on a deferred dialog] → This is Safari's behaviour too; the tab's title can still update, and selecting the tab presents it. Closing the tab answers the default so the page is not leaked.
- [Sheets on a window that is miniaturized or hidden] → AppKit queues the sheet until the window is visible; no special handling.
- [Two dialogs from the same page in quick succession] → WebKit serializes them per page; the presenter handles one completion at a time per host.
- [No automated test] → CI proves it builds; a manual checklist in tasks.md covers each dialog type in both hosts, including the hub dashboard's stop confirmation and private-key file input.
