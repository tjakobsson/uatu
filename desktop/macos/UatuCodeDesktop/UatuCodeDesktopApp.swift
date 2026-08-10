//
//  UatuCodeDesktopApp.swift
//  UatuCode Desktop
//

import AppKit
import SwiftUI

/// The app is a pure hub client: it runs no server of its own, so there is
/// no process to supervise at launch and nothing to warn about at quit —
/// sessions belong to hubs and keep running when the app exits.
@main
struct UatuCodeDesktopApp: App {
    var body: some Scene {
        WindowGroup(id: "main", for: UUID.self) { $windowID in
            ContentView(windowID: windowID)
        } defaultValue: {
            UUID()
        }
        // Compact toolbar: native tabs share the title row instead of
        // drawing a separate full-width tab strip (whose top hairline read
        // as a stray line over the page).
        .windowToolbarStyle(.unifiedCompact)
        .commands {
            UatuCodeDesktopCommands()
        }
    }
}
