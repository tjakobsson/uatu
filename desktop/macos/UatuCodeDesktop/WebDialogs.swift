//
//  WebDialogs.swift
//  UatuCode Desktop
//

import AppKit
import WebKit

/// Native presentations for a web page's JavaScript dialogs and file chooser.
///
/// WKWebView shows none of these unless the app implements them: `alert()`
/// vanishes, `confirm()` silently answers false, `prompt()` answers null,
/// and `<input type="file">` never opens. Both web hosts — the uatu SPA's
/// `WebViewHost` and every split-browser `BrowserTab` — forward to these
/// presenters, so the two cannot drift apart again.
///
/// Each presenter attaches a sheet to `window`, or runs app-modal when no
/// window is given, and calls its completion exactly once: WebKit hangs the
/// page on no call and raises on a second one.
enum WebDialogs {
    static func alert(_ message: String, in window: NSWindow?, completion: @escaping () -> Void) {
        let answer = Once(completion)
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        present(alert, in: window) { _ in answer.call() }
    }

    static func confirm(_ message: String, in window: NSWindow?, completion: @escaping (Bool) -> Void) {
        let answer = Once(completion)
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        present(alert, in: window) { response in answer.call(response == .alertFirstButtonReturn) }
    }

    /// `prompt()`: the page's default text prefilled and selected, OK returns
    /// the field's text (possibly empty), Cancel returns nil (null to the page).
    static func prompt(_ message: String, defaultText: String?, in window: NSWindow?, completion: @escaping (String?) -> Void) {
        let answer = Once(completion)
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 300, height: 24)
        field.usesSingleLineMode = true
        field.lineBreakMode = .byClipping
        field.cell?.isScrollable = true
        alert.accessoryView = field
        // Typing works at once, with no click into the field first.
        alert.window.initialFirstResponder = field
        present(alert, in: window) { response in
            answer.call(response == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }

    /// `<input type="file">`: the system open panel, choosing several items
    /// only when the input asks for them, and directories instead of files for
    /// a directory input (`webkitdirectory`), as Safari does. Cancel returns
    /// nil, which WebKit reports to the page as no files chosen.
    static func openPanel(_ parameters: WKOpenPanelParameters, in window: NSWindow?, completion: @escaping ([URL]?) -> Void) {
        let answer = Once(completion)
        let panel = NSOpenPanel()
        panel.canChooseFiles = !parameters.allowsDirectories
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.resolvesAliases = true
        let finish: (NSApplication.ModalResponse) -> Void = { response in
            answer.call(response == .OK ? panel.urls : nil)
        }
        if let window {
            panel.beginSheetModal(for: window, completionHandler: finish)
        } else {
            finish(panel.runModal())
        }
    }

    private static func present(_ alert: NSAlert, in window: NSWindow?, then finish: @escaping (NSApplication.ModalResponse) -> Void) {
        if let window {
            alert.beginSheetModal(for: window, completionHandler: finish)
        } else {
            finish(alert.runModal())
        }
    }
}

/// A completion that runs at most once, however many paths reach it.
private final class Once<Value> {
    private var completion: ((Value) -> Void)?

    init(_ completion: @escaping (Value) -> Void) {
        self.completion = completion
    }

    func call(_ value: Value) {
        guard let completion else { return }
        self.completion = nil
        completion(value)
    }
}

private extension Once where Value == Void {
    convenience init(_ completion: @escaping () -> Void) {
        self.init { (_: Void) in completion() }
    }

    func call() {
        call(())
    }
}

/// A dialog a background browser tab raised while it had no window to
/// attach to. It is shown when the tab is next on screen (`show`), or
/// answered with the page's default when the tab goes away first (`dismiss`,
/// also run if the entry is dropped unanswered) — never both, never neither.
final class DeferredWebDialog {
    private var show: ((NSWindow) -> Void)?
    private var dismiss: (() -> Void)?

    init(show: @escaping (NSWindow) -> Void, dismiss: @escaping () -> Void) {
        self.show = show
        self.dismiss = dismiss
    }

    func present(in window: NSWindow) {
        guard let show else { return }
        self.show = nil
        dismiss = nil
        show(window)
    }

    func answerDefault() {
        guard let dismiss else { return }
        show = nil
        self.dismiss = nil
        dismiss()
    }

    isolated deinit {
        answerDefault()
    }
}
