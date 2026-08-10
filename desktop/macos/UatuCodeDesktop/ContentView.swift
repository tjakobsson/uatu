//
//  ContentView.swift
//  UatuCode Desktop
//

import AppKit
import SwiftUI
import WebKit

struct ContentView: View {
    let windowID: UUID
    @State private var web = WebViewHost()
    @State private var split = BrowserSplit()
    /// Split width is an app-level preference; which windows have the
    /// split open is session state on `split`.
    @AppStorage("browserSplitWidth") private var splitWidth = 480.0
    /// The shared page-zoom level: one value for the SPA pane and every
    /// browser tab, in every window. Web views also read it at creation.
    @AppStorage(PageZoom.defaultsKey) private var pageZoom = 1.0
    @State private var splitDragBaseWidth: Double?
    @State private var browserKeyMonitor: Any?
    /// Identifies the latest open request. A completion whose token no
    /// longer matches was superseded by a newer open (or a return to the
    /// splash) and must discard itself instead of loading a stale page.
    @State private var openRequestToken = UUID()
    @State private var nativeWindow: NSWindow?

    /// Window lifecycle: splash → connecting (opening) → open (web), with
    /// failed reachable from anywhere. Windows own no processes — a "page"
    /// is a hub URL.
    enum Phase: Equatable {
        case splash
        case opening(String)
        case web
        case failed(String)
    }

    @State private var phase: Phase = .splash
    /// The page this window is showing or trying to show; drives the
    /// window title, retry, and local-hub-death detection.
    @State private var currentPage: HubPage?
    /// The URL last handed to the web view (for Open in Browser).
    @State private var currentURL: URL?

