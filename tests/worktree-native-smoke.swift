// Manual macOS navigation check, compiled with the desktop's real WebViewHost.
// Run via tests/worktree-native-smoke.ts. Uses a temporary Hub and fixture login.
import AppKit
import WebKit

@main
@MainActor
enum WorktreeNativeSmoke {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let host = WebViewHost()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 900),
                              styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.contentView = host.webView
        host.bindTitlebarInset(to: window)
        window.orderFront(nil)
        Task { @MainActor in
            do {
                try await run(host)
                print("Native WebViewHost: login, picker switch, Back, Forward and titlebar inset passed")
                exit(0)
            } catch {
                print("Native WebViewHost failed: \(error)")
                exit(1)
            }
        }
        app.run()
    }

    static func run(_ host: WebViewHost) async throws {
        let origin = ProcessInfo.processInfo.environment["UATU_SMOKE_ORIGIN"]!
        let child = ProcessInfo.processInfo.environment["UATU_SMOKE_CHILD"]!
        // The file tree is a web component. Match Playwright's shadow-piercing
        // locator behavior when driving the actual native WebView.
        let query = """
        function q(selector, root = document) {
          const found = root.querySelector(selector); if (found) return found;
          for (const element of root.querySelectorAll('*')) {
            if (element.shadowRoot) { const nested = q(selector, element.shadowRoot); if (nested) return nested; }
          }
          return null;
        }
        """
        func js(_ script: String) async throws {
            _ = try await host.webView.evaluateJavaScript("(() => { \(query) \(script.replacingOccurrences(of: "document.querySelector", with: "q")) })()")
        }
        func wait(_ expression: String) async throws {
            for _ in 0..<200 {
                let script = "(() => { \(query) return \(expression.replacingOccurrences(of: "document.querySelector", with: "q")); })()"
                if (try? await host.webView.evaluateJavaScript(script)) as? Bool == true { return }
                try await Task.sleep(for: .milliseconds(100))
            }
            throw NSError(domain: "WorktreeSmoke", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Timed out: \(expression)"])
        }
        host.load(URL(string: origin + "/login")!)
        try await wait("!!document.querySelector('input[name=name]')")
        try await js("document.querySelector('input[name=name]').value='e2e'; document.querySelector('input[name=password]').value='e2e-hub-password'; document.querySelector('form').requestSubmit()")
        try await wait("location.pathname === '/'")
        host.load(URL(string: origin + "/s/atlas/")!)
        try await wait("document.querySelector('#connection-state .connection-label')?.textContent === 'Connected'")
        try await wait("!!document.querySelector('[data-item-path=\"NOTES.md\"]')")
        try await js("document.querySelector('[data-item-path=\"NOTES.md\"]').click()")
        try await wait("document.querySelector('#preview')?.textContent.includes('atlas source notes') === true")
        try await js("document.querySelector('#hub-toggle').click()")
        try await wait("!!document.querySelector('#hub-menu a[href=\"/s/\(child)/\"]')")
        try await js("document.querySelector('#hub-menu a[href=\"/s/\(child)/\"]').click()")
        try await wait("location.pathname.startsWith('/s/\(child)/') && document.querySelector('#connection-state .connection-label')?.textContent === 'Connected'")
        try await wait("document.documentElement.classList.contains('uatu-desktop-host')")
        host.goBack()
        try await wait("location.pathname.startsWith('/s/atlas/') && document.querySelector('#preview')?.textContent.includes('atlas source notes') === true")
        host.goForward()
        try await wait("location.pathname.startsWith('/s/\(child)/') && document.querySelector('#connection-state .connection-label')?.textContent === 'Connected'")
    }
}
