## Context

PR #117 introduced repository-derived file facts in shared preview chrome, but `applyDocumentPayload` deliberately synchronizes that strip only for Source payloads. Rendered payloads already carry the same `fileFacts`; they hide the strip and use a transient `Updated` chip for live reloads. This means the default view does not expose the commit/date information requested by issue #115 even though the server and client cache already have it.

The facts strip and update signal are intentionally coupled in `src/preview/file-facts-strip.ts`: a visible strip receives the freshness highlight, while a strip-less view falls back to the header chip. Split layouts also use the same shared preview chrome, so this change must keep one strip rather than duplicating it inside both panes.

## Goals / Non-Goals

**Goals:**

- Make repository and filesystem facts visible in Rendered, Source, and Diff views.
- Preserve a compact reading posture by keeping the one-line strip in preview chrome and the collapsible frontmatter card in the rendered body.
- Reuse the strip freshness highlight as the Rendered-view live-update signal, retaining the header chip only as a no-facts fallback.
- Keep single and split layouts behaviorally consistent and covered by unit and E2E tests.

**Non-Goals:**

- Changing the facts collected by the server or the `/api/document` and `/api/document/diff` payloads.
- Merging git facts into author-declared frontmatter metadata.
- Adding file-history navigation, commit links, or a full commit-detail view.
- Changing follow-mode reload rules, signal timing, or reduced-motion behavior.

## Decisions

### 1. Use one document-facts strip variant for Rendered and Source

The existing Source strip content already answers the cross-view question: author, freshness, short SHA, line count, and size. The client SHALL use this same content for both Rendered and Source payloads, with Diff retaining its compare-specific variant. The state name should describe a document-facts presentation rather than a source-only presentation so future call sites cannot accidentally reintroduce view gating.

Alternative considered: define a smaller Rendered-only variant. This would make the answer to "when and which commit" depend on view and add formatting/test branches without a distinct user need.

### 2. Keep facts in shared preview chrome

The strip SHALL remain in the existing `#file-facts-strip` slot below the preview title row. The frontmatter metadata card remains inside the Rendered document body because it describes author-declared document metadata, while the strip describes filesystem and repository state. In split layouts the shared slot naturally produces exactly one strip for the document.

Alternative considered: add git rows to the metadata card. That card can be absent when a document has no frontmatter, is collapsible by user preference, and represents different provenance; using it would make repository facts less reliable and blur semantics.

### 3. Let strip visibility select the update presentation

No new signal mechanism is needed. Once Rendered view synchronizes non-empty facts into the strip, the existing `stripVisible` logic routes live-update state to `.file-facts-freshness` and keeps `#preview-updated` hidden. If fact collection returns no renderable facts, the strip remains hidden and the existing chip is retained as a resilient fallback.

Alternative considered: keep the `Updated` chip alongside a Rendered facts strip. Two simultaneous indicators would duplicate one event and create unnecessary visual noise.

### 4. Change only client-side view synchronization

Every rendered document payload already contains `fileFacts`, recomputed on live reload, so implementation should be limited to the file-facts state model, `applyDocumentPayload`, comments, and tests. The server collector and payload contracts remain unchanged.

## Risks / Trade-offs

- [An always-visible strip consumes another line in the default reading view] -> Keep the current compact chrome treatment and avoid duplicating facts in the document body.
- [Frontmatter author/date may differ from git author/date] -> Keep the surfaces visually and structurally separate so their distinct provenance remains clear.
- [A view or layout switch during an active signal could route the indicator incorrectly] -> Continue deriving presentation from actual strip visibility on every synchronization and cover Rendered/Source/split transitions in tests.
- [No facts are available after a stat failure] -> Preserve the existing header chip fallback so a live reload still has a visible acknowledgment.

## Migration Plan

This is a client-only additive presentation change with no persisted-data or API migration. Deploy with the normal application release; rollback consists of restoring Rendered view's hidden strip gating, while the existing header chip remains available throughout.

## Open Questions

- None blocking.
