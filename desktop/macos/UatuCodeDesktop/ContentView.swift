//
//  ContentView.swift
//  UatuCode Desktop
//

import SwiftUI
import UniformTypeIdentifiers
import WebKit

struct ContentView: View {
    @State private var server = UatuServer()
    @State private var page = WebPage()
    @State private var isPickingFolder = false
    /// The folder served by THIS window. Each window has its own.
    @State private var folder: URL?
    /// Recently served folders, newest first, one path per line. Shared
    /// across windows and shown on the launcher screen.
    @AppStorage("recentFolders") private var recentFoldersStorage = ""

    var body: some View {
        Group {
            switch server.status {
            case .idle:
                launcher
            case .starting:
                ProgressView("Starting uatu…")
            case .running:
                WebView(page)
            case .failed(let message):
                ContentUnavailableView {
                    Label("uatu Failed", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                        .font(.callout.monospaced())
                        .multilineTextAlignment(.leading)
                } actions: {
                    Button("Try Again") { restart() }
                        .buttonStyle(.borderedProminent)
                    Button("Choose Folder…") { isPickingFolder = true }
                }
            }
        }
        .frame(minWidth: 700, minHeight: 500)
        .navigationTitle(folderName ?? "UatuCode Desktop")
        .focusedSceneValue(\.windowCommands, WindowCommands(
            isRunning: isRunning,
            folderPath: folder?.path,
            chooseFolder: { isPickingFolder = true },
            openFolder: { open($0) },
            reload: { page.reload() },
            openInBrowser: {
                if case .running(let url) = server.status {
                    NSWorkspace.shared.open(url)
                }
            }
        ))
        .fileImporter(isPresented: $isPickingFolder, allowedContentTypes: [.folder]) { result in
            if case .success(let url) = result {
                open(url)
            }
        }
        .onChange(of: server.status) { _, newStatus in
            if case .running(let url) = newStatus {
                page.load(URLRequest(url: url))
            }
        }
    }

    private var launcher: some View {
        VStack(spacing: 28) {
            VStack(spacing: 8) {
                Image("Logo")
                    .resizable()
                    .scaledToFit()
                    .frame(height: 84)
                Text("UatuCode Desktop")
                    .font(.largeTitle.bold())
                Text("Serve a folder with uatu and view it here.")
                    .foregroundStyle(.secondary)
            }

            Button("Choose Folder…") { isPickingFolder = true }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

            if !recentFolders.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Recent")
                        .font(.headline)
                        .padding(.bottom, 6)
                    ForEach(recentFolders, id: \.path) { url in
                        Button {
                            open(url)
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "folder")
                                    .foregroundStyle(.tint)
                                VStack(alignment: .leading) {
                                    Text(url.lastPathComponent)
                                    Text(url.path)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                                Spacer()
                            }
                            .padding(.vertical, 5)
                            .padding(.horizontal, 8)
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .frame(maxWidth: 420)
            }
        }
        .padding(40)
    }

    private var recentFolders: [URL] {
        recentFoldersStorage
            .split(separator: "\n")
            .map { URL(fileURLWithPath: String($0)) }
    }

    private func open(_ url: URL) {
        folder = url
        var paths = recentFoldersStorage.split(separator: "\n").map(String.init)
        paths.removeAll { $0 == url.path }
        paths.insert(url.path, at: 0)
        recentFoldersStorage = paths.prefix(8).joined(separator: "\n")
        server.start(folder: url)
    }

    private var isRunning: Bool {
        if case .running = server.status { return true }
        return false
    }

    private var folderName: String? {
        folder?.lastPathComponent
    }

    private func restart() {
        guard let folder else {
            isPickingFolder = true
            return
        }
        server.start(folder: folder)
    }
}

/// Actions of the focused window, exposed to the menu bar commands.
struct WindowCommands: Equatable {
    var isRunning: Bool
    var folderPath: String?
    var chooseFolder: () -> Void
    var openFolder: (URL) -> Void
    var reload: () -> Void
    var openInBrowser: () -> Void

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.isRunning == rhs.isRunning && lhs.folderPath == rhs.folderPath
    }
}

extension FocusedValues {
    @Entry var windowCommands: WindowCommands?
}

struct UatuCodeDesktopCommands: Commands {
    @FocusedValue(\.windowCommands) private var window
    @AppStorage("recentFolders") private var recentFoldersStorage = ""

    private var recentFolders: [URL] {
        recentFoldersStorage
            .split(separator: "\n")
            .map { URL(fileURLWithPath: String($0)) }
    }

    var body: some Commands {
        CommandGroup(after: .newItem) {
            Button("Choose Folder…") { window?.chooseFolder() }
                .keyboardShortcut("o")
                .disabled(window == nil)
            Menu("Open Recent") {
                ForEach(recentFolders, id: \.path) { url in
                    Button(url.lastPathComponent) { window?.openFolder(url) }
                }
                if !recentFolders.isEmpty {
                    Divider()
                    Button("Clear Menu") { recentFoldersStorage = "" }
                }
            }
            .disabled(window == nil || recentFolders.isEmpty)
        }
        CommandGroup(after: .toolbar) {
            Button("Reload Page") { window?.reload() }
                .keyboardShortcut("r")
                .disabled(window?.isRunning != true)
            Button("Open in Browser") { window?.openInBrowser() }
                .keyboardShortcut("o", modifiers: [.command, .shift])
                .disabled(window?.isRunning != true)
            Divider()
        }
    }
}

#Preview {
    ContentView()
}
