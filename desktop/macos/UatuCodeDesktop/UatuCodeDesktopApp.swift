//
//  UatuCodeDesktopApp.swift
//  UatuCode Desktop
//

import SwiftUI

@main
struct UatuCodeDesktopApp: App {
    var body: some Scene {
        WindowGroup(id: "main", for: UUID.self) { $windowID in
            ContentView(windowID: windowID)
        } defaultValue: {
            UUID()
        }
        .commands {
            UatuCodeDesktopCommands()
        }
    }
}