    var body: some View {
        Group {
            switch phase {
            case .splash:
                SplashView(openPage: { open($0) })
            case .opening(let label):
                ProgressView(label)
            case .web:
                ZStack {
                    HStack(spacing: 0) {
                        // The web view spans the full window frame — the page is
                        // visible beneath the transparent titlebar and the glass
                        // toolbar (set up in the WindowResolver below). The split
                        // pane and divider stay inside the safe area, so their
                        // chrome starts below the toolbar without extra padding.
                        HostedWebView(host: web)
                            .ignoresSafeArea(edges: .top)
                        if split.isOpen {
                            // The divider spans the full window frame like its
                            // neighbors, but its visible hairline must start
                            // below the covered titlebar strip — un-inset it
                            // drew a line up through the tab bar.
                            splitDivider
                                .padding(.top, web.titlebarInset)
                                .ignoresSafeArea(edges: .top)
                            // The split pane also spans the full window height so
                            // no dead band appears under the transparent titlebar;
                            // its own chrome (tab strip, address bar) is padded
                            // down by the covered height. The value comes from the
                            // web host's contentLayoutRect observation — reading
                            // safeAreaInsets via GeometryReader reports 0 once the
                            // view ignores the safe area, so it can't be used.
                            BrowserSplitView(split: split)
                                .padding(.top, web.titlebarInset)
                                .frame(maxHeight: .infinity)
                                .background(.background)
                                .ignoresSafeArea(edges: .top)
                                .frame(width: splitWidth)
                        }
                    }
                    // Full-frame overlay that hit-tests only the covered strip,
                    // restoring titlebar dragging over the web view (see
                    // TitlebarDragArea). Full-frame + internal hit-testing
                    // sidesteps safe-area frame math entirely.
                    TitlebarDragArea(inset: web.titlebarInset)
                        .ignoresSafeArea(edges: .top)
                }
            case .failed(let message):
                ContentUnavailableView {
                    Label("uatu Failed", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                        .font(.callout.monospaced())
                        .multilineTextAlignment(.leading)
                } actions: {
                    Button("Try Again") { retry() }
                        .buttonStyle(.borderedProminent)
                    Button("Back to Splash") { showSplash() }
                }
            }
        }
        .frame(minWidth: 700, minHeight: 500)
        .navigationTitle(pageTitle)
        .focusedSceneValue(\.windowCommands, windowCommands)
        .toolbar {
            ToolbarItemGroup(placement: .navigation) {
                Button {
                    web.goBack()
                } label: {
                    Label("Back", systemImage: "chevron.backward")
                }
                .disabled(!hasPage || !web.canGoBack)
                Button {
                    web.goForward()
                } label: {
                    Label("Forward", systemImage: "chevron.forward")
                }
                .disabled(!hasPage || !web.canGoForward)
            }
            // With the window title hidden there is no title area to push
            // trailing items right — without an explicit flexible spacer the
            // primary action packs in next to the navigation buttons.
            ToolbarSpacer(.flexible)
            ToolbarItem(placement: .primaryAction) {
                Button {
                    split.toggle()
                } label: {
                    Label("Toggle Split Browser", systemImage: "sidebar.trailing")
                }
                .disabled(!hasPage)
                .help("Toggle Split Browser (⇧⌘B)")
            }
        }
        .background(WindowResolver { window in
            window.tabbingIdentifier = "se.coll8.uatucode.desktop.main"
            // Safari-style full-height content: the content view spans the
            // whole frame, the titlebar is transparent with no title text,
            // and the toolbar floats over the page as system glass. All
            // idempotent — the resolver re-runs on window re-resolution.
            window.styleMask.insert(.fullSizeContentView)
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            // No hairline between the (transparent) titlebar and the
            // content — with the toolbar floating as glass over the page,
            // the separator reads as a stray line above the tab bar.
            window.titlebarSeparatorStyle = .none
            web.bindTitlebarInset(to: window)
            split.hostWindow = window
            NativeTabCoordinator.shared.resolve(windowID: windowID, window: window)
            NativeWindowMenuCoordinator.shared.refresh()
            DispatchQueue.main.async {
                nativeWindow = window
            }
        })
        .onChange(of: hubSignOutMark) { previous, current in
            // A sign-out is app-wide, so EVERY window showing that hub comes
            // back to the splash — not just the one the user signed out in.
            // A sibling window left sitting on a hub the app has forgotten
            // would be showing a page it can no longer re-authenticate.
            //
            // Keyed on the connection's sign-out epoch rather than on
            // `.signedOut`, which a probe may publish transiently while a
            // silent re-login is about to recover.
            guard let previous, let current,
                  previous.entryID == current.entryID, current.epoch > previous.epoch,
                  phase == .web || isOpening else { return }
            showSplash()
        }
        .onChange(of: pageZoom) {
            web.webView.pageZoom = pageZoom
            for tab in split.tabs {
                tab.webView.pageZoom = pageZoom
            }
        }
        .onAppear {
            web.onNavigationFailed = { message in
                // A page whose hub stopped answering (network drop, hub
                // gone) must not linger as a dead web view.
                if phase == .web {
                    phase = .failed("The page could not be loaded.\n\(message)")
                }
            }
            // Signing out in the page revokes the hub app-wide. The window's
            // own return to the splash comes from the .signedOut transition
            // below, which every window watching this hub sees.
            web.onHubSignOut = { url in
                // The hub revokes the session server-side on this POST; the
                // app's part is to discard its own copies. Only the hub this
                // window is actually showing may be signed out by it: a page
                // can post a form to any origin it likes, so without this a
                // page on one hub could delete another configured hub's
                // Keychain credentials. A window's own sign-out always
                // targets its own origin, so nothing legitimate needs the
                // looser form.
                guard case .dashboard(let shown) = currentPage,
                      let signedOut = HubRoster.shared.entry(for: url),
                      signedOut.id == shown.id else { return }
                HubRoster.shared.signOut(shown)
            }
            web.onHubLoginPage = { url in
                // This window's hub session ended. Whatever ended it, a hub's
                // web login page is the wrong thing to leave on screen in an
                // app that owns hub credentials natively — the splash card is
                // where signing back in lives.
                //
                // Same identity check as the sign-out signal above: it must be
                // THIS window's hub. Another configured hub's login page is
                // not evidence about this window's session, and acting on one
                // would let an unrelated origin eject the page the user is on.
                //
                // `.web` only, deliberately. `loadWeb` sets `.web` before the
                // navigation starts, so a genuine landing on a login page is
                // always reported in that phase. A report arriving while the
                // window is `.opening` therefore belongs to a PREVIOUS
                // navigation — the allowed-through login load whose commit
                // arrives after the user has already reopened the hub — and
                // acting on it would cancel the open they just asked for.
                guard case .dashboard(let shown) = currentPage,
                      let landed = HubRoster.shared.entry(for: url),
                      landed.id == shown.id,
                      phase == .web else { return }
                showSplash()
            }
            // ⌘W / ⌘[ / ⌘] belong to the browser tab only while the split
            // has keyboard focus. Menu items can't express that: NSMenu
            // stops at the FIRST matching key equivalent even when
            // disabled (killing File > Close), and menu enablement goes
            // stale on focus changes. A key monitor checks focus at press
            // time and passes the event through to the menu (SPA
            // Back/Forward, window Close) whenever the browser isn't
            // focused.
            if browserKeyMonitor == nil {
                browserKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [split, web] event in
                    let modifiers = event.modifierFlags.intersection([.command, .shift, .option, .control])
                    // Escape closes the browser find bar. Unmodified, so it has
                    // to be handled before the ⌘-only guard below.
                    // `ownsFindShortcut` rather than a bare `findBarFocused`:
                    // it makes the host-window check, and every window installs
                    // this monitor — without it, one window's focused find bar
                    // would swallow an Escape pressed in another window.
                    if modifiers.isEmpty, event.keyCode == 53, split.findOpen,
                       split.ownsFindShortcut(in: event.window) {
                        split.closeFind()
                        return nil
                    }
                    // Find and Find Next/Previous. The page implements find for
                    // every surface it owns, but ⌘F only reaches it while the
                    // document has focus: WebKit swallows the key for its own
                    // editing machinery whenever an editable element is focused,
                    // and xterm keeps a helper <textarea> focused the whole time
                    // the terminal is in use — which made find dead exactly
                    // there. Claiming the key here and calling into the page
                    // makes the behaviour identical regardless of what has
                    // focus.
                    if modifiers == .command || modifiers == [.command, .shift] {
                        if let key = event.charactersIgnoringModifiers?.lowercased(),
                           key == "f" || key == "g" {
                            // The split browser hosts arbitrary external pages,
                            // so it searches them with WebKit's own find rather
                            // than the SPA's. ⇧⌘F is never routed here: project
                            // search is global and always belongs to uatu.
                            let toBrowser = split.ownsFindShortcut(in: event.window)
                                && !(key == "f" && modifiers.contains(.shift))
                            if toBrowser {
                                if key == "f" {
                                    split.openFind()
                                } else {
                                    split.findNext(backwards: modifiers.contains(.shift))
                                }
                                return nil
                            }
                            let script: String
                            if key == "f" {
                                // ⌘F is find on the active surface; ⇧⌘F is
                                // project search, which is a different feature
                                // rather than a modifier on the same one.
                                script = modifiers.contains(.shift)
                                    ? "window.__uatuFind?.search()"
                                    : "window.__uatuFind?.open()"
                            } else {
                                let delta = modifiers.contains(.shift) ? -1 : 1
                                script = "window.__uatuFind?.step(\(delta))"
                            }
                            web.webView.evaluateJavaScript(script)
                            return nil
                        }
                    }

                    guard modifiers == .command,
                          let key = event.charactersIgnoringModifiers
                    else { return event }
                    // ⌘= is the standard alias for Zoom In on layouts
                    // where + is shifted (e.g. US); a menu item can only
                    // carry one key equivalent, so the monitor claims it.
                    if key == "=" {
                        UserDefaults.standard.set(
                            PageZoom.zoomedIn(from: PageZoom.storedLevel),
                            forKey: PageZoom.defaultsKey
                        )
                        return nil
                    }
                    guard key == "w" || key == "[" || key == "]",
                          split.hasFocus(in: event.window),
                          let tab = split.selectedTab
                    else { return event }
                    switch key {
                    case "w": split.close(tab)
                    case "[": tab.goBack()
                    default: tab.goForward()
                    }
                    return nil
                }
            }
            // In-app is the default; ⌘-click and the opt-out setting fall
            // back to the change's original system-browser behavior.
            web.routeExternal = { [split] url, commandClick in
                let scheme = url.scheme?.lowercased()
                let toSystem = commandClick
                    || (scheme != "http" && scheme != "https")
                    || UserDefaults.standard.bool(forKey: ExternalLinkRouter.systemBrowserDefaultsKey)
                if toSystem {
                    ExternalLinkRouter.open(url)
                } else {
                    split.open(url)
                }
            }
        }
        .onDisappear {
            // The window is going away — sessions belong to the hub and
            // keep running, but in-flight open completions must not land
            // in a dead window.
            openRequestToken = UUID()
            if let browserKeyMonitor {
                NSEvent.removeMonitor(browserKeyMonitor)
                self.browserKeyMonitor = nil
            }
        }
    }

