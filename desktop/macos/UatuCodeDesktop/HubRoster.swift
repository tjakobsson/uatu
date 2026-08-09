//
//  HubRoster.swift
//  UatuCode Desktop
//

import Foundation

/// A configured hub. Non-secret fields persist in UserDefaults; the
/// password and current session id live in the Keychain, keyed by this
/// entry's id.
struct RemoteHubEntry: Codable, Equatable, Hashable, Identifiable {
    var id: UUID
    var name: String
    var urlString: String
    var username: String

    var url: URL? { URL(string: urlString) }

    var host: String {
        url?.host ?? urlString
    }

    /// Scheme, host, and port. Sign-out signals resolve against this rather
    /// than the host alone: two configured hubs may share a host on different
    /// ports (routine for loopback hubs behind tunnels, and the add flow does
    /// not forbid it), and revoking by host would discard one hub's
    /// credentials for another hub's sign-out.
    var origin: String? {
        url.flatMap(HubURLValidation.origin)
    }

    var passwordAccount: String { "\(id.uuidString).password" }
    var sessionAccount: String { "\(id.uuidString).session" }
    /// Pre-0.5 builds stored the signed cookie under this account; it is
    /// deleted alongside the current secrets so nothing stale lingers.
    var legacyCookieAccount: String { "\(id.uuidString).cookie" }
}

/// Validation for hub URLs: remote hubs must be HTTPS — the hub itself
/// refuses non-loopback plain HTTP, and so does the app. Plain HTTP is
/// accepted only for loopback (a hub on this machine, an SSH tunnel).
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

    /// A URL's origin, with the scheme's default port made explicit so that
    /// "https://hub.example/" and "https://hub.example:443/" compare equal.
    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return nil }
        let port = url.port ?? (scheme == "https" ? 443 : 80)
        return "\(scheme)://\(host):\(port)"
    }
}

/// The roster of configured hubs, shared across windows. Entries persist
/// across restarts; removing one deletes its Keychain secrets.
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
    /// and holds the fresh session id. Secrets go straight to the Keychain.
    func add(name: String, url: URL, username: String, password: String, sessionID: String) -> RemoteHubEntry {
        let entry = RemoteHubEntry(
            id: UUID(),
            name: name.isEmpty ? (url.host ?? url.absoluteString) : name,
            urlString: url.absoluteString,
            username: username
        )
        HubKeychain.set(password, account: entry.passwordAccount)
        HubKeychain.set(sessionID, account: entry.sessionAccount)
        hubs.append(entry)
        persist()
        return entry
    }

    /// The configured hub a URL belongs to, matched by full origin. Sign-out
    /// signals arrive from the web view as bare URLs; only a configured hub
    /// has credentials to discard.
    func entry(for url: URL) -> RemoteHubEntry? {
        guard let origin = HubURLValidation.origin(of: url) else { return nil }
        return hubs.first { $0.origin == origin }
    }

    func signOut(_ entry: RemoteHubEntry) {
        let connection = connection(for: entry)
        Task { await connection.signOut() }
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
        HubKeychain.delete(account: entry.sessionAccount)
        HubKeychain.delete(account: entry.legacyCookieAccount)
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
/// The hub revokes sessions server-side, which is what keeps this simple: a
/// 401 always means the session is dead at the source of truth, a silent
/// re-login either mints a fresh session or fails to the sign-in prompt,
/// and a stale id lingering anywhere is worthless. The silent attempt
/// happens at most once per signed-out transition — the hub rate-limits
/// login failures (5/minute), so the app never retries on its own.
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
    /// Counts deliberate sign-outs of this hub (observed in a web view, or a
    /// rejected re-login). Windows showing this hub watch it and return to
    /// the splash — an app-wide signal, distinct from `.signedOut`, which a
    /// probe can also publish while a silent re-login is about to recover.
    private(set) var signOutEpoch = 0
    private var triedSilentRelogin = false

    nonisolated var id: UUID { entry.id }

    init(entry: RemoteHubEntry) {
        self.entry = entry
    }

    var sessionID: String? {
        HubKeychain.get(account: entry.sessionAccount)
    }

    func probe() async {
        guard let url = entry.url else {
            state = .unreachable("invalid hub URL")
            return
        }
        var api = HubAPI(baseURL: url, sessionID: sessionID)
        do {
            let hubState = try await api.state()
            state = .connected(hubState)
            triedSilentRelogin = false
        } catch HubAPIError.unauthorized {
            // The session is dead server-side (expired, or revoked from
            // another device's dashboard). One silent re-login with the
            // stored password recovers without bothering the user; a
            // rejected one means the password changed — prompt.
            if !triedSilentRelogin, let password = HubKeychain.get(account: entry.passwordAccount) {
                triedSilentRelogin = true
                if let fresh = try? await HubAPI.login(baseURL: url, name: entry.username, password: password) {
                    HubKeychain.set(fresh, account: entry.sessionAccount)
                    api.sessionID = fresh
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

    /// Writes the current session id into the web view's cookie store ahead
    /// of a navigation to this hub, so the page shares the native session.
    func injectSessionCookie() async {
        guard let url = entry.url, let sessionID else { return }
        await HubCookies.inject(value: sessionID, for: url)
    }

    /// Discards this hub's credentials after a sign-out observed in a web
    /// view. The hub has already revoked the session server-side (the web
    /// view's logout POST is what revokes); this forgets the app's copies.
    ///
    /// Both Keychain items go. Deleting the session id alone would be
    /// cosmetic: `probe()` would mint a fresh session from the stored
    /// password on the very next poll, so the app would stay signed in to a
    /// hub the user just signed out of. Deleting the password is the latch,
    /// and `signIn(password:)` is the only way back.
    func signOut() async {
        HubKeychain.delete(account: entry.passwordAccount)
        HubKeychain.delete(account: entry.sessionAccount)
        HubKeychain.delete(account: entry.legacyCookieAccount)
        triedSilentRelogin = false
        state = .signedOut
        signOutEpoch &+= 1
        if let url = entry.url {
            await HubCookies.clear(for: url)
        }
    }

    /// Interactive sign-in from the splash's sheet. Stores both secrets and
    /// re-probes on success; throws for the sheet to display.
    func signIn(password: String) async throws {
        guard let url = entry.url else { throw HubAPIError.unreachable("invalid hub URL") }
        let sessionID = try await HubAPI.login(baseURL: url, name: entry.username, password: password)
        HubKeychain.set(password, account: entry.passwordAccount)
        HubKeychain.set(sessionID, account: entry.sessionAccount)
        triedSilentRelogin = false
        await probe()
    }
}
