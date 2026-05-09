## Context

`document-watch-browser` is the original capability that grew alongside the product. It now bundles every behavior the local browser UI exhibits — from CLI startup to mermaid theming to file-tree icons. Concretely: 46 requirements, 1420 lines, ~9 distinct concerns. Recent changes have started carving sibling capabilities out of it ad hoc (`change-review-load`, `selection-inspector`, `embedded-terminal`, `pwa-install`, `document-source-view`, `brand-logo`), but the core has never been split. As a result, every new sidebar tweak or rendering nuance still lands inside `document-watch-browser`, and the spec drifts further from the actual code module structure.

This change is the spec half of a larger effort. Phase 2 will introduce `src/{client,server,shared}/` tier folders aligned to these capability names; Phase 3 will add light/dark theme support. Doing the spec split first means Phase 2's code reviewer can ask "which capability does this folder serve?" and get a clean answer.

## Goals / Non-Goals

**Goals:**
- Move all 46 requirements verbatim into seven new capabilities, preserving every requirement name and scenario byte-for-byte.
- Retire `document-watch-browser` as an empty capability folder so future changes cannot keep growing it.
- Land a carve that maps cleanly onto the planned Phase 2 code folders, so capability names and folder names are interchangeable in conversation.
- Keep the diff reviewable: a reviewer should be able to confirm "no requirement was lost or altered" by counting requirement headers before and after.

**Non-Goals:**
- Changing any requirement text. If a requirement reads awkwardly post-split, that's a follow-up change.
- Code restructure, file moves, or import changes. Phase 2.
- Light/dark theme support or a `theme-and-appearance` capability. Phase 3.
- Splitting `repository-workflows`, even though it is also a grab-bag. Out of scope for this change.
- Merging requirements across capabilities or de-duplicating with `change-review-load`. The carve places overlapping rendering requirements in `sidebar-shell` for now; a follow-up change can decide whether `change-review-load` should absorb them.

## Decisions

### Decision 1: Seven capabilities, not three or twelve

**Choice:** Seven new capabilities — `watch-cli-startup`, `document-watch-index`, `document-rendering`, `mermaid-rendering`, `document-metadata-card`, `document-routing`, `document-tree`, `sidebar-shell`.

**Alternatives considered:**
- *Three capabilities (`server`, `client`, `shared`).* Too coarse — would just rename the giant. Defeats the purpose.
- *Twelve capabilities, one per UI sub-feature.* Too granular — `document-metadata-card` already feels small at 1 requirement; pushing further (e.g., separating `mermaid-render` from `mermaid-viewer`) creates capabilities with one or two scenarios each.
- *Merge markdown and asciidoc into one `document-rendering` capability.* Chosen — they share most concerns (highlighting, line numbers, copy buttons, the preview header). AsciiDoc has only one explicit requirement; isolating it would create a capability that exists only to anchor a single requirement.

**Rationale:** Seven is the granularity at which each capability has at least 4 requirements (except `document-metadata-card`, which is intentionally small but has a coherent name and a defensible future). It maps 1:1 onto the planned Phase 2 folder structure.

### Decision 2: Verbatim moves only

**Choice:** Each moved requirement is copied byte-for-byte from `document-watch-browser/spec.md` into its new capability. No edits, no re-wording, no scenario consolidation.

**Alternatives considered:**
- *Tighten requirement wording during the move.* Rejected — couples two concerns (carve + edit), bloats the diff, makes "did we lose anything?" reviewers do real work instead of header counting.

**Rationale:** The split should be mechanically verifiable. Editing later is a separate, smaller change.

### Decision 3: Retire `document-watch-browser` rather than leave it empty

**Choice:** All 46 requirements are listed under `## REMOVED Requirements` in the delta spec for `document-watch-browser`. Each removal includes a `**Migration:**` line pointing at the new capability that received the requirement. After archive, the `document-watch-browser/` folder is gone.

