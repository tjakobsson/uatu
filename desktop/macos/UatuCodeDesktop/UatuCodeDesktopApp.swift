//
//  UatuCodeDesktopApp.swift
//  UatuCode Desktop
//

import AppKit
import SwiftUI

@main
struct UatuCodeDesktopApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

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

/// Owns the app-level lifecycle: launching the single local hub at startup
/// and intercepting quit so sessions with live terminal shells are never
/// destroyed silently.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var teardownComplete = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        LocalHubController.shared.startIfNeeded()
    }

    /// The quit decision table:
    ///   no running local sessions, or none with live shells → quit silently
    ///   otherwise → confirm, listing each workspace and its shell count
    /// Remote sessions never appear here — quitting the app cannot stop
    /// them. Confirmed quits SIGTERM the hub (which stops its children)
    /// before the app exits; the hub's stdin backstop covers force-quit.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if teardownComplete {
            return .terminateNow
        }
        Task { @MainActor in
            let sessions = await LocalHubController.shared.sessionsWithLiveShells(timeout: 1.5)
            if !sessions.isEmpty && !Self.confirmQuit(sessions: sessions) {
                sender.reply(toApplicationShouldTerminate: false)
                return
            }
            await LocalHubController.shared.terminateAndWait()
            self.teardownComplete = true
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    private static func confirmQuit(sessions: [LocalHubController.LiveSession]) -> Bool {
        let alert = NSAlert()
        alert.messageText = sessions.count == 1
            ? "A session on This Mac will stop"
            : "\(sessions.count) sessions on This Mac will stop"
        let lines = sessions.map { session in
            "\(session.id) — \(session.shellCount) terminal\(session.shellCount == 1 ? "" : "s")"
        }
        alert.informativeText = lines.joined(separator: "\n") + "\n\nRemote sessions are unaffected."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }
}
