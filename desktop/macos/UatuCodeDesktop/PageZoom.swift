//
//  PageZoom.swift
//  UatuCode Desktop
//

import Foundation

/// The shared page-zoom model: Safari's zoom ladder plus the persisted
/// app-wide level. Keyboard zoom steps the ladder and applies to every web
/// surface; pinch magnification is a separate, transient per-web-view axis
/// and never touches this.
enum PageZoom {
    /// Safari's zoom steps. ⌘0 lands exactly on 1.0.
    static let ladder: [Double] = [0.5, 0.75, 0.85, 1.0, 1.15, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0]

    /// UserDefaults key backing the shared level (`@AppStorage` on the
    /// SwiftUI side reads the same key).
    static let defaultsKey = "pageZoom"

    /// The persisted shared level; an unset key means 100%.
    static var storedLevel: Double {
        let value = UserDefaults.standard.double(forKey: defaultsKey)
        return value == 0 ? 1.0 : value
    }

    static func canZoomIn(from level: Double) -> Bool {
        nearestIndex(of: level) < ladder.count - 1
    }

    static func canZoomOut(from level: Double) -> Bool {
        nearestIndex(of: level) > 0
    }

    /// The next ladder step up, clamped at the top. A level off the ladder
    /// (hand-edited defaults) snaps to its nearest step first.
    static func zoomedIn(from level: Double) -> Double {
        ladder[min(nearestIndex(of: level) + 1, ladder.count - 1)]
    }

    /// The next ladder step down, clamped at the bottom.
    static func zoomedOut(from level: Double) -> Double {
        ladder[max(nearestIndex(of: level) - 1, 0)]
    }

    private static func nearestIndex(of level: Double) -> Int {
        ladder.indices.min { abs(ladder[$0] - level) < abs(ladder[$1] - level) } ?? 0
    }
}
