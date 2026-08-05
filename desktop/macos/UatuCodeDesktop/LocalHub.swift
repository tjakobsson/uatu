//
//  LocalHub.swift
//  UatuCode Desktop
//

import AppKit
import Foundation

/// Supervises the single app-owned `uatu hub --local` process. Every window
/// is a client of a hub — this one for "This Mac", or a configured remote —
/// so the app owns exactly one child process regardless of window count, and
/// sessions belong to the hub, not to windows.
///
/// Lifetime coupling is belt and braces: on confirmed quit the app SIGTERMs
/// the hub (which stops its session children before exiting); if the app
/// dies without running handlers, the hub notices its stdin pipe closing
/// (`--exit-on-stdin-close`) and shuts itself down the same way.
@MainActor
@Observable
final class LocalHubController {
    static let shared = LocalHubController()

    enum Status: Equatable {
        case starting
        case running(URL)
        case failed(String)
    }

    private(set) var status: Status = .starting
    /// The most recent state payload from the hub. The splash's "This Mac"
    /// card and the Open Recent menu render from this; the quit check
    /// refreshes it before deciding.
    private(set) var lastState: HubState?

    private var process: Process?
    private var stdinPipe: Pipe?
    private var outputBuffer = ""
    private var launched = false

    private static let recentsImportedKey = "recentsImportedToLocalHub"
    private static let legacyRecentsKey = "recentFolders"

    var baseURL: URL? {
        if case .running(let url) = status { return url }
        return nil
    }

    func startIfNeeded() {
        guard !launched else { return }
        launched = true
        launch()
    }

    /// Relaunch after a failure (the native "hub stopped" surface's action).
    func relaunch() {
        stopProcessQuietly()
        launch()
    }

    private func launch() {
        status = .starting
        outputBuffer = ""

        // The binary is embedded at build time (the "Bundle uatu" phase fails
        // the build if it's missing), so a missing resource here means a
        // mangled bundle — fail loudly rather than probing PATH.
        guard let uatu = Bundle.main.url(forResource: "uatu", withExtension: nil) else {
            status = .failed("This app bundle is missing its embedded uatu binary.")
            return
        }

        // GUI apps get launchd's minimal environment, but uatu's embedded
        // terminal spawns an interactive NON-login shell that inherits the
        // hub's (via its serve children) — without the user's real PATH,
        // their rc file breaks (starship, mise, …). Resolve the login-shell
        // environment once, off the main actor, then launch.
        Task { [weak self] in
            let environment = await Task.detached { Self.loginEnvironment }.value
            guard let self, case .starting = self.status, self.process == nil else { return }
            self.spawn(uatu: uatu, environment: environment)
        }
    }

