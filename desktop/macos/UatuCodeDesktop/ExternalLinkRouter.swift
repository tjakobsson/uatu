//
//  ExternalLinkRouter.swift
//  UatuCode Desktop
//

import AppKit

/// Single routing point for link activations that leave the embedded
/// WebView. http(s) URLs resolve to the default browser and other schemes
/// (mailto:, editor schemes, …) to their registered handler — both via
/// NSWorkspace today. The split-browser change redirects the http(s)
/// branch in-app.
@MainActor
enum ExternalLinkRouter {
    /// UserDefaults key for the opt-out: when true, external http(s) links
    /// bypass the split browser and open in the default browser.
    static let systemBrowserDefaultsKey = "openExternalLinksInSystemBrowser"

    static func open(_ url: URL) {
        NSWorkspace.shared.open(url)
    }
}
