## Why

In UatuCode Desktop, JavaScript dialogs raised by pages in the split browser never appear: WKWebView shows no `alert()`, `confirm()`, or `prompt()` unless the app implements them, and the split browser's tabs implement only `window.open` routing. A page's `confirm()` silently answers false, so its confirmation-gated actions are dead buttons and its `alert()` messages vanish. The main uatu WebView handles `alert()`/`confirm()` but not `prompt()` or the file chooser, so the hub dashboard's "Private key file" input cannot open a picker in the app either.

## What Changes

- **Split-browser tabs present JavaScript dialogs natively.** `alert()`, `confirm()`, and `prompt()` raised by a page in a browser tab present as native panels attached to the window, and the user's answer is returned to the page. A dialog from a background tab is not shown until that tab is selected; the page keeps waiting, as it would in Safari.
- **The main uatu WebView gains `prompt()` and the file chooser.** `prompt()` presents a native panel with a text field; `<input type="file">` opens the system open panel (single or multiple files as the input asks) and returns the chosen files to the page.
- **Split-browser tabs get the file chooser too**, so a page opened in the split can upload.
- **One implementation for both hosts.** The dialog and file-chooser presenters are shared by the uatu host and the browser tabs, so the two cannot drift again.
- **Out of scope:** `beforeunload` prompts, HTTP authentication challenges, media-capture permission prompts, and web notifications inside the app.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `desktop-macos-shell`: "Web page JavaScript dialogs present natively" is modified to cover `prompt()` and the file chooser in the embedded uatu WebView.
- `desktop-split-browser`: a new requirement says browser tabs present JavaScript dialogs and the file chooser natively, with the background-tab rule.

## Impact

- `desktop/macos/UatuCodeDesktop/BrowserSplit.swift`: `BrowserTab`'s `WKUIDelegate` gains the alert, confirm, prompt, and open-panel delegate methods.
- `desktop/macos/UatuCodeDesktop/WebViewHost.swift`: gains prompt and open-panel; its alert/confirm move to the shared presenter.
- A new `desktop/macos/UatuCodeDesktop/WebDialogs.swift` (or similar) holding the shared native presenters.
- No change to the web app, the hub, or the API. Desktop CI (`desktop-ci.yml`) builds the change; there is no desktop test target, so the dialog behaviour is verified by hand in the built app.
