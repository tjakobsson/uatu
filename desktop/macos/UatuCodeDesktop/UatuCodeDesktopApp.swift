//
//  UatuCodeDesktopApp.swift
//  UatuCode Desktop
//

import SwiftUI

@main
struct UatuCodeDesktopApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .commands {
            UatuCodeDesktopCommands()
        }
    }
}
