//
//  TitlebarDragArea.swift
//  UatuCode Desktop
//

import AppKit
import SwiftUI

/// Restores window dragging in the titlebar strip over the web view.
///
/// With `.fullSizeContentView` the page spans the whole frame, and the OS
/// passes titlebar-strip mouse events through to the WKWebView instead of
/// keeping them for window dragging (observed on macOS 26: drags over the
/// page do nothing and double-clicks select page text under the toolbar —
/// while the strip over plain SwiftUI, like the split pane, still drags).
/// This transparent view sits over the web view and claims exactly the
/// covered strip: drags move the window, double-clicks perform the system
/// titlebar action, and page content under the strip stops being
/// interactive — matching real titlebar behavior and the
/// desktop-macos-shell spec. Toolbar controls, traffic lights, and the
/// native tab bar live in the titlebar layer above this view, so they keep
/// winning hit-tests.
struct TitlebarDragArea: NSViewRepresentable {
    /// Height of the covered strip, from the host's contentLayoutRect
    /// observation (the same value announced to the page as
    /// `--titlebar-inset`).
    var inset: CGFloat

    func makeNSView(context: Context) -> TitlebarDragNSView {
        let view = TitlebarDragNSView()
        view.inset = inset
        return view
    }

    func updateNSView(_ view: TitlebarDragNSView, context: Context) {
        view.inset = inset
    }
}

final class TitlebarDragNSView: NSView {
    var inset: CGFloat = 0

    override var isFlipped: Bool { true }

    /// The view spans the full content frame (which sidesteps safe-area
    /// layout entirely) but claims only points inside the covered strip;
    /// everything below falls through to the web view.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard inset > 0 else { return nil }
        let local = convert(point, from: superview)
        guard bounds.contains(local), local.y < inset else { return nil }
        return self
    }

    /// A real titlebar drags even when the window is not key.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            performTitlebarDoubleClickAction()
            return
        }
        window?.performDrag(with: event)
    }

    /// Mirror the system titlebar double-click behavior, which AppKit does
    /// not expose as an action: the user's Desktop & Dock preference decides
    /// between zoom and minimize ("Fill" and the unset default both zoom).
    private func performTitlebarDoubleClickAction() {
        switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
        case "Minimize":
            window?.performMiniaturize(nil)
        case "None":
            break
        default:
            window?.performZoom(nil)
        }
    }
}
