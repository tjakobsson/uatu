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
}

extension BrowserTab: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        // target="_blank" / window.open inside a browser page: another tab.
        if let url = navigationAction.request.url {
            split?.open(url)
        }
        return nil
    }
}

extension BrowserTab: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            split?.open(url)
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
}

/// Per-window split browser state: an ordered set of tabs plus selection.
/// Open tabs are session-scoped (never restored across relaunch); the
/// website data store is persistent so logins survive.
@MainActor
@Observable
final class BrowserSplit {
    private(set) var tabs: [BrowserTab] = []
    var selectedID: BrowserTab.ID?
    private(set) var isOpen = false
    /// Mirrored from the address bar's SwiftUI focus so shortcut routing
    /// counts "typing in the address bar" as browser focus.
    var addressBarFocused = false

    /// Shared persistent store, distinct from the SPA WebView's default
    /// store. The identifier is fixed so every launch reopens it.
    static let dataStore = WKWebsiteDataStore(
        forIdentifier: UUID(uuidString: "7C1C41F6-9E4B-4E8E-9B7B-2A61F3B3D9A0")!
    )

    var selectedTab: BrowserTab? {
        tabs.first { $0.id == selectedID }
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

    func close(_ tab: BrowserTab) {
        guard let index = tabs.firstIndex(where: { $0.id == tab.id }) else { return }
        tabs.remove(at: index)
        if selectedID == tab.id {
            selectedID = tabs.indices.contains(index) ? tabs[index].id : tabs.last?.id
        }
        if tabs.isEmpty {
            isOpen = false
        }
    }

    /// Whether keyboard shortcuts should act on the browser rather than
    /// the uatu pane, judged by the window's first responder at press time.
    func hasFocus(in window: NSWindow?) -> Bool {
        guard isOpen else { return false }
        if addressBarFocused { return true }
        guard let view = window?.firstResponder as? NSView else { return false }
        return tabs.contains { view === $0.webView || view.isDescendant(of: $0.webView) }
    }
}
