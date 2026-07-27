//
//  FindBar.swift
//  UatuCode Desktop
//

import SwiftUI
import WebKit

/// Find over the split browser's selected tab.
///
/// The split browser hosts arbitrary external pages, so uatu's own find — which
/// indexes the DOM and paints Ranges — is not on the table: that machinery
/// belongs to a document we render. WebKit's `findString` is the way in.
///
/// What that API can and cannot do shapes this bar. `WKFindResult` reports only
/// `matchFound`; there is no match count, so there is no "3 of 12" to show and
/// the bar says found / not found instead. `WKFindConfiguration` offers
/// backwards, case sensitivity, and wrapping — no whole-word, no regular
/// expressions. The SPA's find bar offers all three toggles and a counter; this
/// one deliberately offers less rather than faking either.
struct BrowserFindBar: View {
    let split: BrowserSplit
    @FocusState private var queryFocused: Bool

    var body: some View {
        HStack(spacing: 6) {
            TextField("Find in page", text: Binding(
                get: { split.selectedTab?.findQuery ?? "" },
                set: { split.selectedTab?.findQuery = $0 }
            ))
            .textFieldStyle(.roundedBorder)
            .frame(maxWidth: 220)
            .focused($queryFocused)
            .onSubmit { split.findNext(backwards: NSEvent.modifierFlags.contains(.shift)) }

            if let tab = split.selectedTab, tab.findState == .notFound {
                Text("No results")
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            Toggle("Aa", isOn: Binding(
                get: { split.selectedTab?.findCaseSensitive ?? false },
                set: { split.selectedTab?.findCaseSensitive = $0 }
            ))
            .toggleStyle(.button)
            .font(.caption)
            .help("Match case")

            Button {
                split.findNext(backwards: true)
            } label: {
                Image(systemName: "chevron.up")
            }
            .buttonStyle(.borderless)
            .help("Previous match")

            Button {
                split.findNext(backwards: false)
            } label: {
                Image(systemName: "chevron.down")
            }
            .buttonStyle(.borderless)
            .help("Next match")

            Button {
                split.closeFind()
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.borderless)
            .help("Close")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .onAppear { queryFocused = true }
        .onChange(of: queryFocused) { _, focused in split.findBarFocused = focused }
        // Reopening on an already-open bar re-focuses and selects, the way
        // pressing ⌘F twice does everywhere else.
        .onChange(of: split.findFocusToken) { queryFocused = true }
    }
}
