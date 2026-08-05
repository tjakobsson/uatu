//
//  HubRoster.swift
//  UatuCode Desktop
//

import Foundation

/// A configured remote hub. Non-secret fields persist in UserDefaults;
/// the password and current session cookie live in the Keychain, keyed by
/// this entry's id.
struct RemoteHubEntry: Codable, Equatable, Hashable, Identifiable {
    var id: UUID
    var name: String
    var urlString: String
    var username: String

    var url: URL? { URL(string: urlString) }

    var host: String {
        url?.host ?? urlString
    }

    var passwordAccount: String { "\(id.uuidString).password" }
    var cookieAccount: String { "\(id.uuidString).cookie" }
}

/// Validation for hub URLs: remote hubs must be HTTPS — the hub itself
/// refuses non-loopback plain HTTP, and so does the app. Plain HTTP is
/// accepted only for loopback (a hub behind an SSH tunnel, local testing).
enum HubURLValidation {
    static let loopbackHosts: Set<String> = ["127.0.0.1", "::1", "localhost"]

    enum Failure: Error, Equatable {
        case notAURL
        case insecureRemote
    }

    static func validate(_ input: String) -> Result<URL, Failure> {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.contains("://") {
            text = "https://\(text)"
        }
        if !text.hasSuffix("/") {
            text += "/"
        }
        guard let url = URL(string: text), let host = url.host,
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return .failure(.notAURL)
        }
        if scheme == "http" && !loopbackHosts.contains(host.lowercased()) {
            return .failure(.insecureRemote)
        }
        return .success(url)
    }
}

/// The roster of configured remote hubs, shared across windows. Entries
/// persist across restarts; removing one deletes its Keychain secrets.
@MainActor
@Observable
final class HubRoster {
    static let shared = HubRoster()

    private static let defaultsKey = "remoteHubs"

    private(set) var hubs: [RemoteHubEntry] = []
    private var connections: [UUID: HubConnection] = [:]

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.defaultsKey),
           let stored = try? JSONDecoder().decode([RemoteHubEntry].self, from: data) {
            hubs = stored
        }
    }

    func connection(for entry: RemoteHubEntry) -> HubConnection {
        if let existing = connections[entry.id] {
            return existing
        }
        let connection = HubConnection(entry: entry)
        connections[entry.id] = connection
        return connection
    }

    /// Adds a verified hub: the caller has already logged in successfully
    /// and holds the fresh cookie. Secrets go straight to the Keychain.
    func add(name: String, url: URL, username: String, password: String, cookie: String) -> RemoteHubEntry {
        let entry = RemoteHubEntry(
            id: UUID(),
            name: name.isEmpty ? (url.host ?? url.absoluteString) : name,
            urlString: url.absoluteString,
            username: username
        )
        HubKeychain.set(password, account: entry.passwordAccount)
        HubKeychain.set(cookie, account: entry.cookieAccount)
        hubs.append(entry)
        persist()
        return entry
    }

    func rename(_ entry: RemoteHubEntry, to name: String) {
        guard let index = hubs.firstIndex(where: { $0.id == entry.id }), !name.isEmpty else { return }
        hubs[index].name = name
        persist()
    }

    func remove(_ entry: RemoteHubEntry) {
        hubs.removeAll { $0.id == entry.id }
        connections.removeValue(forKey: entry.id)
        HubKeychain.delete(account: entry.passwordAccount)
        HubKeychain.delete(account: entry.cookieAccount)
        persist()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(hubs) {
            UserDefaults.standard.set(data, forKey: Self.defaultsKey)
        }
    }
}

/// Per-hub reachability/auth state machine:
///
///     unreachable ⟵ network error ── probe ── 200 ⟶ connected(state)
///                                      │
///                                     401 ⟶ one silent re-login with the
///                                           Keychain password, then
///                                           signedOut until the user acts
///
/// The silent attempt happens at most once per signed-out transition —
/// the hub rate-limits login failures (5/minute), so the app never retries
/// on its own.
@MainActor
@Observable
final class HubConnection: Identifiable {
    enum State: Equatable {
        case unknown
        case connected(HubState)
        case signedOut
        case unreachable(String)
    }

    let entry: RemoteHubEntry
    private(set) var state: State = .unknown
    private var triedSilentRelogin = false

    nonisolated var id: UUID { entry.id }

    init(entry: RemoteHubEntry) {
        self.entry = entry
    }

    var cookie: String? {
        HubKeychain.get(account: entry.cookieAccount)
    }

    func probe() async {
        guard let url = entry.url else {
            state = .unreachable("invalid hub URL")
            return
        }
        var api = HubAPI(baseURL: url, cookie: cookie)
        do {
            state = .connected(try await api.state())
            triedSilentRelogin = false
        } catch HubAPIError.unauthorized {
            if !triedSilentRelogin, let password = HubKeychain.get(account: entry.passwordAccount) {
                triedSilentRelogin = true
                if let fresh = try? await HubAPI.login(baseURL: url, name: entry.username, password: password) {
                    HubKeychain.set(fresh, account: entry.cookieAccount)
                    api.cookie = fresh
                    if let hubState = try? await api.state() {
                        state = .connected(hubState)
                        triedSilentRelogin = false
                        return
                    }
                }
            }
            state = .signedOut
        } catch HubAPIError.unreachable(let detail) {
            state = .unreachable(detail)
        } catch HubAPIError.http(let status, let message) {
            state = .unreachable("HTTP \(status)\(message.isEmpty ? "" : ": \(message)")")
        } catch {
            state = .unreachable(error.localizedDescription)
        }
    }

    /// Interactive sign-in from the splash's sheet. Stores both secrets and
    /// re-probes on success; throws for the sheet to display.
    func signIn(password: String) async throws {
        guard let url = entry.url else { throw HubAPIError.unreachable("invalid hub URL") }
        let cookie = try await HubAPI.login(baseURL: url, name: entry.username, password: password)
        HubKeychain.set(password, account: entry.passwordAccount)
        HubKeychain.set(cookie, account: entry.cookieAccount)
        triedSilentRelogin = false
        await probe()
    }
}
