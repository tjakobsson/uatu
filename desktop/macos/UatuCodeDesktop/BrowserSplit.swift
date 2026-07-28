//
//  BrowserSplit.swift
//  UatuCode Desktop
//

import AppKit
import WebKit

/// One page in the split browser. Owns its WKWebView so the page — and its
/// back-forward history — survives tab switches without reloading.
@MainActor
@Observable
final class BrowserTab: NSObject, Identifiable {
    let id = UUID()
    private(set) var title = ""
    private(set) var url: URL?
    private(set) var canGoBack = false
    private(set) var canGoForward = false

    let webView: WKWebView
    private weak var split: BrowserSplit?
    private var observations: [NSKeyValueObservation] = []

    init(split: BrowserSplit) {
        self.split = split
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = BrowserSplit.dataStore
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        webView.pageZoom = PageZoom.storedLevel
        observations = [
            webView.observe(\.title, options: [.initial, .new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.title = view.title ?? "" }
            },
            webView.observe(\.url, options: [.initial, .new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.url = view.url }
            },
            webView.observe(\.canGoBack, options: [.initial, .new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.canGoBack = view.canGoBack }
            },
            webView.observe(\.canGoForward, options: [.initial, .new]) { [weak self] view, _ in
                MainActor.assumeIsolated { self?.canGoForward = view.canGoForward }
            },
        ]
    }

    // Find state belongs to the tab, not the split: switching tabs must not
    // carry one page's match onto another, and closing a tab discards it.
    var findQuery = "" {
        didSet {
            guard findQuery != oldValue else { return }
            findState = .idle
            if findQuery.isEmpty {
                clearFindSelection()
            } else {
                find(backwards: false)
            }
        }
    }
    var findCaseSensitive = false {
        didSet {
            guard findCaseSensitive != oldValue, !findQuery.isEmpty else { return }
            find(backwards: false)
        }
    }
    private(set) var findState: FindState = .idle

    enum FindState {
        case idle
        case found
        case notFound
    }

    /// Run WebKit's own find. `WKFindResult` reports only whether a match was
    /// found — there is no count available, which is why the bar shows a
    /// found/not-found state rather than a position.
    func find(backwards: Bool) {
        guard !findQuery.isEmpty else {
            clearFindSelection()
            return
        }
        let configuration = WKFindConfiguration()
        configuration.backwards = backwards
        configuration.caseSensitive = findCaseSensitive
        configuration.wraps = true
        webView.find(findQuery, configuration: configuration) { [weak self] result in
            MainActor.assumeIsolated {
                self?.findState = result.matchFound ? .found : .notFound
            }
        }
    }

    /// Drop the find selection. WebKit exposes no "clear find" call — finding
    /// selects the match — so clearing means clearing the page's selection.
    func clearFindSelection() {
        findState = .idle
        webView.evaluateJavaScript("window.getSelection()?.removeAllRanges()")
    }

    func resetFind() {
        findQuery = ""
        findState = .idle
        clearFindSelection()
    }

    func load(_ url: URL) {
        webView.load(URLRequest(url: url))
    }

    func reload() {
        webView.reload()
    }

    func goBack() {
        webView.goBack()
    }

    func goForward() {
        webView.goForward()
    }

    /// D3 routing for URLs leaving this page: http(s) stays in the split,
    /// anything else goes to its system handler (a tab.load of e.g.
    /// mailto: would leave a permanently blank tab).
    fileprivate func routeIncoming(_ url: URL?) {
        guard let url else { return }
        let scheme = url.scheme?.lowercased()
        if scheme == "http" || scheme == "https" {
            split?.open(url)
        } else {
            ExternalLinkRouter.open(url)
        }
    }
}

extension BrowserTab: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        // target="_blank" / window.open inside a browser page: another tab.
        routeIncoming(navigationAction.request.url)
        return nil
    }
}

extension BrowserTab: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if navigationAction.targetFrame == nil {
            routeIncoming(navigationAction.request.url)
            decisionHandler(.cancel)
            return
        }
        // Same trap as the SPA host: an allowed main-frame navigation to a
        // scheme WebKit can't commit aborts the page. Route it out instead.
        if navigationAction.navigationType == .linkActivated,
           let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased(),
           scheme != "http", scheme != "https" {
            ExternalLinkRouter.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // The navigation replaced the page, so the find selection and the
        // found/not-found state describe a document that no longer exists.
        // With the bar open over this tab, rerun the query against the new
        // page; otherwise just drop the stale state — the retained query
        // reruns when the bar reopens. Selectedness matters: a background
        // tab finishing a load must not steal the selection with a find.
        if split?.findOpen == true, split?.selectedID == id, !findQuery.isEmpty {
            find(backwards: false)
        } else {
            findState = .idle
        }
    }
}

/// Per-window split browser state: an ordered set of tabs plus selection.
/// Open tabs are session-scoped (never restored across relaunch); the
/// website data store is persistent so logins survive.
@MainActor
@Observable
final class BrowserSplit {
    private(set) var tabs: [BrowserTab] = []
    var selectedID: BrowserTab.ID? {
        didSet {
            guard selectedID != oldValue else { return }
            // One tab's match must not linger while another is on screen.
            tabs.first { $0.id == oldValue }?.clearFindSelection()
            // And the incoming tab's retained query comes back to life: with
            // the bar open, returning to a tab that had a query would
            // otherwise show that query idle, with no selected match, until
            // the user edited it.
            if findOpen, let tab = selectedTab, !tab.findQuery.isEmpty {
                tab.find(backwards: false)
            }
        }
    }
    private(set) var isOpen = false {
        // The address-bar focus flag can outlive the pane (the field
        // unmounts before its focus change fires); a stale true would make
        // the key monitor steal ⌘W/⌘[/⌘] after reopening.
        didSet { if !isOpen { addressBarFocused = false } }
    }
    /// Mirrored from the address bar's SwiftUI focus so shortcut routing
    /// counts "typing in the address bar" as browser focus.
    var addressBarFocused = false
    /// The window this split lives in. Key events are claimed only for
    /// this window — every window installs an app-wide monitor, so
    /// without the check one window's split could swallow another's ⌘W.
    weak var hostWindow: NSWindow?

