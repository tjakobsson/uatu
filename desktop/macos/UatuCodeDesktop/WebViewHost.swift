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

    /// Main-frame navigation failures (host unreachable, TLS refused, the
    /// backing hub gone). ContentView uses this to move the window into its
    /// failed state instead of showing a dead web view.
    var onNavigationFailed: ((String) -> Void)?

    /// A sign-out performed in the page: a main-frame POST to a hub's logout
    /// route. Authoritative — the user asked to sign out — so ContentView
    /// answers it by revoking that hub's stored credentials.
    var onHubSignOut: ((URL) -> Void)?

    /// The page landed on a hub's login route. Advisory: the window's session
    /// is over (a sign-out, an expired cookie, a restarted hub), but unlike
    /// the signal above it does not by itself mean the user asked to sign
    /// out — so it returns the window to the splash without revoking.
    var onHubLoginPage: ((URL) -> Void)?

    let webView: WKWebView
    private var observations: [NSKeyValueObservation] = []
    private var insetObservation: NSKeyValueObservation?
    private weak var insetWindow: NSWindow?
    private var lastInsetPoints: CGFloat = -1
    /// The current covered-chrome height, for native views that need the
    /// same offset the page gets (the split pane pads its chrome with it).
    /// SwiftUI's safeAreaInsets can't be read reliably once a view ignores
    /// the safe area, so the KVO-tracked window value is the one source.
    private(set) var titlebarInset: CGFloat = 0

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

    /// The titlebar-inset contract with the SPA. With `.fullSizeContentView`
    /// the page spans the whole window frame, but macOS WKWebView never
    /// populates `env(safe-area-inset-top)` — the page cannot discover the
    /// strip covered by the floating titlebar/toolbar on its own. The wrapper
    /// announces it instead: a `uatu-desktop-host` class plus a
    /// `--titlebar-inset` custom property on `<html>`. The height comes from
    /// `contentLayoutRect` (ground truth — includes the native tab bar when
    /// present) and is observed so tab-bar appearance updates the live page.
    func bindTitlebarInset(to window: NSWindow) {
        guard insetWindow !== window else { return }
        insetWindow = window
        insetObservation = window.observe(\.contentLayoutRect, options: [.initial, .new]) { [weak self] window, _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let contentHeight = window.contentView?.frame.height ?? window.frame.height
                self.applyTitlebarInset(max(0, contentHeight - window.contentLayoutRect.height))
            }
        }
    }

    private func applyTitlebarInset(_ points: CGFloat) {
        // Half-point granularity: enough for any Retina scale, and it keeps
        // resize-driven KVO storms from re-injecting identical scripts.
        let rounded = (points * 2).rounded() / 2
        guard rounded != lastInsetPoints else { return }
        lastInsetPoints = rounded
        titlebarInset = rounded
        let js = """
        document.documentElement.classList.add("uatu-desktop-host");
        document.documentElement.style.setProperty("--titlebar-inset", "\(rounded)px");
        """
        // Document-start injection is what makes the contract survive the
        // SPA's live-reload (and any reload) with no flash of un-inset
        // layout. This controller carries ONLY the inset script, so a full
        // replace is safe; revisit if other user scripts are ever added.
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // And the same mutation immediately, for the already-loaded page.
        webView.evaluateJavaScript(js)
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

    // WKWebView shows NO JavaScript dialogs unless the app provides them —
    // confirm() silently answers false, which turned the hub dashboard's
    // confirmation-gated actions (Stop, init-and-serve) into dead buttons.
    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        if let window = webView.window {
            alert.beginSheetModal(for: window) { _ in completionHandler() }
        } else {
            alert.runModal()
            completionHandler()
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        if let window = webView.window {
            alert.beginSheetModal(for: window) { response in
                completionHandler(response == .alertFirstButtonReturn)
            }
        } else {
            completionHandler(alert.runModal() == .alertFirstButtonReturn)
        }
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
        // Hub session signals. Both are reported and then ALLOWED: the hub
        // still receives its logout POST (so it clears the browser's cookie,
        // and gets the chance to act on it should it ever revoke server-side),
        // and the login page it redirects to is simply superseded when the
        // window drops back to the splash. Cancelling would keep the web
        // view's cookie alive for no gain.
        //
        // The hub serves both routes at its origin root — a session lives
        // under /s/<id>/ but its sign-out still posts to /logout — so an
        // exact path match is the precise test.
        if let url = navigationAction.request.url {
            if url.path == "/logout", navigationAction.request.httpMethod == "POST" {
                onHubSignOut?(url)
            } else if url.path == "/login" {
                onHubLoginPage?(url)
            }
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        // The hub reaches its login page by REDIRECT — the gate answers an
        // unauthenticated page request with a 303, and logout answers with
        // one too. decidePolicyFor is not guaranteed to run for every
        // server-redirected request, so the committed URL is the reliable
        // place to notice we have landed there. Reporting from both is safe:
        // the handler only returns the window to the splash.
        if let url = webView.url, url.path == "/login" {
            onHubLoginPage?(url)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        reportNavigationFailure(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        reportNavigationFailure(error)
    }

    private func reportNavigationFailure(_ error: Error) {
        let nsError = error as NSError
        // Cancellations are routine (rapid navigation, routed-out links) —
        // only real transport failures should surface. 102 is WebKit's
        // frame-load-interrupted-by-policy-change, raised by our own
        // decidePolicyFor cancels.
        guard !(nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled),
              !(nsError.domain == "WebKitErrorDomain" && nsError.code == 102) else { return }
        onNavigationFailed?(nsError.localizedDescription)
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
