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

    let webView: WKWebView
    private var observations: [NSKeyValueObservation] = []

    override init() {
        webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
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
        if let url = navigationAction.request.url {
            ExternalLinkRouter.open(url)
        }
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
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
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
