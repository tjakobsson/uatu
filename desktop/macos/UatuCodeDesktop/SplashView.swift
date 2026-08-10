//
//  SplashView.swift
//  UatuCode Desktop
//

import SwiftUI

/// A page a window can show — every window is a client of some hub, and a
/// page is that hub's dashboard (workspaces and sessions are reached from
/// there, never natively).
enum HubPage: Equatable {
    case dashboard(RemoteHubEntry)
}

/// The hub splash: the window's no-page state, for choosing and configuring
/// hubs only. One card per configured hub with live reachability/auth
/// state. Cards deliberately do NOT list workspaces: each hub's own
/// dashboard is the single workspace surface, so dashboard improvements
/// reach the desktop without a native duplicate drifting alongside. Hub
/// state polls only while a splash is visible. With no hubs configured the
/// splash explains the model: uatu runs as a hub this app connects to.
struct SplashView: View {
    var openPage: (HubPage) -> Void

    @State private var showAddHub = false
    @State private var signInTarget: HubConnection?

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
                    Text("Connect to a hub to open its workspaces.")
                        .foregroundStyle(.secondary)
                }

                VStack(spacing: 14) {
                    if roster.hubs.isEmpty {
                        firstRunExplainer
                    }
                    ForEach(roster.hubs) { entry in
                        RemoteHubCard(
                            entry: entry,
                            connection: roster.connection(for: entry),
                            openPage: openPage,
                            signIn: { signInTarget = roster.connection(for: entry) }
                        )
                    }
                    if roster.hubs.isEmpty {
                        Button("Add Hub…") { showAddHub = true }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.large)
                    } else {
                        Button("Add Hub…") { showAddHub = true }
                    }
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

    /// First-run copy: the app connects to a running `uatu hub` — on this
    /// Mac or a machine elsewhere — and does not run one itself.
    private var firstRunExplainer: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("uatu runs as a hub this app connects to", systemImage: "server.rack")
                .font(.headline)
            Text(
                """
                Start one in a terminal with `uatu hub` — on this Mac \
                (add it as http://localhost:4700) or on a machine you own — \
                then add it here and sign in. Workspaces and sessions live \
                on the hub and keep running when this app quits.
                """
            )
            .font(.callout)
            .foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 10))
    }

    private func refreshAll() async {
        await withTaskGroup(of: Void.self) { group in
            for entry in roster.hubs {
                let connection = roster.connection(for: entry)
                group.addTask { @MainActor in
                    await connection.probe()
                }
            }
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

// MARK: - Hub card

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
                openPage(.dashboard(entry))
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
                    let sessionID = try await HubAPI.login(baseURL: url, name: username, password: password)
                    let entry = HubRoster.shared.add(
                        name: name, url: url, username: username, password: password, sessionID: sessionID
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
