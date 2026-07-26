//
//  GitPreflight.swift
//  UatuCode Desktop
//

import Foundation

/// The git preflight for folder opens: uatu's serve CLI refuses roots that
/// are outside a git worktree, so the wrapper probes first and can offer
/// `git init` instead of spawning a child that is certain to fail.
///
/// Detection mirrors the CLI's own probe (`git rev-parse --show-toplevel`)
/// so app and CLI cannot disagree about what counts as a repository. git is
/// resolved from the caller-supplied environment's PATH via `/usr/bin/env`
/// — the same login-shell environment the server child gets.
enum GitPreflight {
    struct InitError: Error {
        let message: String
    }

    /// Whether `folder` is inside a git worktree; `nil` when git itself
    /// could not be run, in which case the caller should skip the
    /// preflight and let the server's own startup report as it does today.
    nonisolated static func isInsideWorktree(
        _ folder: URL, environment: [String: String]
    ) -> Bool? {
        guard let (status, _) = runGit(
            ["-C", folder.path, "rev-parse", "--show-toplevel"],
            in: folder, environment: environment
        ), status != Self.commandNotFound else { return nil }
        return status == 0
    }

    nonisolated static func initializeRepository(
        at folder: URL, environment: [String: String]
    ) -> Result<Void, InitError> {
        guard let (status, output) = runGit(
            ["init"], in: folder, environment: environment
        ) else {
            return .failure(InitError(message: "git could not be launched."))
        }
        if status == Self.commandNotFound {
            return .failure(InitError(message: "git was not found on your PATH."))
        }
        guard status == 0 else {
            return .failure(InitError(message: output.isEmpty
                ? "git init exited with status \(status)."
                : output))
        }
        return .success(())
    }

    /// `/usr/bin/env`'s exit status when the named command is not on PATH.
    private static let commandNotFound: Int32 = 127

    private nonisolated static func runGit(
        _ arguments: [String], in folder: URL, environment: [String: String]
    ) -> (status: Int32, output: String)? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["git"] + arguments
        process.environment = environment
        process.currentDirectoryURL = folder
        let out = Pipe()
        process.standardOutput = out
        process.standardError = out
        guard (try? process.run()) != nil else { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let output = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return (process.terminationStatus, output)
    }
}
