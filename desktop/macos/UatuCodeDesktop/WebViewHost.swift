//
//  WebViewHost.swift
//  UatuCode Desktop
//

import AppKit
import SwiftUI
import WebKit

/// Hosts the uatu SPA in a WKWebView rather than SwiftUI's WebPage.
///
/// WebPage has no equivalent of `WKUIDelegate.createWebViewWith`, so
/// navigations that target a new browsing context — `target="_blank"`
/// anchors in rendered docs and the `window.open()` calls xterm.js makes
/// for OSC 8 terminal hyperlinks — are silently dropped. WKWebView lets us
/// catch them and hand the URL to `ExternalLinkRouter` instead.
@MainActor
@Observable
final class WebViewHost: NSObject {
    private(set) var canGoBack = false
    private(set) var canGoForward = false

    /// Where external link activations go. The Bool is "⌘ was held".
    /// Unset, everything routes straight to the system via
    /// ExternalLinkRouter; ContentView installs the split-browser routing.
    var routeExternal: ((URL, Bool) -> Void)?

    let webView: WKWebView
    private var observations: [NSKeyValueObservation] = []

    override init() {
        webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        webView.pageZoom = PageZoom.storedLevel
        observations = [
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

    fileprivate func routeOut(_ navigationAction: WKNavigationAction) {
        guard let url = navigationAction.request.url else { return }
        let commandClick = navigationAction.modifierFlags.contains(.command)
        if let routeExternal {
            routeExternal(url, commandClick)
        } else {
            ExternalLinkRouter.open(url)
        }
    }
}

extension WebViewHost: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        // window.open() and target="_blank" land here; route the URL out
        // of the app instead of spawning a web view.
        routeOut(navigationAction)
        return nil
    }
}

extension WebViewHost: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        // Belt and braces for new-window actions that skip the UI delegate.
        if navigationAction.targetFrame == nil {
            routeOut(navigationAction)
            decisionHandler(.cancel)
            return
        }
        // Non-web schemes (mailto:, editor schemes) aren't _blank-marked, so
        // they arrive as main-frame link clicks. Allowing one starts a
        // provisional navigation WebKit can never commit, which aborts the
        // SPA's live-reload stream — cancel and route to the system instead.
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

/// SwiftUI wrapper exposing the host's WKWebView.
struct HostedWebView: NSViewRepresentable {
    let host: WebViewHost

    func makeNSView(context: Context) -> WKWebView {
        host.webView
    }

    func updateNSView(_ view: WKWebView, context: Context) {}
}