    private var splitDivider: some View {
        // The visible hairline sits centered in a 9pt-wide grab zone; the
        // whole zone is the drag target so the divider is easy to hit.
        ZStack {
            Rectangle()
                .fill(Color(nsColor: .separatorColor))
                .frame(width: 1)
        }
        .frame(width: 9)
        .frame(maxHeight: .infinity)
        .contentShape(.rect)
        .gesture(
            DragGesture(coordinateSpace: .global)
                .onChanged { value in
                    let base = splitDragBaseWidth ?? splitWidth
                    splitDragBaseWidth = base
                    splitWidth = min(max(300, base - value.translation.width), 1200)
                }
                .onEnded { _ in
                    splitDragBaseWidth = nil
                }
        )
        .onHover { hovering in
            if hovering {
                NSCursor.resizeLeftRight.push()
            } else {
                NSCursor.pop()
            }
        }
    }

    // Built outside the view body: inlining it pushed the body's expression
    // past what the Swift type-checker will chew through in reasonable time.
    private var windowCommands: WindowCommands {
        WindowCommands(
            hasPage: hasPage,
            pageKey: pageTitle,
            nativeWindow: nativeWindow,
            canGoBack: web.canGoBack,
            canGoForward: web.canGoForward,
            // nil opens find; a delta steps to the next/previous match.
            //
            // Menu activation does not pass through the key monitor, so the
            // same focus dispatch has to happen here — otherwise Edit ▸ Find
            // searches the document hidden behind the split while the user is
            // looking at a browser tab.
            find: { delta in
                if split.ownsFindShortcut(in: nativeWindow) {
                    if let delta {
                        split.findNext(backwards: delta < 0)
                    } else {
                        split.openFind()
                    }
                    return
                }
                let script = delta.map { "window.__uatuFind?.step(\($0))" } ?? "window.__uatuFind?.open()"
                web.webView.evaluateJavaScript(script)
            },
            findInFiles: {
                web.webView.evaluateJavaScript("window.__uatuFind?.search()")
            },
            reload: { web.reload() },
            goBack: { web.goBack() },
            goForward: { web.goForward() },
            toggleSplitBrowser: { split.toggle() },
            resetMagnification: {
                web.webView.magnification = 1.0
                for tab in split.tabs {
                    tab.webView.magnification = 1.0
                }
            },
            openInBrowser: {
                if let url = web.webView.url ?? currentURL {
                    NSWorkspace.shared.open(url)
                }
            }
        )
    }