    /// Shared persistent store, distinct from the SPA WebView's default
    /// store. The identifier is fixed so every launch reopens it.
    static let dataStore = WKWebsiteDataStore(
        forIdentifier: UUID(uuidString: "7C1C41F6-9E4B-4E8E-9B7B-2A61F3B3D9A0")!
    )

    var selectedTab: BrowserTab? {
        tabs.first { $0.id == selectedID }
    }

    /// Whether the find bar is showing over the selected tab. Find itself is
    /// per-tab state; this is only whether the control is on screen.
    private(set) var findOpen = false
    /// Bumped on every ⌘F so an already-open bar re-focuses its query field,
    /// the way pressing the shortcut twice behaves everywhere else.
    private(set) var findFocusToken = 0
    /// Mirrored from the find field's SwiftUI focus. Typing in the bar is not
    /// "the web view has focus", so Escape needs this to reach `closeFind`.
    var findBarFocused = false

    /// ⌘F with the split focused. No-ops when there is no page to search
    /// rather than falling through to another surface — searching the document
    /// because the browser had nothing would be worse than doing nothing.
    func openFind() {
        guard isOpen, selectedTab != nil else { return }
        let wasOpen = findOpen
        findOpen = true
        findFocusToken += 1
        // A dismissed bar keeps its query, but `closeFind` cleared the match
        // selection — reopening would otherwise show a query with nothing
        // selected until the user edits it. Rerun it on a fresh open only:
        // ⌘F on an already-open bar re-focuses the field and must not jump
        // the selection to the next match.
        if !wasOpen, let tab = selectedTab, !tab.findQuery.isEmpty {
            tab.find(backwards: false)
        }
    }

    func closeFind() {
        guard findOpen else { return }
        findOpen = false
        selectedTab?.clearFindSelection()
        // Back to the page, so it stays scrollable without a click.
        if let webView = selectedTab?.webView {
            webView.window?.makeFirstResponder(webView)
        }
    }

    func findNext(backwards: Bool) {
        selectedTab?.find(backwards: backwards)
    }

    /// Whether the browser — not the SPA — should receive ⌘F / ⌘G right now.
    ///
    /// Broader than `hasFocus(in:)` on purpose: once the find bar opens, focus
    /// moves into its SwiftUI text field, which is neither a tab web view nor
    /// the address bar. Judging by `hasFocus` alone would send the *next* ⌘F
    /// straight past the bar the user is typing in and into the document
    /// hidden behind the split.
    func ownsFindShortcut(in window: NSWindow?) -> Bool {
        if hasFocus(in: window) {
            return true
        }
        guard isOpen, findOpen, findBarFocused else { return false }
        // Same window check `hasFocus` makes: every window installs an
        // app-wide monitor, so one window's split must not claim another's key.
        guard let window else { return true }
        return window === hostWindow
    }

    func toggle() {
        if isOpen {
            isOpen = false
        } else {
            isOpen = true
            if tabs.isEmpty {
                newTab()
            }
        }
    }

    func newTab(url: URL? = nil) {
        let tab = BrowserTab(split: self)
        tabs.append(tab)
        selectedID = tab.id
        if let url {
            tab.load(url)
        }
    }

    /// Routing for external links: focus an existing tab already showing
    /// exactly this URL, otherwise a new focused tab; opens the split if
    /// it was closed.
    func open(_ url: URL) {
        isOpen = true
        if let existing = tabs.first(where: { $0.url == url }) {
            selectedID = existing.id
            return
        }
        newTab(url: url)
    }

    /// Live reorder while dragging: the dragged tab takes the slot of the
    /// tab it is currently hovering over.
    func move(_ draggedID: BrowserTab.ID, to targetID: BrowserTab.ID) {
        guard draggedID != targetID,
              let from = tabs.firstIndex(where: { $0.id == draggedID }),
              let to = tabs.firstIndex(where: { $0.id == targetID }) else { return }
        let tab = tabs.remove(at: from)
        tabs.insert(tab, at: to)
    }

    func close(_ tab: BrowserTab) {
        guard let index = tabs.firstIndex(where: { $0.id == tab.id }) else { return }
        tabs.remove(at: index)
        if selectedID == tab.id {
            selectedID = tabs.indices.contains(index) ? tabs[index].id : tabs.last?.id
        }
        tab.resetFind()
        if tabs.isEmpty {
            isOpen = false
            findOpen = false
        }
    }

    /// Whether keyboard shortcuts should act on the browser rather than
    /// the uatu pane, judged by the window's first responder at press time.
    func hasFocus(in window: NSWindow?) -> Bool {
        guard isOpen, let window, window === hostWindow else { return false }
        if addressBarFocused { return true }
        guard let view = window.firstResponder as? NSView else { return false }
        return tabs.contains { view === $0.webView || view.isDescendant(of: $0.webView) }
    }
}
