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
            request.setValue("uatu_hub=\(cookie)", forHTTPHeaderField: "Cookie")
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
        for part in header.split(separator: ";") {
            let pair = part.trimmingCharacters(in: .whitespaces)
            if pair.hasPrefix("uatu_hub=") {
                let value = String(pair.dropFirst("uatu_hub=".count))
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
    @MainActor
    static func inject(value: String, for hubURL: URL) async {
        guard let host = hubURL.host else { return }
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: "uatu_hub",
            .value: value,
            .domain: host,
            .path: "/",
        ]
        if hubURL.scheme?.lowercased() == "https" {
            properties[.secure] = "TRUE"
        }
        guard let cookie = HTTPCookie(properties: properties) else { return }
        await WKWebsiteDataStore.default().httpCookieStore.setCookie(cookie)
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