    // MARK: - Page opening

    /// Opens a hub page in this window: write the session id into the web
    /// view's cookie store, then load the hub's dashboard.
    private func open(_ page: HubPage) {
        let token = UUID()
        openRequestToken = token
        currentPage = page

        switch page {
        case .dashboard(let entry):
            phase = .opening("Connecting to \(entry.name)…")
            Task {
                guard let base = entry.url else { phase = .failed("Invalid hub URL."); return }
                await HubRoster.shared.connection(for: entry).injectSessionCookie()
                guard openRequestToken == token else { return }
                loadWeb(base)
            }
        }
    }

    private func loadWeb(_ url: URL) {
        currentURL = url
        phase = .web
        web.load(url)
    }

    private func retry() {
        if let currentPage {
            open(currentPage)
        } else {
            showSplash()
        }
    }

    private func showSplash() {
        // Cancels any open still in flight. Opening a remote hub awaits cookie
        // injection, and a completion landing after this would sail past its
        // unchanged-token guard and put the window back on the page it was
        // just taken off — including a hub whose credentials were revoked
        // mid-open by another window.
        openRequestToken = UUID()
        phase = .splash
        currentPage = nil
        currentURL = nil
    }

    // MARK: - Derived state

    private var hasPage: Bool { phase == .web }

