# Design

## Context

See `proposal.md` for why, and `pr-mockups/switcher/design.md` (with its six wireframes) for the approved interaction design. Today:

- `src/shell/hub-nav.ts` owns the Hub's workspace list, the brokered activity facts, the stop reconcile, Start, and a dropdown (`#hub-menu`) inside the sidebar header (`#hub-control`). Its rows are kept as the same DOM nodes across background refreshes (`reconcileMenuEntries`) so a click or focus is never lost; many unit tests rely on that.
- `src/shell/pull-request-picker.ts` is a separate `<dialog>` that lists open pull requests, looks up a number in any state, and runs the simulated "Create worktree" confirmation.
- "Picked" (viewing) is page-local in `pullRequestStore` (`scopedNumber()`), restored from `?pr=`. Three notices say it: the pane's `.pr-pane-scope`, the Files scope bar's Back, and the preview header's `.pr-picked-chip`.
- Touch mode hides the sidebar on every tab but Files; the tab bar is the only chrome on the other tabs.

## Goals / Non-Goals

**Goals:**
- Phases 1 and 2 of the design: the touch button, the dialog (status card, search, Checkouts, Pull requests, footer), two-line rows, the choice step, Go to its worktree, **+ New**, the desktop chip's second line, the Viewing strip, the vocabulary, and the picker retired.
- Keep every Hub behavior the old menu had: live activity, badges, stop reconcile, Start (now in the status card for the current session), unlock routing, stable row nodes, the viewed acknowledgement.

**Non-Goals:**
- ~~A real checkout from a pull request~~: done as phase 3 (D8) once the Hub's `pull-request` create mode landed (`add-github-pr-review` D12); the real GitHub transport is still that change's.
- Navigator links (phase 4); not on this branch.
- A keyboard shortcut for the switcher.
- `n changes` on checkout rows: the activity topic carries only four booleans per workspace (design A6), so there is nothing to count.

## Decisions

**D1. One panel element, not a `<dialog>`.** `#hub-menu` becomes a body-level `role="dialog" aria-modal="true"` panel with its own backdrop, focus containment and Escape handling, styled as a full-height sheet on touch and a panel under the chip on desktop. A modal `<dialog>` would put the panel in the top layer and make the worktree fork menu (a fixed `role="menu"` appended to `<body>`) inert, and the linkedom unit tests have no `showModal`. Alternative considered: keep the dropdown inside `#hub-control` on desktop and a separate sheet on touch; rejected because the design wants the same content in both, and on touch the sidebar is hidden on three of the four tabs.

**D2. hub-nav keeps the Hub data and renders Checkouts; switcher.ts owns the dialog.** `initHubNav` still reads the Hub list and activity and still renders the Checkouts rows with `reconcileMenuEntries`, so the stable-node guarantees and their tests carry over. A new `src/shell/switcher.ts` owns the button, the chip's second line, the dialog's frame, status card, search, Pull requests, choice step, footer and strips, and asks hub-nav for its part through a small registered adapter (`registerSwitcherHub`). Outside a Hub there is no adapter and the dialog has no Checkouts or footer. Pure rules (row lines, ordering, search matching, the query parser and lookup text moved from the picker) live in `src/shell/switcher-model.ts` with colocated tests. Alternative: move everything into hub-nav; rejected because the switcher must also work without a Hub.

**D3. Search is a combobox over two listboxes.** The field carries `role="combobox"`, `aria-controls` naming both lists and `aria-activedescendant`; each list is a labelled `role="listbox"` inside a labelled group, and each row is an option (checkout rows stay `<a href>` with `role="option"` and `tabindex="-1"`, so modified clicks still open elsewhere). ArrowUp/Down move across both lists; Enter activates. Section controls (**+ New**, `Open ▾`, `Show all n`) are ordinary buttons outside the lists.

**D4. Back and View here go through events.** The shell must not import `shell/url.ts` (import cycle), so the switcher dispatches `uatu:open-pull-request` (existing) and a new `uatu:show-branch`; the Pull request pane module performs the navigation and focus. Viewing stays page-local, restored by `?pr=` (design A1).

**D5. The picker's flows move into the choice step.** Lookup in any state, the other-repository sentence, the no-credential line and the simulated confirmation move from `pull-request-picker.ts` into the switcher; the module and its dialog are deleted, with its pure helpers and tests moved to `switcher-model.ts`.

**D6. Two client-only items from phase 3 come along.** One search over both lists and status ordering of Checkouts are client-only and drawn in the approved wireframes; doing them now avoids a search that ignores half the sheet. The phase-3 items that need server work stay out.

**D8. Phase 3: the real check-out, on the Hub's worktree family.** The Hub part registers `worktreeSource()` (the published family's path and the main checkout), and `src/shell/pull-request-checkout.ts` makes the requests: `pull-request` for a fork, `fetch` then `existing-local` or `remote-tracking` for the same repository (D12). The remote is the list's `remote`, else `origin`. The switcher keeps creations page-local by number, renders them in `#switcher-creating` under the Hub's own Checkouts rows (hub-nav's reconciled list is left alone), marks the pull request's row, and shows the `#switcher-ready` notice above the dialog on success. Without the worktree family, mocked data keeps the labelled simulation. Alternative: a Creating row inside hub-nav's list; rejected because that list is the Hub's authoritative inventory, and a pending row there would fight `reconcileMenuEntries`.

**D7. + New belongs to the current repository.** The Checkouts heading's **+ New** opens today's worktree menu for the current repository's main checkout (without "From a pull request…"). Other repositories' fork controls remain on the Hub dashboard. Its accessible name is `New worktree in <repository>`.

**D8. The strip is two small elements.** `#viewing-strip-files` sits in the sidebar under the brand (touch only); `#viewing-strip-preview` sits above the preview header (touch, and desktop while the sidebar is collapsed). Both hide on touch screens 500px tall or less. The desktop chip's second line is part of `#hub-control`, which is also shown outside a Hub when GitHub data is served.

## Risks / Trade-offs

- [e2e suites that drove the old dropdown, its group headers, Sign out and the per-repository fork controls break] → Update them to the dialog's rows and **+ New**; keep `#hub-control`, `#hub-toggle`, `#hub-menu`, `.hub-menu-item[data-workspace-id]` and `.hub-menu-state` as hooks so most selectors survive.
- [`aria-activedescendant` support varies on iOS VoiceOver] → Rows remain directly tappable and are named in full; touch users do not need the field focused.
- [A 320px phone may not fit the 1.5-cell button] → The name is cut in the middle; the open question from the design stays open.
- [Losing provenance on rows hides "External worktree"] → It stays on the dashboard, as the design decides.

## Migration Plan

Client-only; ships with the PR. Rollback is reverting the change. This change is archived after `add-github-pr-review`, whose picker requirements it revises in place.

## Open Questions

- The button's width on a 320px phone (from the design). The implementation cuts the name in the middle; a review on a real 320px device may tune the cell width.
