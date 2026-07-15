//
//  UatuServer.swift
//  UatuCode Desktop
//

import AppKit
import Foundation

/// Launches and supervises a `uatu serve` child process and exposes the
/// local URL it prints (including its auth token) once the server is up.
///
/// Lifetime coupling is belt and braces: on clean quit the app SIGTERMs its
/// children; if the app dies without running handlers, the child notices its
/// stdin pipe closing (`--exit-on-stdin-close`) and shuts itself down.
@MainActor
@Observable
final class UatuServer {
    enum Status: Equatable {
        case idle
        case starting
        case running(URL)
        case failed(String)
    }

    private(set) var status: Status = .idle
    private(set) var folderURL: URL?

    private var process: Process?
    private var stdinPipe: Pipe?
    private var outputBuffer = ""

    init() {
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { _ in
            // uatu handles SIGTERM and shuts down cleanly, so don't leave
            // an orphaned server behind when the app quits.
            MainActor.assumeIsolated {
                UatuServer.terminateAll()
            }
        }
        Self.instances.append(WeakRef(server: self))
        Self.instances.removeAll { $0.server == nil }
    }

    // Weak registry: windows come and go, and a closed window's UatuServer
    // must be collectable — a strong array would retain every server (and its
    // Process/Pipe handles) for the app's lifetime.
    private struct WeakRef { weak var server: UatuServer? }
    private static var instances: [WeakRef] = []

    private static func terminateAll() {
        for ref in instances {
            ref.server?.process?.terminate()
        }
    }

    func start(folder: URL) {
        stop()
        folderURL = folder
        outputBuffer = ""
        status = .starting

        // The binary is embedded at build time (the "Bundle uatu" phase fails
        // the build if it's missing), so a missing resource here means a
        // mangled bundle — fail loudly rather than probing PATH.
        guard let uatu = Bundle.main.url(forResource: "uatu", withExtension: nil) else {
            status = .failed("This app bundle is missing its embedded uatu binary.")
            return
        }

        // GUI apps get launchd's minimal environment, but uatu's embedded
        // terminal spawns an interactive NON-login shell that inherits ours —
        // without the user's real PATH, their rc file breaks (starship, mise,
        // …). Resolve the login-shell environment once, off the main actor,
        // then launch.
        Task { [weak self] in
            let environment = await Task.detached { Self.loginEnvironment }.value
            guard let self, self.folderURL == folder, case .starting = self.status else { return }
            self.launch(uatu: uatu, folder: folder, environment: environment)
        }
    }

    // The user's environment as their terminal would see it: what a login
    // shell exports, on top of the GUI environment. Captured once per app run
    // (thread-safe lazy static); falls back to the plain GUI environment plus
    // the standard user bin dirs if the shell probe fails.
    private nonisolated static let loginEnvironment: [String: String] = {
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

    private func launch(uatu: URL, folder: URL, environment: [String: String]) {
        let process = Process()
        process.environment = environment
        process.executableURL = uatu
        process.arguments = ["serve", folder.path, "--no-open", "--exit-on-stdin-close"]
        process.currentDirectoryURL = folder

        // Hold the write end of stdin for the child's whole life: if this app
        // dies for any reason, the pipe closes and the server exits itself.
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
                    // Crash after startup: the freshest output explains it.
                    let tail = String(self.outputBuffer.suffix(600))
                    self.status = .failed("uatu exited unexpectedly.\n\(tail)")
                case .starting:
                    // Startup refusal: the FIRST lines carry the actual error
                    // (bad flag, bad path, non-git folder); usage text follows.
                    let head = String(self.outputBuffer.prefix(600))
                    self.status = .failed("uatu failed to start.\n\(head)")
                case .idle, .failed:
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

    func stop() {
        if let process {
            process.terminationHandler = nil
            process.standardOutput.flatMap { ($0 as? Pipe)?.fileHandleForReading.readabilityHandler = nil }
            process.terminate()
        }
        process = nil
        stdinPipe = nil
        status = .idle
    }

    private func consume(_ text: String) {
        outputBuffer += text
        guard case .starting = status else { return }
        // With a piped (non-TTY) stdout uatu prints exactly one line — the
        // tokened URL, e.g. "http://127.0.0.1:4711/?t=<token>".
        if let match = outputBuffer.firstMatch(of: #/http://[^\s]+/#),
           let url = URL(string: String(match.output)) {
            status = .running(url)
        }
    }
}
