//
//  BrowserSplitView.swift
//  UatuCode Desktop
//

import SwiftUI
import WebKit

/// The split browser pane: a custom tab strip (native macOS tabs are
/// window-level and cannot nest inside a pane), per-tab chrome with an
/// editable address bar, and the selected tab's web view.
struct BrowserSplitView: View {
    let split: BrowserSplit
    @State private var addressText = ""
    @FocusState private var addressFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            tabStrip
            Divider()
            if let tab = split.selectedTab {
                chromeRow(for: tab)
                Divider()
                BrowserTabWebView(tab: tab)
                    .id(tab.id)
            } else {
                Spacer()
            }
        }
        .background(.background)
        .onChange(of: split.selectedID) { syncAddress() }
        .onChange(of: split.selectedTab?.url) { syncAddress() }
        .onChange(of: addressFocused) { _, focused in
            split.addressBarFocused = focused
        }
        .onAppear { syncAddress() }
    }

    private var tabStrip: some View {
        HStack(spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(split.tabs) { tab in
                        tabItem(tab)
                    }
                }
                .padding(.horizontal, 6)
            }
            Button {
                split.newTab()
                addressFocused = true
            } label: {
                Image(systemName: "plus")
            }
            .buttonStyle(.borderless)
            .help("New Tab")
            .padding(.trailing, 8)
        }
        .frame(height: 30)
    }

    private func tabItem(_ tab: BrowserTab) -> some View {
        let selected = tab.id == split.selectedID
        return HStack(spacing: 4) {
            Text(tab.title.isEmpty ? (tab.url?.host() ?? "New Tab") : tab.title)
                .lineLimit(1)
                .truncationMode(.tail)
                .font(.callout)
            Button {
                split.close(tab)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 8, weight: .bold))
            }
            .buttonStyle(.borderless)
            .help("Close Tab")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .frame(maxWidth: 180)
        .background(selected ? AnyShapeStyle(.selection) : AnyShapeStyle(.clear), in: .rect(cornerRadius: 5))
        .contentShape(.rect)
        .onTapGesture {
            split.selectedID = tab.id
        }
    }

    private func chromeRow(for tab: BrowserTab) -> some View {
        HStack(spacing: 6) {
            Button {
                tab.goBack()
            } label: {
                Image(systemName: "chevron.backward")
            }
            .disabled(!tab.canGoBack)
            .help("Back")
            Button {
                tab.goForward()
            } label: {
                Image(systemName: "chevron.forward")
            }
            .disabled(!tab.canGoForward)
            .help("Forward")
            Button {
                tab.reload()
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .help("Reload")
            TextField("Search or enter address", text: $addressText)
                .textFieldStyle(.roundedBorder)
                .focused($addressFocused)
                .onSubmit {
                    commitAddress(tab)
                }
            Button {
                if let url = tab.url {
                    ExternalLinkRouter.open(url)
                }
                split.close(tab)
            } label: {
                Image(systemName: "arrow.up.forward.square")
            }
            .disabled(tab.url == nil)
            .help("Open in Browser and Close Tab")
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 8)
        .frame(height: 34)
    }

    private func syncAddress() {
        addressText = split.selectedTab?.url?.absoluteString ?? ""
    }

    private func commitAddress(_ tab: BrowserTab) {
        let input = addressText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty else { return }
        tab.load(Self.destination(for: input))
    }

    /// Address-bar semantics: something with a scheme loads as-is, a bare
    /// host gets https:// prefixed, anything else becomes a web search.
    static func destination(for input: String) -> URL {
        if input.contains("://"), let url = URL(string: input), url.scheme != nil {
            return url
        }
        if !input.contains(" "), input.contains("."),
           let url = URL(string: "https://\(input)"), url.host() != nil {
            return url
        }
        var search = URLComponents(string: "https://duckduckgo.com/")!
        search.queryItems = [URLQueryItem(name: "q", value: input)]
        return search.url!
    }
}

private struct BrowserTabWebView: NSViewRepresentable {
    let tab: BrowserTab

    func makeNSView(context: Context) -> WKWebView {
        tab.webView
    }

    func updateNSView(_ view: WKWebView, context: Context) {}
}
