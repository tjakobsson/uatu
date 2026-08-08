//
//  HubAPI.swift
//  UatuCode Desktop
//

import Foundation
import Security
import WebKit

// MARK: - Wire types

struct HubShellInfo: Codable, Equatable {
    let attached: Bool
    let label: String
}

struct HubWorkspace: Codable, Equatable, Identifiable {
    let id: String
    let path: String
    let running: Bool
    let shells: [HubShellInfo]?
}

struct HubState: Codable, Equatable {
    let version: String?
    let workspaces: [HubWorkspace]
}

enum HubAPIError: Error, Equatable {
    /// 401 — the cookie is missing, expired, or revoked.
    case unauthorized
    /// 409 {needsInit} — the folder is not a git repository; confirm and
    /// re-submit with `initRepo`.
    case needsInit
    /// Any other non-success status, with the server's error text.
    case http(Int, String)
    /// The host could not be reached (DNS, TLS, connection, timeout).
    case unreachable(String)
}

// MARK: - Client

/// Minimal native client for the hub's JSON API. Cookie handling is fully
/// manual: the session stores nothing, sends no Origin header (so the hub's
/// CSRF check passes by design for native clients), and the caller supplies
/// the `uatu_hub` cookie value — the native layer is the single owner of
/// hub credentials. TLS uses system trust only; there is no exception path.
struct HubAPI {
    let baseURL: URL
    var cookie: String?

    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 10
        return URLSession(configuration: config)
    }()

    /// Blocks redirect-following so login's 303 response (which carries the
    /// Set-Cookie) is observable instead of being consumed by URLSession.
    private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
        func urlSession(
            _ session: URLSession, task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void
        ) {
            completionHandler(nil)
        }
    }

    private func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await Self.session.data(for: request, delegate: NoRedirectDelegate())
            guard let http = response as? HTTPURLResponse else {
                throw HubAPIError.unreachable("no HTTP response")
            }
            return (data, http)
        } catch let error as HubAPIError {
            throw error
        } catch {
            throw HubAPIError.unreachable(error.localizedDescription)
        }
    }

    private func request(path: String, method: String = "GET", body: [String: Any]? = nil) -> URLRequest? {
        guard let url = URL(string: path, relativeTo: baseURL) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let cookie {
            request.setValue("\(HubCookies.name)=\(cookie)", forHTTPHeaderField: "Cookie")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return request
    }

    private static func errorText(_ data: Data) -> String {
        if let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let message = payload["error"] as? String {
            return message
        }
        return String(data: data, encoding: .utf8) ?? ""
    }

    func state() async throws -> HubState {
        guard let request = request(path: "api/hub/state") else {
            throw HubAPIError.unreachable("invalid hub URL")
        }
        let (data, http) = try await perform(request)
        if http.statusCode == 401 { throw HubAPIError.unauthorized }
        guard http.statusCode == 200, let state = try? JSONDecoder().decode(HubState.self, from: data) else {
            throw HubAPIError.http(http.statusCode, Self.errorText(data))
        }
        return state
    }

    /// Registers a folder (and starts its session unless `start` is false).
    /// Throws `.needsInit` for the confirm-and-resubmit handshake.
    func addWorkspace(path folderPath: String, initRepo: Bool = false, start: Bool = true) async throws -> String {
        var body: [String: Any] = ["path": folderPath]
        if initRepo { body["init"] = true }
        if !start { body["start"] = false }
        guard let request = request(path: "api/hub/workspaces", method: "POST", body: body) else {
            throw HubAPIError.unreachable("invalid hub URL")
        }
        let (data, http) = try await perform(request)
        if http.statusCode == 401 { throw HubAPIError.unauthorized }
        if http.statusCode == 409,
           let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           payload["needsInit"] as? Bool == true {
            throw HubAPIError.needsInit
        }
        guard http.statusCode == 200,
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = payload["id"] as? String else {
            throw HubAPIError.http(http.statusCode, Self.errorText(data))
        }
        return id
    }

    func startSession(id: String) async throws {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        guard let request = request(path: "api/hub/sessions/\(encoded)/start", method: "POST") else {
            throw HubAPIError.unreachable("invalid hub URL")
        }
        let (data, http) = try await perform(request)
        if http.statusCode == 401 { throw HubAPIError.unauthorized }
        guard http.statusCode == 200 else {
            throw HubAPIError.http(http.statusCode, Self.errorText(data))
        }
    }

    /// Logs in with JSON credentials and returns the fresh `uatu_hub` cookie
    /// value. `.unauthorized` means rejected credentials; `.unreachable`
    /// means the host could not be contacted — the Add Hub flow tells the
    /// user which.
    static func login(baseURL: URL, name: String, password: String) async throws -> String {
        guard let url = URL(string: "login", relativeTo: baseURL) else {
            throw HubAPIError.unreachable("invalid hub URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["name": name, "password": password])
        let api = HubAPI(baseURL: baseURL)
        let (data, http) = try await api.perform(request)
        if http.statusCode == 401 { throw HubAPIError.unauthorized }
        guard http.statusCode == 303,
              let setCookie = http.value(forHTTPHeaderField: "Set-Cookie"),
              let value = cookieValue(fromSetCookie: setCookie) else {
            throw HubAPIError.http(http.statusCode, errorText(data))
        }
        return value
    }

    static func cookieValue(fromSetCookie header: String) -> String? {
        let prefix = "\(HubCookies.name)="
        for part in header.split(separator: ";") {
            let pair = part.trimmingCharacters(in: .whitespaces)
            if pair.hasPrefix(prefix) {
                let value = String(pair.dropFirst(prefix.count))
                return value.isEmpty ? nil : value
            }
        }
        return nil
    }
}

// MARK: - WebView cookie injection

/// Pushes the natively-held hub cookie into WKWebView's cookie store before
/// a navigation to that hub, so `/s/<id>/` pages load authenticated. The
/// native layer is the single writer — the web view never mints or refreshes
/// the cookie on its own.
enum HubCookies {
    /// The hub's session cookie name, spelled once: `inject`, `clear`, and
    /// the disappearance watch must agree on it or revocation silently
    /// misses.
    static let name = "uatu_hub"

    @MainActor
    static func inject(value: String, for hubURL: URL) async {
        guard let host = hubURL.host else { return }
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: name,
            .value: value,
            .domain: host,
            .path: "/",
            // Preserve the server cookie's HttpOnly: the injected copy must
            // not be script-readable via document.cookie, or an XSS on any
            // hub/session page could exfiltrate the bearer token. Foundation
            // has no public constant for this key, but HTTPCookie honors it.
            HTTPCookiePropertyKey("HttpOnly"): "TRUE",
        ]
        if hubURL.scheme?.lowercased() == "https" {
            properties[.secure] = "TRUE"
        }
        guard let cookie = HTTPCookie(properties: properties) else { return }
        await WKWebsiteDataStore.default().httpCookieStore.setCookie(cookie)
    }

    /// Removes a hub's session cookie from the web view's store — `inject`'s
    /// counterpart, used when the app revokes a hub's credentials. Without
    /// it the injected copy would outlive the Keychain one and re-authenticate
    /// the next navigation to that hub.
    @MainActor
    static func clear(for hubURL: URL) async {
        guard let host = hubURL.host else { return }
        let store = WKWebsiteDataStore.default().httpCookieStore
        for cookie in await store.allCookies() where cookie.name == name && matches(cookie, host: host) {
            await store.deleteCookie(cookie)
        }
    }

    /// Host comparison for stored cookies. `inject` writes a bare host, but a
    /// cookie that came from the server carries the domain the server set,
    /// which may lead with a dot.
    static func matches(_ cookie: HTTPCookie, host: String) -> Bool {
        normalizedDomain(cookie).caseInsensitiveCompare(host) == .orderedSame
    }

    static func normalizedDomain(_ cookie: HTTPCookie) -> String {
        let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
        return domain.lowercased()
    }
}

/// Watches the shared web-view cookie store and reports a hub session cookie
/// *disappearing* for a host.
///
/// This is the version-independent half of sign-out detection: a hub older
/// than this app signs out from the in-session switcher with a background
/// request, which the navigation delegate cannot see — but the hub's
/// `Max-Age=0` response still lands here.
///
/// A disappearance is safe to read as a deliberate clear because `inject`
/// sets no expiry: the injected copy is a session cookie with no natural
/// expiry event in the store. Server-side lifetime expiry surfaces as a 401
/// on the next request instead, and keeps its silent-re-login handling.
@MainActor
final class HubCookieWatch: NSObject, WKHTTPCookieStoreObserver {
    /// Hosts that held a hub cookie at the last observation. A disappearance
    /// only means something against a host we saw holding one.
    private var present: Set<String> = []
    private var onDisappear: ((String) -> Void)?
    private var started = false

    func start(onDisappear: @escaping (String) -> Void) {
        guard !started else { return }
        started = true
        self.onDisappear = onDisappear
        Task {
            // Baseline, then observe, then one reporting sweep against that
            // baseline.
            //
            // Observing first would leave a window in which a clear lands
            // while `present` is still empty — and an empty baseline compared
            // against an emptied store reports nothing, silently losing the
            // sign-out this watch exists to catch. Merely reordering is not
            // enough either: a clear could still slip between reading the
            // baseline and attaching the observer. The closing sweep compares
            // the store as it is NOW against the baseline, so anything that
            // happened during either gap is reported.
            await self.refresh(reporting: false)
            WKWebsiteDataStore.default().httpCookieStore.add(self)
            await self.refresh()
        }
    }

    /// Drops a host from the baseline, so a clear the app is about to perform
    /// itself reads as no change rather than as a fresh sign-out signal.
    ///
    /// Revocation calls `HubCookies.clear`, which changes the store and would
    /// otherwise echo straight back here as a second sign-out for the hub just
    /// revoked. That echo is not merely redundant: it arrives two async hops
    /// later, so a user who signs back in before it lands would have the
    /// credentials they just entered deleted by it.
    func forget(host: String) {
        present.remove(host.lowercased())
    }

    func refresh(reporting: Bool = true) async {
        let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        let holding = Set(
            cookies
                .filter { $0.name == HubCookies.name }
                .map { HubCookies.normalizedDomain($0) }
        )
        let gone = present.subtracting(holding)
        present = holding
        guard reporting else { return }
        for host in gone {
            onDisappear?(host)
        }
    }

    nonisolated func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        // WebKit calls its cookie-store observers on the main thread.
        MainActor.assumeIsolated {
            _ = Task { await self.refresh() }
        }
    }
}

// MARK: - Keychain

/// Hub secrets (passwords and session cookies) live only here — never in
/// UserDefaults or on disk in plaintext.
enum HubKeychain {
    private static let service = "se.coll8.uatucode.desktop.hubs"

    static func set(_ value: String, account: String) {
        delete(account: account)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(value.utf8),
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    static func get(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
