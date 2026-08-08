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

    /// Scheme, host, and port. Sign-out signals resolve against this rather
    /// than the host alone: two configured hubs may share a host on different
    /// ports (routine for loopback hubs behind tunnels, and the add flow does
    /// not forbid it), and revoking by host would destroy one hub's
    /// credentials while leaving the hub actually signed out of able to
    /// re-authenticate.
    var origin: String? {
        url.flatMap(HubURLValidation.origin)
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

    /// A URL's origin, with the scheme's default port made explicit so that
    /// "https://hub.example/" and "https://hub.example:443/" compare equal.
    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return nil }
        let port = url.port ?? (scheme == "https" ? 443 : 80)
        return "\(scheme)://\(host):\(port)"
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
    private let cookieWatch = HubCookieWatch()

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

    /// The configured hub a URL belongs to, matched by full origin. Sign-out
    /// signals arrive from the web view as bare URLs; only a configured remote
    /// hub has credentials to revoke, and the local hub has no login at all.
    func entry(for url: URL) -> RemoteHubEntry? {
        guard let origin = HubURLValidation.origin(of: url) else { return nil }
        return hubs.first { $0.origin == origin }
    }

    /// The single configured hub on a host — nil when none, and nil when
    /// several.
    ///
    /// Cookies are scoped to a host and carry no port, so two hubs sharing a
    /// host share one `uatu_hub` jar entry, and its disappearance cannot say
    /// which of them signed out. Guessing would revoke the wrong hub's
    /// credentials, which is worse than not revoking: the navigation signal
    /// still carries the port and stays precise for that setup.
    func soleEntry(forHost host: String) -> RemoteHubEntry? {
        let matches = hubs.filter { $0.host.caseInsensitiveCompare(host) == .orderedSame }
        return matches.count == 1 ? matches.first : nil
    }

    /// Revokes a hub's credentials in response to a sign-out observed in a web
    /// view. A URL naming no configured hub is ignored, so a stray navigation
    /// (or anything on the local hub) can never revoke.
    func signOut(for url: URL) {
        guard let entry = entry(for: url) else { return }
        signOut(entry)
    }

    func signOut(_ entry: RemoteHubEntry) {
        let connection = connection(for: entry)
        // Revocation clears the web view's cookie itself, and that change
        // would echo back through the watch as a *second* sign-out for this
        // hub — arriving two async hops later, by which time the user may
        // have signed back in, whose fresh credentials it would then delete.
        // Dropping the host from the baseline first makes the change we are
        // about to cause read as no change. A hub-initiated clear still
        // reports normally, which is the signal the watch exists for.
        cookieWatch.forget(host: entry.host)
        Task { await connection.signOut() }
    }

    /// Starts watching the web-view cookie store for hub cookies being
    /// cleared. Idempotent, and app-wide rather than per-window: the store is
    /// shared, so one watch serves every window.
    func startCookieWatch() {
        cookieWatch.start { [weak self] host in
            guard let self, let entry = self.soleEntry(forHost: host) else { return }
            self.signOut(entry)
        }
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
    /// Counts revocations of this hub's credentials.
    ///
    /// Windows watch THIS to decide whether to leave a hub's page, not
    /// `.signedOut`. The two are not the same event: concurrent probes of an
    /// expired cookie can publish `.signedOut` transiently — one probe holds
    /// the single-attempt flag while it re-logs-in, so a second concurrent one
    /// skips the attempt and reports signed out — and a silent re-login that
    /// then succeeds leaves everything working. Ejecting every window on that
    /// would throw the user off a page that was never in trouble.
    private(set) var revocations = 0
    private var triedSilentRelogin = false
    /// Bumped whenever the stored credentials change — sign-out and sign-in
    /// alike. Work that started in an earlier generation may not publish state
    /// or write credentials; see `probe()`. One counter for both directions
    /// keeps the rule uniform: a result computed under credentials that no
    /// longer apply is discarded, whichever way they changed.
    private var credentialGeneration = 0

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
        // A sign-out landing mid-probe has to win. The MainActor is reentrant
        // across awaits, so `signOut()` can run between any two lines below,
        // and the hub does not revoke server-side — a request that captured
        // the pre-revocation cookie still answers 200. Every publish and every
        // Keychain write past an await is therefore gated on the revocation
        // generation this probe started in.
        let generation = credentialGeneration
        var api = HubAPI(baseURL: url, cookie: cookie)
        do {
            let hubState = try await api.state()
            guard isCurrent(generation) else { return }
            state = .connected(hubState)
            triedSilentRelogin = false
        } catch HubAPIError.unauthorized {
            guard isCurrent(generation) else { return }
            // Note for `signOut()`: this password read is also the sign-out
            // latch. Revocation deletes the password, so a signed-out hub
            // takes the `else` path here forever — durably, across restarts,
            // with no separate flag that could drift out of sync with it.
            if !triedSilentRelogin, let password = HubKeychain.get(account: entry.passwordAccount) {
                triedSilentRelogin = true
                if let fresh = try? await HubAPI.login(baseURL: url, name: entry.username, password: password) {
                    // The load-bearing guard of the set: a silent re-login
                    // that was already in flight when the user signed out
                    // would otherwise write a working cookie back into the
                    // Keychain that revocation had just deleted — leaving the
                    // app able to reach a hub the user signed out of, on a
                    // token the hub will honor for weeks.
                    guard isCurrent(generation) else { return }
                    HubKeychain.set(fresh, account: entry.cookieAccount)
                    api.cookie = fresh
                    if let hubState = try? await api.state() {
                        guard isCurrent(generation) else { return }
                        state = .connected(hubState)
                        triedSilentRelogin = false
                        return
                    }
                }
            }
            guard isCurrent(generation) else { return }
            state = .signedOut
        } catch HubAPIError.unreachable(let detail) {
            guard isCurrent(generation) else { return }
            state = .unreachable(detail)
        } catch HubAPIError.http(let status, let message) {
            guard isCurrent(generation) else { return }
            state = .unreachable("HTTP \(status)\(message.isEmpty ? "" : ": \(message)")")
        } catch {
            guard isCurrent(generation) else { return }
            state = .unreachable(error.localizedDescription)
        }
    }

    /// False once the stored credentials changed since `generation` was
    /// captured.
    private func isCurrent(_ generation: Int) -> Bool {
        generation == credentialGeneration
    }

    /// Writes the current cookie into the web view's store ahead of a
    /// navigation to this hub.
    ///
    /// The write cannot be cancelled once started, so it is checked afterward
    /// instead: a sign-out landing while it was suspended would be followed by
    /// this write, leaving a working bearer token in WebKit's *persistent* jar
    /// for a hub the user just signed out of — and the hub does not revoke
    /// server-side, so that token stays usable for its full lifetime. When
    /// overtaken, the write is undone.
    ///
    /// The cookie is only cleared if this hub is still without credentials.
    /// A sign-out followed by a quick sign-in also changes the generation, and
    /// there the store legitimately holds the new session's cookie — which
    /// this cleanup must not delete.
    func injectCookie() async {
        guard let url = entry.url, let cookie else { return }
        let generation = credentialGeneration
        await HubCookies.inject(value: cookie, for: url)
        guard !isCurrent(generation), self.cookie == nil else { return }
        await HubCookies.clear(for: url, stillWanted: { self.cookie == nil })
    }

    /// Revokes this hub's credentials after a sign-out observed in a web view.
    ///
    /// Both Keychain items go. Clearing the cookie alone would be cosmetic:
    /// `probe()` would mint a fresh one from the stored password on the very
    /// next poll, so the app would stay signed in to a hub the user just
    /// signed out of. Deleting the password is therefore not belt-and-braces
    /// but the latch itself, and `signIn(password:)` is the only way back.
    ///
    /// Idempotent — deleting absent Keychain items, clearing an absent cookie,
    /// and re-entering `.signedOut` are all no-ops — because several detection
    /// signals can report the same sign-out.
    func signOut() async {
        // Order matters. The Keychain deletes and the state publish are
        // synchronous, so no window can observe a half-revoked hub and none
        // waits on the cookie store to leave the page: windows return to the
        // splash off this state transition, and WebKit's cookie operations
        // suspend for as long as they like.
        credentialGeneration &+= 1
        HubKeychain.delete(account: entry.passwordAccount)
        HubKeychain.delete(account: entry.cookieAccount)
        triedSilentRelogin = false
        state = .signedOut
        revocations &+= 1
        if let url = entry.url {
            // Abandon the clear if a sign-in overtakes it: the new session's
            // cookie shares this one's name, domain and path, so deleting the
            // snapshot's entry would delete the replacement.
            let generation = credentialGeneration
            await HubCookies.clear(for: url, stillWanted: { self.isCurrent(generation) })
        }
    }

    /// Interactive sign-in from the splash's sheet. Stores both secrets and
    /// re-probes on success; throws for the sheet to display.
    func signIn(password: String) async throws {
        guard let url = entry.url else { throw HubAPIError.unreachable("invalid hub URL") }
        let cookie = try await HubAPI.login(baseURL: url, name: entry.username, password: password)
        HubKeychain.set(password, account: entry.passwordAccount)
        HubKeychain.set(cookie, account: entry.cookieAccount)
        // Same bump as sign-out, for the mirror-image race: a probe that
        // started while this hub was signed out would otherwise resume and
        // publish `.signedOut` over the session just established.
        credentialGeneration &+= 1
        triedSilentRelogin = false
        await probe()
    }
}
