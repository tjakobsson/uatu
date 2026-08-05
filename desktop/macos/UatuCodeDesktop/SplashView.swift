//
//  SplashView.swift
//  UatuCode Desktop
//

import SwiftUI

/// A page a window can show — every window is a client of some hub.
/// Workspace pages exist only for the local hub (Choose Folder and the
/// Open Recent menu); remote workspaces are reached through their hub's
/// dashboard, never natively.
enum HubPage: Equatable {
    case localDashboard
    case localWorkspace(id: String)
    case remoteDashboard(RemoteHubEntry)
}

/// The hub splash: the window's no-page state, for choosing and configuring
/// hubs only. One card per hub — "This Mac" first (captioned with its
/// app-bound lifetime), then each configured remote hub with live
/// reachability/auth state. Cards deliberately do NOT list workspaces: each
/// hub's own dashboard is the single workspace surface, so dashboard
/// improvements reach the desktop without a native duplicate drifting
/// alongside. Hub state polls only while a splash is visible.
struct SplashView: View {
    var openPage: (HubPage) -> Void
    var chooseFolder: () -> Void

    @State private var showAddHub = false
    @State private var signInTarget: HubConnection?

    private var localHub: LocalHubController { .shared }
    private var roster: HubRoster { .shared }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                VStack(spacing: 8) {
                    Image("Logo")
                        .resizable()
                        .scaledToFit()
                        .frame(height: 84)
                    Text("UatuCode Desktop")
                        .font(.largeTitle.bold())
                    Text("Open a workspace on this Mac or on a hub.")
                        .foregroundStyle(.secondary)
                }

                Button("Choose Folder…") { chooseFolder() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)

                VStack(spacing: 14) {
                    localCard
                    ForEach(roster.hubs) { entry in
                        RemoteHubCard(
                            entry: entry,
                            connection: roster.connection(for: entry),
                            openPage: openPage,
                            signIn: { signInTarget = roster.connection(for: entry) }
                        )
                    }
                    Button("Add Hub…") { showAddHub = true }
                }
                .frame(maxWidth: 460)
            }
            .padding(40)
            .frame(maxWidth: .infinity)
        }
        .task {
            // Poll while (and only while) this splash is on screen; .task
            // cancels on disappear. Same cadence as the hub's own dashboard.
            while !Task.isCancelled {
                await refreshAll()
                try? await Task.sleep(for: .seconds(5))
            }
        }
        .sheet(isPresented: $showAddHub) {
            AddHubSheet()
        }
        .sheet(item: $signInTarget) { connection in
            SignInSheet(connection: connection)
        }
    }

    private func refreshAll() async {
        await localHub.refreshState()
        await withTaskGroup(of: Void.self) { group in
            for entry in roster.hubs {
                let connection = roster.connection(for: entry)
                group.addTask { @MainActor in
                    await connection.probe()
                }
            }
        }
    }

    // MARK: - This Mac

    @ViewBuilder
    private var localCard: some View {
        HubCardShell {
            Button {
                openPage(.localDashboard)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "desktopcomputer")
                        .foregroundStyle(.tint)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("This Mac").font(.headline)
                        // The lifetime asymmetry, stated where the mental
                        // model forms: local sessions live only while the
                        // app runs; remote ones don't care.
                        Text("Runs while UatuCode is open")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    localStatusDetail
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(localHub.baseURL == nil)
        } rows: {
            switch localHub.status {
            case .failed(let message):
                VStack(alignment: .leading, spacing: 8) {
                    Text(message)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(6)
                    Button("Relaunch Hub") { localHub.relaunch() }
                }
                .padding(.top, 6)
            case .starting:
                ProgressView().controlSize(.small).padding(.top, 6)
            case .running:
                EmptyView()
            }
        }
    }

    @ViewBuilder
    private var localStatusDetail: some View {
        if case .running = localHub.status, let state = localHub.lastState {
            HubCardSummary(state: state)
        }
    }
}

// MARK: - Shared card chrome

private struct HubCardShell<Header: View, Rows: View>: View {
    @ViewBuilder var header: Header
    @ViewBuilder var rows: Rows

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            rows
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 10))
    }
}

private struct HubCardSummary: View {
    let state: HubState