**Alternatives considered:**
- *Leave the capability as a thin parent / index.* Rejected — OpenSpec capabilities are flat, there is no parent/child relationship, and an empty capability invites future drift.
- *Rename `document-watch-browser` to one of the new names rather than retire it.* Rejected — no single new capability is the natural inheritor (CLI? watch index? rendering? all roughly equal).

**Rationale:** A clean retirement makes the carve unambiguous. A future contributor searching for "where do I put a new sidebar requirement" will not find a tempting empty bucket.

### Decision 4: Overlap with `change-review-load` is resolved by responsibility, not merge

**Choice:** `change-review-load` keeps the *compute* requirements (review burden scoring, configuration, levels, bounded commit log data). `sidebar-shell` takes the *render* of those panes. `document-routing` takes the URL navigation for commit previews.

**Alternatives considered:**
- *Move review-rendering requirements into `change-review-load`.* Rejected — `change-review-load` is a backend/compute capability today; pulling UI render concerns into it would make it a grab-bag again.
- *Create a fourth capability `change-review-ui`.* Rejected — too granular; the rendering is just two panes, the same panes the `sidebar-shell` already owns.

**Rationale:** Responsibility split is sharper than data split. Compute lives with the data source; render lives with the surface.

## Risks / Trade-offs

- **[Risk] Reviewers can't easily verify "nothing was lost".** → **Mitigation:** the proposal lists per-capability requirement counts (2 + 7 + 9 + 4 + 1 + 6 + 5 + 12 = 46), and the delta spec for `document-watch-browser` lists all 46 requirement names under `## REMOVED Requirements`. Pre/post-counts must match; `openspec validate` enforces the rest.
- **[Risk] An archived change references `document-watch-browser` and looks wrong after the split.** → **Mitigation:** archives are frozen; OpenSpec does not retroactively rewrite them. Acceptable cost.
- **[Risk] The carve picks the "wrong" capability for a borderline requirement.** → **Mitigation:** the seven-capability carve is documented in the proposal with rationale; future changes can move a requirement between capabilities via the standard ADDED + REMOVED delta pattern. Borderline cases ("Show a stale-content hint in Review" — rendering or sidebar?) are decided once and noted; "wrong" is recoverable.
- **[Risk] Phase 2 finds the carve doesn't match the code well.** → **Mitigation:** Phase 2 can adjust before merging. The names are not load-bearing across releases — only the requirements are.
- **[Trade-off] Bigger spec diff, no behavior change.** A 46-requirement move is a large diff that ships nothing user-visible. The payoff is structural and lands in Phase 2.

## Migration Plan

1. Land this change. `openspec validate` ensures the deltas apply cleanly.
2. Archive the change. `document-watch-browser/` is removed; seven new capability folders exist.
3. Phase 2 is proposed as a separate change that introduces `src/{client,server,shared}/` and decomposes `app.ts` and `server.ts`. Phase 2 may, but need not, adjust capability names if the code reveals a better carve.

**Rollback:** revert the change PR. Because the change is spec-only, no code or data is affected.

## Requirement Migration Map

Each of the 46 requirements moves to exactly one new capability. This table captures the mapping at the per-requirement level so future contributors can find where a behavior went after the source folder is deleted.