    /// Which hub this window is showing and how many times it has been
    /// signed out. Reading it during body evaluation is what subscribes the
    /// window to that connection's changes. The hub's id travels with the
    /// epoch so that switching pages cannot read as a sign-out.
    private struct HubSignOutMark: Equatable {
        let entryID: UUID
        let epoch: Int
    }

    private var hubSignOutMark: HubSignOutMark? {
        guard case .dashboard(let entry) = currentPage else { return nil }
        return HubSignOutMark(entryID: entry.id, epoch: HubRoster.shared.connection(for: entry).signOutEpoch)
    }

    private var isOpening: Bool {
        if case .opening = phase { return true }
        return false
    }

    private var pageTitle: String {
        switch currentPage {
        case .dashboard(let entry): return entry.name
        case nil: return "UatuCode Desktop"
        }
    }

    private static func describe(_ error: Error) -> String {
        switch error {
        case HubAPIError.unauthorized: return "The hub requires sign-in."
        case HubAPIError.needsInit: return "The folder is not a git repository."
        case HubAPIError.unreachable(let detail): return "The hub could not be reached.\n\(detail)"
        case HubAPIError.http(_, let message): return message.isEmpty ? "The hub reported an error." : message
        default: return error.localizedDescription
        }
    }
}

private struct WindowResolver: NSViewRepresentable {
    var resolve: (NSWindow) -> Void

    func makeNSView(context: Context) -> WindowResolutionView {
        let view = WindowResolutionView()
        view.resolve = resolve
        return view
    }

    func updateNSView(_ view: WindowResolutionView, context: Context) {
        view.resolve = resolve
        if let window = view.window {
            resolve(window)
        }
    }
}

private final class WindowResolutionView: NSView {
    var resolve: ((NSWindow) -> Void)?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let window {
            resolve?(window)
        }
    }
}

/// Actions of the focused window, exposed to the menu bar commands.
struct WindowCommands: Equatable {
    var hasPage: Bool
    var pageKey: String?
    var nativeWindow: NSWindow?
    var canGoBack: Bool
    var canGoForward: Bool
    var find: (Int?) -> Void
    var findInFiles: () -> Void
    var reload: () -> Void
    var goBack: () -> Void
    var goForward: () -> Void
    var toggleSplitBrowser: () -> Void
    var resetMagnification: () -> Void
    var openInBrowser: () -> Void

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.hasPage == rhs.hasPage
            && lhs.pageKey == rhs.pageKey
            && lhs.nativeWindow === rhs.nativeWindow
            && lhs.canGoBack == rhs.canGoBack
            && lhs.canGoForward == rhs.canGoForward
    }
}

extension FocusedValues {
    @Entry var windowCommands: WindowCommands?
}

struct UatuCodeDesktopCommands: Commands {
    @FocusedValue(\.windowCommands) private var window
    @Environment(\.openWindow) private var openWindow
    @AppStorage(ExternalLinkRouter.systemBrowserDefaultsKey) private var openLinksInSystemBrowser = false
    @AppStorage(PageZoom.defaultsKey) private var pageZoom = 1.0