    var body: some View {
        let running = state.workspaces.filter(\.running).count
        VStack(alignment: .trailing, spacing: 1) {
            Text(running == 1 ? "1 running" : "\(running) running")
                .font(.caption)
                .foregroundStyle(running > 0 ? Color.green : Color.secondary)
            if let version = state.version {
                Text(version)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - Remote hub card

private struct RemoteHubCard: View {
    let entry: RemoteHubEntry
    let connection: HubConnection
    var openPage: (HubPage) -> Void
    var signIn: () -> Void

    @State private var showRename = false
    @State private var renameText = ""

    var body: some View {
        HubCardShell {
            Button {
                openPage(.remoteDashboard(entry))
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "server.rack")
                        .foregroundStyle(.tint)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(entry.name).font(.headline)
                        Text(entry.host)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    headerDetail
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(!isConnected)
        } rows: {
            switch connection.state {
            case .connected:
                EmptyView()
            case .signedOut:
                HStack(spacing: 8) {
                    Image(systemName: "lock")
                        .foregroundStyle(.secondary)
                    Text("Signed out")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Sign In…") { signIn() }
                }
                .padding(.top, 6)
            case .unreachable(let detail):
                Text("Unreachable — \(detail)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.top, 6)
            case .unknown:
                ProgressView().controlSize(.small).padding(.top, 6)
            }
        }
        .contextMenu {
            Button("Rename…") {
                renameText = entry.name
                showRename = true
            }
            Button("Remove Hub", role: .destructive) {
                HubRoster.shared.remove(entry)
            }
        }
        .alert("Rename Hub", isPresented: $showRename) {
            TextField("Name", text: $renameText)
            Button("Save") { HubRoster.shared.rename(entry, to: renameText) }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var isConnected: Bool {
        if case .connected = connection.state { return true }
        return false
    }

    @ViewBuilder
    private var headerDetail: some View {
        if case .connected(let state) = connection.state {
            HubCardSummary(state: state)
        }
    }
}

// MARK: - Add Hub sheet

private struct AddHubSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var urlText = ""
    @State private var username = ""
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Add Hub").font(.title3.bold())
            Form {
                TextField("URL", text: $urlText, prompt: Text("https://hub.example.com"))
                TextField("Name", text: $name, prompt: Text("Optional display name"))
                TextField("User", text: $username)
                SecureField("Password", text: $password)
            }
            .formStyle(.columns)
            if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Add") { submit() }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || urlText.isEmpty || username.isEmpty || password.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 380)
    }

    /// Verifies with a real login before saving anything, and distinguishes
    /// an unreachable host from rejected credentials.
    private func submit() {
        error = nil
        switch HubURLValidation.validate(urlText) {
        case .failure(.notAURL):
            error = "Enter the hub's URL."
        case .failure(.insecureRemote):
            error = "Remote hubs require HTTPS — plain http:// is loopback-only."
        case .success(let url):
            busy = true
            Task {
                defer { busy = false }
                do {
                    let cookie = try await HubAPI.login(baseURL: url, name: username, password: password)
                    let entry = HubRoster.shared.add(
                        name: name, url: url, username: username, password: password, cookie: cookie
                    )
                    await HubRoster.shared.connection(for: entry).probe()
                    dismiss()
                } catch HubAPIError.unauthorized {
                    error = "The hub rejected this user name or password."
                } catch HubAPIError.unreachable(let detail) {
                    error = "Could not reach the hub: \(detail)"
                } catch HubAPIError.http(let status, let message) {
                    error = "The hub answered HTTP \(status)\(message.isEmpty ? "." : ": \(message)")"
                } catch {
                    self.error = error.localizedDescription
                }
            }
        }
    }
}

// MARK: - Sign In sheet

private struct SignInSheet: View {
    let connection: HubConnection
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Sign in to \(connection.entry.name)").font(.title3.bold())
            Text("User: \(connection.entry.username)")
                .font(.caption)
                .foregroundStyle(.secondary)
            SecureField("Password", text: $password)
            if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Sign In") { submit() }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || password.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 340)
    }

    private func submit() {
        error = nil
        busy = true
        Task {
            defer { busy = false }
            do {
                try await connection.signIn(password: password)
                dismiss()
            } catch HubAPIError.unauthorized {
                error = "The hub rejected this password."
            } catch HubAPIError.unreachable(let detail) {
                error = "Could not reach the hub: \(detail)"
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