| # | Requirement | New capability |
|---|---|---|
| 1 | Start a local document watch session | `watch-cli-startup` |
| 2 | Configure startup browser behavior | `watch-cli-startup` |
| 3 | Browse supported documents from watched roots | `document-watch-index` |
| 4 | Render GitHub-style Markdown in light mode | `document-rendering` |
| 5 | Render Mermaid diagrams from fenced code blocks | `mermaid-rendering` |
| 6 | Inspect Mermaid diagrams in a fullscreen viewer | `mermaid-rendering` |
| 7 | Apply the active UI theme to Mermaid diagrams | `mermaid-rendering` |
| 8 | Tolerate invalid Mermaid diagrams without aborting the preview | `mermaid-rendering` |
| 9 | Keep the indexed view and preview current | `document-watch-index` |
| 10 | Follow the latest changed non-binary file | `document-watch-index` |
| 11 | Serve adjacent files from watched roots as static content | `document-watch-index` |
| 12 | Organize sidebar content into resizable panes | `sidebar-shell` |
| 13 | Resize expanded sidebar width | `sidebar-shell` |
| 14 | Render review-load summary in the Change Overview pane | `sidebar-shell` |
| 15 | Render bounded commit history in the Git Log pane | `sidebar-shell` |
| 16 | Navigate Git Log commit previews by URL | `document-routing` |
| 17 | Display build identifier in the browser UI | `sidebar-shell` |
| 18 | Show a file-type icon next to each document in the tree | `document-tree` |
| 19 | Preserve manual directory open/closed state in the document tree | `document-tree` |
| 20 | Collapse and expand the sidebar | `sidebar-shell` |
| 21 | Animate the live connection indicator | `sidebar-shell` |
| 22 | Scroll the sidebar independently of the preview | `sidebar-shell` |
| 23 | Keep the preview header visible while scrolling | `document-rendering` |
| 24 | Apply GitHub-style syntax highlighting to fenced code blocks | `document-rendering` |
| 25 | Filter the indexed file set with `.uatuignore` | `document-watch-index` |
| 26 | Respect `.gitignore` by default with an opt-out flag | `document-watch-index` |
| 27 | Detect binary files and list them as non-viewable | `document-watch-index` |
| 28 | Render non-Markdown text files as syntax-highlighted code | `document-rendering` |
| 29 | Show last-modified time on each tree row | `document-tree` |
| 30 | Display sidebar file count breakdown | `document-tree` |
| 31 | Show the active file's type in the preview header | `document-rendering` |
| 32 | Show line numbers on non-Markdown code views | `document-rendering` |
| 33 | Provide a copy-to-clipboard control on every code block | `document-rendering` |
| 34 | Render AsciiDoc in light mode | `document-rendering` |
| 35 | Surface document metadata above the body | `document-metadata-card` |
| 36 | Navigate cross-document anchor clicks inside the preview | `document-routing` |
| 37 | Reflect the active document in the URL | `document-routing` |
| 38 | Open a document by direct URL | `document-routing` |
| 39 | Force follow mode off when arriving via a direct document URL | `document-routing` |
| 40 | Navigate document history with the browser back and forward buttons | `document-routing` |
| 41 | Provide a top-level Author/Review Mode control | `sidebar-shell` |
| 42 | Show a stale-content hint in Review when the active file changes on disk | `document-rendering` |
| 43 | Compose sidebar panes per Mode with independent persistence | `sidebar-shell` |
| 44 | Provide an All/Changed view toggle in the Files pane | `sidebar-shell` |
| 45 | Render directory rows in the file tree with a folder icon | `document-tree` |
| 46 | Make the active Mode visually unambiguous | `sidebar-shell` |

## Decommissioning Note

OpenSpec has no built-in "retire entire capability" delta type — REMOVED targets individual requirements, and a spec with zero requirements fails validation. The decommissioning of `document-watch-browser` therefore happens out-of-band: after archive applies the seven ADDED deltas, we manually delete `openspec/specs/document-watch-browser/`. This is documented here so the empty-folder cleanup is part of the same review/PR as the spec carve.

## Open Questions

- Should `document-metadata-card` (1 requirement) be folded into `document-rendering`? It's coherent enough to stand alone and may grow when more metadata sources are added (today: YAML/TOML frontmatter and AsciiDoc attributes), but a reviewer could reasonably ask. Default: keep separate; revisit if it doesn't grow within a few changes.
- Does `sidebar-shell` need a clearer name? It owns Mode (Author/Review), pane layout, the connection indicator, the build identifier, and the rendering of two specific panes. Alternatives: `sidebar-layout`, `app-shell`, `browser-ui-chrome`. Default: `sidebar-shell` because the sidebar is the only thing it covers.
