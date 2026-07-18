//
//  ContentView.swift
//  UatuCode Desktop
//

import AppKit
import SwiftUI
import UniformTypeIdentifiers
import WebKit

struct ContentView: View {
    let windowID: UUID
    @State private var server = UatuServer()
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
    @State private var isPickingFolder = false
    @State private var nativeWindow: NSWindow?
    /// The folder served by THIS window. Each window has its own.
    @State private var folder: URL?
    /// Recently served folders, newest first, one path per line. Shared
    /// across windows and shown on the launcher screen.
    @AppStorage("recentFolders") private var recentFoldersStorage = ""

    var body: some View {
        Group {
            switch server.status {
            case .idle:
                launcher
            case .starting:
                ProgressView("Starting uatu…")
            case .running:
                HStack(spacing: 0) {
                    HostedWebView(host: web)
                    if split.isOpen {
                        splitDivider
                        BrowserSplitView(split: split)
                            .frame(width: splitWidth)
                    }
                }
            case .failed(let message):
                ContentUnavailableView {
                    Label("uatu Failed", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                        .font(.callout.monospaced())
                        .multilineTextAlignment(.leading)
                } actions: {
                    Button("Try Again") { restart() }
                        .buttonStyle(.borderedProminent)
                    Button("Choose Folder…") { isPickingFolder = true }
                }
            }
        }
        .frame(minWidth: 700, minHeight: 500)
        .navigationTitle(folderName ?? "UatuCode Desktop")
        .focusedSceneValue(\.windowCommands, WindowCommands(
            isRunning: isRunning,
            folderPath: folder?.path,
            nativeWindow: nativeWindow,
            canGoBack: web.canGoBack,
            canGoForward: web.canGoForward,
            chooseFolder: { isPickingFolder = true },
            openFolder: { open($0) },
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
                if case .running(let url) = server.status {
                    NSWorkspace.shared.open(url)
                }
            }
        ))
        .toolbar {
            ToolbarItemGroup(placement: .navigation) {
                Button {
                    web.goBack()
                } label: {
                    Label("Back", systemImage: "chevron.backward")
                }
                .disabled(!isRunning || !web.canGoBack)
                Button {
                    web.goForward()
                } label: {
                    Label("Forward", systemImage: "chevron.forward")
                }
                .disabled(!isRunning || !web.canGoForward)
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    split.toggle()
                } label: {
                    Label("Toggle Split Browser", systemImage: "sidebar.trailing")
                }
                .disabled(!isRunning)
                .help("Toggle Split Browser (⇧⌘B)")
            }
        }
        .fileImporter(isPresented: $isPickingFolder, allowedContentTypes: [.folder]) { result in
            if case .success(let url) = result {
                open(url)
            }
        }
        .background(WindowResolver { window in
            window.tabbingIdentifier = "se.coll8.uatucode.desktop.main"
            server.bind(to: window)
            split.hostWindow = window
            NativeTabCoordinator.shared.resolve(windowID: windowID, window: window)
            NativeWindowMenuCoordinator.shared.refresh()
            DispatchQueue.main.async {
                nativeWindow = window
            }
        })
        .onChange(of: server.status) { _, newStatus in
            if case .running(let url) = newStatus {
                web.load(url)
            }
        }
        .onChange(of: pageZoom) {
            web.webView.pageZoom = pageZoom
            for tab in split.tabs {
                tab.webView.pageZoom = pageZoom
            }
        }
        .onAppear {
            // ⌘W / ⌘[ / ⌘] belong to the browser tab only while the split
            // has keyboard focus. Menu items can't express that: NSMenu
            // stops at the FIRST matching key equivalent even when
            // disabled (killing File > Close), and menu enablement goes
            // stale on focus changes. A key monitor checks focus at press
            // time and passes the event through to the menu (SPA
            // Back/Forward, window Close) whenever the browser isn't
            // focused.
            if browserKeyMonitor == nil {
                browserKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [split] event in
                    guard event.modifierFlags.intersection([.command, .shift, .option, .control]) == .command,
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

    private var launcher: some View {
        VStack(spacing: 28) {
            VStack(spacing: 8) {
                Image("Logo")
                    .resizable()
                    .scaledToFit()
                    .frame(height: 84)
                Text("UatuCode Desktop")
                    .font(.largeTitle.bold())
                Text("Serve a folder with uatu and view it here.")
                    .foregroundStyle(.secondary)
            }

            Button("Choose Folder…") { isPickingFolder = true }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

            if !recentFolders.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Recent")
                        .font(.headline)
                        .padding(.bottom, 6)
                    ForEach(recentFolders, id: \.path) { url in
                        Button {
                            open(url)
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "folder")
                                    .foregroundStyle(.tint)
                                VStack(alignment: .leading) {
                                    Text(url.lastPathComponent)
                                    Text(url.path)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                                Spacer()
                            }
                            .padding(.vertical, 5)
                            .padding(.horizontal, 8)
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .frame(maxWidth: 420)
            }
        }
        .padding(40)
    }

    private var recentFolders: [URL] {
        recentFoldersStorage
            .split(separator: "\n")
            .map { URL(fileURLWithPath: String($0)) }
    }

    private func open(_ url: URL) {
        folder = url
        var paths = recentFoldersStorage.split(separator: "\n").map(String.init)
        paths.removeAll { $0 == url.path }
        paths.insert(url.path, at: 0)
        recentFoldersStorage = paths.prefix(8).joined(separator: "\n")
        server.start(folder: url)
    }

    private var isRunning: Bool {
        if case .running = server.status { return true }
        return false
    }

    private var folderName: String? {
        folder?.lastPathComponent
    }

    private func restart() {
        guard let folder else {
            isPickingFolder = true
            return
        }
        server.start(folder: folder)
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
    var isRunning: Bool
    var folderPath: String?
    var nativeWindow: NSWindow?
    var canGoBack: Bool
    var canGoForward: Bool
    var chooseFolder: () -> Void
    var openFolder: (URL) -> Void
    var reload: () -> Void
    var goBack: () -> Void
    var goForward: () -> Void
    var toggleSplitBrowser: () -> Void
    var resetMagnification: () -> Void
    var openInBrowser: () -> Void

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.isRunning == rhs.isRunning
            && lhs.folderPath == rhs.folderPath
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
    @AppStorage("recentFolders") private var recentFoldersStorage = ""
    @AppStorage(ExternalLinkRouter.systemBrowserDefaultsKey) private var openLinksInSystemBrowser = false
    @AppStorage(PageZoom.defaultsKey) private var pageZoom = 1.0

    private var recentFolders: [URL] {
        recentFoldersStorage
            .split(separator: "\n")
            .map { URL(fileURLWithPath: String($0)) }
    }

    var body: some Commands {
        CommandGroup(after: .newItem) {
            Button("New Tab") { newTab() }
                .keyboardShortcut("t")
            Divider()
            Button("Choose Folder…") { window?.chooseFolder() }
                .keyboardShortcut("o")
                .disabled(window == nil)
            Menu("Open Recent") {
                ForEach(recentFolders, id: \.path) { url in
                    Button(url.lastPathComponent) { window?.openFolder(url) }
                }
                if !recentFolders.isEmpty {
                    Divider()
                    Button("Clear Menu") { recentFoldersStorage = "" }
                }
            }
            .disabled(window == nil || recentFolders.isEmpty)
        }
        CommandGroup(after: .toolbar) {
            Button("Back") { window?.goBack() }
                .keyboardShortcut("[")
                .disabled(window?.isRunning != true || window?.canGoBack != true)
            Button("Forward") { window?.goForward() }
                .keyboardShortcut("]")
                .disabled(window?.isRunning != true || window?.canGoForward != true)
            Divider()
            Button("Reload Page") { window?.reload() }
                .keyboardShortcut("r")
                .disabled(window?.isRunning != true)
            Button("Open in Browser") { window?.openInBrowser() }
                .keyboardShortcut("o", modifiers: [.command, .shift])
                .disabled(window?.isRunning != true)
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
                .disabled(window?.isRunning != true)
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