    var body: some Commands {
        CommandGroup(after: .newItem) {
            Button("New Tab") { newTab() }
                .keyboardShortcut("t")
        }
        // Find lives in the Edit menu where macOS users look for it. These are
        // discoverability and shortcut advertisement only: the key monitor in
        // ContentView claims ⌘F / ⌘G before the menu sees it, because the key
        // has to work even when WebKit would otherwise swallow it for a focused
        // editable element (xterm's helper textarea). Replacing `.textEditing`
        // also guarantees no inherited Find item is left bound to ⌘F targeting
        // a responder that ignores it — but the replaced placement carries the
        // standard editing commands too, so they are restored explicitly here:
        // dropping them would strip Cut/Copy/Paste and Select All from the
        // Edit menu for every text field and web view, which menu-based and
        // accessibility-driven editing depends on. Each targets the responder
        // chain, exactly as the native items do.
        CommandGroup(replacing: .textEditing) {
            Button("Cut") { NSApp.sendAction(#selector(NSText.cut(_:)), to: nil, from: nil) }
                .keyboardShortcut("x")
            Button("Copy") { NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: nil) }
                .keyboardShortcut("c")
            Button("Paste") { NSApp.sendAction(#selector(NSText.paste(_:)), to: nil, from: nil) }
                .keyboardShortcut("v")
            Button("Delete") { NSApp.sendAction(#selector(NSText.delete(_:)), to: nil, from: nil) }
            Button("Select All") { NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: nil) }
                .keyboardShortcut("a")
            Divider()
            Button("Find…") { window?.find(nil) }
                .keyboardShortcut("f")
                .disabled(window?.hasPage != true)
            Button("Find in Files…") { window?.findInFiles() }
                .keyboardShortcut("f", modifiers: [.command, .shift])
                .disabled(window?.hasPage != true)
            Button("Find Next") { window?.find(1) }
                .keyboardShortcut("g")
                .disabled(window?.hasPage != true)
            Button("Find Previous") { window?.find(-1) }
                .keyboardShortcut("g", modifiers: [.command, .shift])
                .disabled(window?.hasPage != true)
        }
        CommandGroup(after: .toolbar) {
            Button("Back") { window?.goBack() }
                .keyboardShortcut("[")
                .disabled(window?.hasPage != true || window?.canGoBack != true)
            Button("Forward") { window?.goForward() }
                .keyboardShortcut("]")
                .disabled(window?.hasPage != true || window?.canGoForward != true)
            Divider()
            Button("Reload Page") { window?.reload() }
                .keyboardShortcut("r")
                .disabled(window?.hasPage != true)
            Button("Open in Browser") { window?.openInBrowser() }
                .keyboardShortcut("o", modifiers: [.command, .shift])
                .disabled(window?.hasPage != true)
            Divider()
            Button("Actual Size") {
                pageZoom = 1.0
                window?.resetMagnification()
            }
            .keyboardShortcut("0")
            .disabled(window == nil)
            // Actions and enablement read the live defaults value, not the
            // wrapper: the wrapper's cache can lag behind writes made since
            // the menu was last rebuilt, which would make repeated Zoom In
            // recompute the same step. The wrapper stays as the write path
            // so changes still invalidate the menu.
            Button("Zoom In") { pageZoom = PageZoom.zoomedIn(from: PageZoom.storedLevel) }
                .keyboardShortcut("+")
                .disabled(window == nil || !PageZoom.canZoomIn(from: PageZoom.storedLevel))
            Button("Zoom Out") { pageZoom = PageZoom.zoomedOut(from: PageZoom.storedLevel) }
                .keyboardShortcut("-")
                .disabled(window == nil || !PageZoom.canZoomOut(from: PageZoom.storedLevel))
            Divider()
            Button("Toggle Split Browser") { window?.toggleSplitBrowser() }
                .keyboardShortcut("b", modifiers: [.command, .shift])
                .disabled(window?.hasPage != true)
            Toggle("Open External Links in System Browser", isOn: $openLinksInSystemBrowser)
            Divider()
        }
        CommandGroup(before: .windowList) {
            ForEach(1...8, id: \.self) { number in
                Button("Show Tab \(number)") { selectTab(at: number - 1) }
                    .keyboardShortcut(KeyEquivalent(Character(String(number))))
                    .disabled(nativeTabs.count < number)
            }
            Button("Show Last Tab") { selectLastTab() }
                .keyboardShortcut("9")
                .disabled(nativeTabs.isEmpty)
            Divider()
        }
    }

    private func newTab() {
        let windowID = UUID()
        guard let parentWindow = NativeTabCoordinator.shared.parentWindow(
            focusedWindow: window?.nativeWindow
        ) else {
            openWindow(id: "main", value: windowID)
            return
        }
        NativeTabCoordinator.shared.expect(windowID: windowID, in: parentWindow)
        openWindow(id: "main", value: windowID)
    }

    private var nativeTabs: [NSWindow] {
        guard let nativeWindow = window?.nativeWindow else { return [] }
        return nativeWindow.tabGroup?.windows ?? [nativeWindow]
    }

    private func selectTab(at index: Int) {
        guard nativeTabs.indices.contains(index) else { return }
        nativeTabs[index].tabGroup?.selectedWindow = nativeTabs[index]
    }

    private func selectLastTab() {
        guard let lastTab = nativeTabs.last else { return }
        lastTab.tabGroup?.selectedWindow = lastTab
    }
}

@MainActor
private final class NativeWindowMenuCoordinator {
    static let shared = NativeWindowMenuCoordinator()

    private var observers: [NSObjectProtocol] = []

    private init() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: NSMenu.didAddItemNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            MainActor.assumeIsolated {
                guard notification.object as? NSMenu === NSApp.windowsMenu else { return }
                self?.refresh()
            }
        })
        observers.append(center.addObserver(
            forName: NSWindow.didBecomeKeyNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.refresh()
            }
        })
    }