    private func spawn(uatu: URL, environment: [String: String]) {
        let process = Process()
        process.environment = environment
        process.executableURL = uatu
        process.arguments = ["hub", "--local", "--port", "0", "--exit-on-stdin-close"]

        // Hold the write end of stdin for the hub's whole life: if this app
        // dies for any reason, the pipe closes and the hub (and its session
        // children) exit themselves.
        let stdin = Pipe()
        process.standardInput = stdin

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor [weak self] in
                self?.consume(text)
            }
        }

        process.terminationHandler = { proc in
            Task { @MainActor [weak self] in
                guard let self, self.process === proc else { return }
                self.process = nil
                self.stdinPipe = nil
                switch self.status {
                case .running:
                    let tail = String(self.outputBuffer.suffix(600))
                    self.status = .failed("The local hub exited unexpectedly.\n\(tail)")
                case .starting:
                    let head = String(self.outputBuffer.prefix(600))
                    self.status = .failed("The local hub failed to start.\n\(head)")
                case .failed:
                    break
                }
            }
        }

        do {
            try process.run()
            self.process = process
            self.stdinPipe = stdin
        } catch {
            status = .failed("Failed to launch uatu: \(error.localizedDescription)")
        }
    }

    private func consume(_ text: String) {
        outputBuffer += text
        guard case .starting = status else { return }
        // With a piped (non-TTY) stdout the hub prints exactly one line —
        // its base URL, e.g. "http://127.0.0.1:49213/".
        if let match = outputBuffer.firstMatch(of: #/http://[^\s]+/#),
           let url = URL(string: String(match.output)) {
            status = .running(url)
            Task { [weak self] in
                await self?.importRecentsIfNeeded()
                await self?.refreshState()
            }
        }
    }

    /// Waits for the hub to come up (or fail), for flows that need its URL.
    func waitForRunning(timeout: TimeInterval = 15) async -> URL? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            switch status {
            case .running(let url): return url
            case .failed: return nil
            case .starting:
                try? await Task.sleep(for: .milliseconds(150))
            }
        }
        return nil
    }

    func refreshState() async {
        guard let base = baseURL else { return }
        if let state = try? await HubAPI(baseURL: base).state() {
            lastState = state
        }
    }

    /// One-time migration of the pre-hub recents list into local-hub
    /// registrations (register only — imported folders must not START
    /// sessions). Missing paths and non-git folders are skipped silently;
    /// the legacy key stays in place so rolling back to an old build still
    /// finds it.
    private func importRecentsIfNeeded() async {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: Self.recentsImportedKey) else { return }
        defaults.set(true, forKey: Self.recentsImportedKey)
        guard let base = baseURL else { return }
        let paths = (defaults.string(forKey: Self.legacyRecentsKey) ?? "")
            .split(separator: "\n")
            .map(String.init)
        var isDirectory: ObjCBool = false
        for path in paths
        where FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && isDirectory.boolValue {
            _ = try? await HubAPI(baseURL: base).addWorkspace(path: path, start: false)
        }
    }

    // MARK: - Quit support

    struct LiveSession: Equatable {
        let id: String
        let shellCount: Int
    }

    /// The running local sessions that have live terminal shells — the only
    /// thing quit can actually destroy (the preview server is stateless).
    /// Tries a fresh fetch bounded by `timeout`, falling back to the cached
    /// state so a wedged hub cannot hang quit.
    func sessionsWithLiveShells(timeout: TimeInterval) async -> [LiveSession] {
        if let base = baseURL {
            let fetch = Task { try? await HubAPI(baseURL: base).state() }
            let bound = Task {
                try? await Task.sleep(for: .seconds(timeout))
                fetch.cancel()
            }
            if let fresh = await fetch.value {
                bound.cancel()
                lastState = fresh
            }
        }
        guard let state = lastState else { return [] }
        return state.workspaces.compactMap { workspace in
            guard workspace.running, let shells = workspace.shells, !shells.isEmpty else { return nil }
            return LiveSession(id: workspace.id, shellCount: shells.count)
        }
    }

    /// SIGTERM the hub and wait (bounded) for it to stop its children and
    /// exit, so a confirmed quit tears down cleanly. The stdin pipe is the
    /// backstop if the wait times out.
    func terminateAndWait(timeout: TimeInterval = 3) async {
        guard let process else { return }
        process.terminationHandler = nil
        (process.standardOutput as? Pipe)?.fileHandleForReading.readabilityHandler = nil
        process.terminate()
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(100))
        }
        self.process = nil
        self.stdinPipe = nil
    }

    private func stopProcessQuietly() {
        if let process {
            process.terminationHandler = nil
            (process.standardOutput as? Pipe)?.fileHandleForReading.readabilityHandler = nil
            process.terminate()
        }
        process = nil
        stdinPipe = nil
    }

    // MARK: - Login-shell environment

    /// The user's environment as their terminal would see it: what a login
    /// shell exports, on top of the GUI environment. Captured once per app
    /// run (thread-safe lazy static); falls back to the plain GUI
    /// environment plus the standard user bin dirs if the shell probe fails.
    nonisolated static let loginEnvironment: [String: String] = {
        var env = ProcessInfo.processInfo.environment
        let shell = env["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
        let probe = Process()
        probe.executableURL = URL(fileURLWithPath: shell)
        probe.arguments = ["-l", "-c", "/usr/bin/env -0"]
        let out = Pipe()
        probe.standardOutput = out
        probe.standardError = FileHandle.nullDevice
        if (try? probe.run()) != nil {
            let data = out.fileHandleForReading.readDataToEndOfFile()
            probe.waitUntilExit()
            if probe.terminationStatus == 0 {
                for entry in data.split(separator: 0) {
                    guard let pair = String(data: Data(entry), encoding: .utf8),
                          let eq = pair.firstIndex(of: "=") else { continue }
                    env[String(pair[..<eq])] = String(pair[pair.index(after: eq)...])
                }
            }
        }
        // Insurance for exotic setups where the probe yields nothing useful.
        let path = env["PATH", default: "/usr/bin:/bin:/usr/sbin:/sbin"]
        var parts = path.split(separator: ":").map(String.init)
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        for fallback in ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin"]
        where !parts.contains(fallback) {
            parts.append(fallback)
        }
        env["PATH"] = parts.joined(separator: ":")
        return env
    }()
}
