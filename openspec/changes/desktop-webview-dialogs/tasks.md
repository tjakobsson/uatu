## 1. Shared presenter

- [x] 1.1 Add `desktop/macos/UatuCodeDesktop/WebDialogs.swift` with a `@MainActor` presenter offering `alert`, `confirm`, `prompt` (NSAlert + NSTextField accessory, default text prefilled, field first responder), and `openPanel` (NSOpenPanel from `WKOpenPanelParameters`: multiple selection and directories per the parameters), each presented as a sheet on a given window with a `runModal` fallback when no window is given, and each calling its completion exactly once. Verify: `xcodebuild -project desktop/macos/UatuCodeDesktop.xcodeproj -scheme UatuCodeDesktop build` succeeds.
- [ ] 1.2 Move `WebViewHost`'s alert/confirm bodies onto the presenter and add `runJavaScriptTextInputPanelWithPrompt` and `runOpenPanelWith` delegate methods that forward to it. Verify in the built app against the dev hub: the dashboard's Stop confirmation still works, a `prompt("x","d")` run from a page returns `d` on OK and null on Cancel, and the credentials page's "Private key file" input opens the system picker and shows the chosen file name.

## 2. Split-browser tabs

- [x] 2.1 Give `BrowserTab` the four delegate methods (alert, confirm, prompt, open panel) forwarding to the presenter, with a per-tab pending-dialog slot: when `webView.window` is nil (tab not selected) the presentation is queued and run when the tab is mounted; closing a tab with a pending dialog answers it with the default. Verify by build.
- [ ] 2.2 Hook the pending slot into `BrowserTabWebView.makeNSView`/`updateNSView` (or the split's selection change) so a queued dialog presents when the tab becomes selected. Verify in the built app: open a page that calls `confirm()` on a button in tab A, switch to tab B before it fires (use a `setTimeout` test page or a page with a delayed confirm), confirm no dialog appears over B, switch back to A and see the dialog, answer it, and observe the page acted on the answer.

## 3. Manual verification and evidence

- [ ] 3.1 Run the checklist in the built app and record the results in the PR: in the uatu host — alert, confirm (true/false), prompt (text/null), file input; in a browser tab — alert, confirm (true/false), prompt (text/null), file input, and the background-tab deferral. Save a screenshot of a confirm sheet in a browser tab and of the prompt sheet under `openspec/changes/desktop-webview-dialogs/screenshots/`.
- [ ] 3.2 Confirm desktop CI (`.github/workflows/desktop-ci.yml`) passes on the PR.