    func refresh() {
        guard let windowsMenu = NSApp.windowsMenu else { return }

        for item in windowsMenu.items
        where item.action == #selector(NSWindow.makeKeyAndOrderFront(_:)) {
            guard let window = item.target as? NSWindow,
                  let tabGroup = window.tabGroup,
                  tabGroup.windows.count > 1,
                  let selectedWindow = tabGroup.selectedWindow else {
                item.isHidden = false
                continue
            }
            item.isHidden = selectedWindow !== window
        }
    }
}

/// Correlates a requested scene with its native window without retaining tabs.
@MainActor
private final class NativeTabCoordinator {
    static let shared = NativeTabCoordinator()

    private final class PendingTab {
        weak var parentWindow: NSWindow?

        init(parentWindow: NSWindow) {
            self.parentWindow = parentWindow
        }
    }

    private var pendingTabs: [UUID: PendingTab] = [:]
    private weak var lastContentWindow: NSWindow?

    func parentWindow(focusedWindow: NSWindow?) -> NSWindow? {
        if let focusedWindow {
            lastContentWindow = focusedWindow
            return focusedWindow
        }
        if let selectedWindow = lastContentWindow?.tabGroup?.selectedWindow {
            return selectedWindow
        }
        guard lastContentWindow?.isVisible == true else { return nil }
        return lastContentWindow
    }

    func expect(windowID: UUID, in parentWindow: NSWindow) {
        lastContentWindow = parentWindow
        pendingTabs[windowID] = PendingTab(parentWindow: parentWindow)
    }

    func resolve(windowID: UUID, window: NSWindow) {
        guard let pendingTab = pendingTabs.removeValue(forKey: windowID),
              let parentWindow = pendingTab.parentWindow,
              parentWindow !== window else { return }

        window.tabbingIdentifier = parentWindow.tabbingIdentifier
        window.tabbingMode = .preferred
    }
}

#Preview {
    ContentView(windowID: UUID())
}
