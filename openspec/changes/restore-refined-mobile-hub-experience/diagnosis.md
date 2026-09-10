# Diagnosis: the reference was narrowed during transfer

## Status and authority

This combines a source-and-artifact audit with a read-only browser inspection,
not an implementation acceptance report. The present change is **the shipping touch frontend built
first against synthetic services, followed by an explicit user review stop**.
It is not another disposable prototype and does not authorize live integration.
Only planning artifacts are being prepared now.

The current user decisions supersede the archived change where they conflict:
match the refined reference's look and feel, keep UatuCode branding, preserve
ordinary workspace → Hub → Settings/details → Return client continuity in one
document without iframes, and leave desktop unchanged. The archived requirement
to keep full-document navigation is historical context, not a constraint to carry
forward. See `reference-contract.md` and `screen-map.md` for the review target.

## Evidence and consequences

| Evidence | What it establishes | Consequence for this change |
| --- | --- | --- |
| `design/hub-mobile/screenshots-refined/01-hub.png`, `08-return-hub.png`, `15-return-in-settings.png`, `22-preview-side-setting.png` | The reference is a cohesive Hub: Running / Ready to Start groups, icon-led rows, large headings, identity card, grouped Settings drill-down, material bottom dock and task sheets. | Correcting only workspace tabs or increasing mobile padding cannot reproduce it. |
| `src/hub/pages.ts:415–429` | Shared mobile navigation renders text-only Hub/Settings links and a Return button. | Missing icon-and-label hierarchy and distinct two-line Return segment are structural, not merely color differences. |
| `src/hub/pages.ts:660–698` | Dashboard remains generic Sessions / Workspaces panes; Settings concatenates inline navigation controls, credentials, defaults, and devices. | Reference information architecture was not transferred. Touch needs its own cohesive presentation, while preserving all actual operations through the frontend interface. |
| `src/hub/mobile-presentation.ts:7–60` | Coarse-pointer CSS wraps existing generic `main`, `.pane`, `.row`, forms and dialogs; selected nav remains a horizontal text control. | This adapts the desktop page rather than expressing the exact reference. Reusing these global selectors in a shared document would also risk restyling workspace interiors. |
| `src/preview/file-navigation.css:32` | The Preview pill has a `1px solid #767676` outline. `04-preview-expanded.png` and `19-preview-controls-lowered.png` show a soft white translucent pill, not that dark perimeter. | Small overlay corrections remain necessary, but are not the main Hub problem. Accessibility alternatives must be reviewed explicitly rather than silently replacing the normal-state material. |
| `src/hub/pages.ts:390–403`, `src/shell/hub-nav.ts:222–281`, `src/shell/tab-bar.ts:373` | Hub is emitted as a separate HTML document; workspace Hub navigation points to the origin root and workspace changes use document navigation. | A Return hint can restore a destination, not guarantee that unsent drafts, File objects, scroll containers and ongoing client work stayed alive. The requested ordinary continuity needs a same-document frontend lifetime. |
| `src/app.ts:28–55`, `src/shared/app-url.ts:14–26`, `src/shell/tab-bar.ts:63–64` | Workspace startup queries the document globally; the base path is document-derived and cached; active surface is written on `<html>`. | Merely inserting Hub markup beside the SPA is unsafe. Root-scoped DOM/style/event ownership and explicit workspace URL context are needed. Do not duplicate the workspace singleton or change its request base when showing Hub. |
| Archived `design.md:26–42,148–150` and `specs/hub-dashboard/spec.md:149–159` | The old plan explicitly rejected a resident host and excluded stronger client-retention promises. | The old lifecycle limitation was intentional. It cannot meet the newly stated requirement without revising the frontend architecture. This is not evidence of a backend process-lifetime defect. |
| Archived `design-gap/README.md:9–14` | Its before/after matrix covers selector row, preference sheet, Preview pill, and error card. | That repair did not audit the full Hub dashboard, Settings hierarchy, or login/onboarding parity. “Aligned” there is limited to those controls. |
| Archived `8.3-diagnosis/README.md:19–59` | Old mobile assertions expected a full-bleed bar, permanent visibility and reserved gutter; the note asks reviewers to distinguish intentional change from content obstruction. | Neither old failing geometry assertions nor passing replacement assertions establish exact reference fidelity or unobscured content. |
| `design/hub-mobile/README.md:3–23`, `refined-results.json:1–5,89–91` | 49 retained images (including two interior crops) and 82 historical WebKit checkpoints concern a removed prototype using old main and fictional services. | These are design evidence, not current product golden snapshots or proof of shipping continuity. The README/gallery links to the former active change path are stale; read the archive. |
| Read-only Chromium inspection of the existing isolated Hub at 390x844 CSS pixels, touch enabled and DPR 2 | Hub and Settings dock destinations each contained zero icons; the first Settings section was Navigation on this device. The inspection failed the reference-icon assertion although there was no viewport overflow. | A functional, non-overflowing UI is not sufficient reference fidelity. This is a narrow observed mismatch, not a completed visual comparison suite. |

## Scope correction

1. Implement the actual intended frontend/interface, not a mock-only second UI.
   Test-owned adapters and fixtures under `tests/` drive it; no demo credentials,
   branch names, fake terminal output, failure selectors or mock service modules
   belong in `src/`. Never fall through to production services during review.
2. Review the full touch Hub hierarchy and all unpictured workflows, not only
   the pictured workspace overlays. Existing desktop pages and workspace
   interiors remain the non-redesign baseline.
3. Keep the current workspace mounted across ordinary Hub/Settings detours.
   Preserve selected surface, each relevant scroll position, unsent Chat text,
   pending File attachments and ongoing client-owned work; restoring a string
   from storage or drawing a screenshot is not equivalent. Hidden workspace
   interaction must be inert without stopping its work.
4. Display branch metadata as a first-class row fact, with truthful unavailable,
   non-repository, detached and loading cases. Stage-one branch values are
   explicitly simulated. Real metadata acquisition is deferred; do not run Git
   merely to make the frontend review look convincing.
5. Stop after the user can exercise the real frontend with synthetic services.
   No production workspace start/stop, filesystem onboarding, clone, credential,
   device-session or Git operations are included in this phase. Tests and images
   inform approval; they cannot grant it.

## Remaining decisions to expose, not silently settle

- Ordinary A → Hub → Settings → A continuity is required. Resource retention
  across opening B, reload, browser termination, authentication loss, explicit
  Stop or removal is not an unlimited resident-workspace guarantee. Review the
  exceptional states and hand off lifecycle questions before live integration.
- Existing sensitive-operation semantics remain the source for mock outcomes:
  stopping shells, assignment replacement, secret clearing, registration versus
  filesystem deletion, and clone partial results must not acquire new policy
  through visual simplification.
- Scope isolation spans more than CSS: URL/base handling, document history,
  keyboard/find listeners, focus, viewport measurements, theme and singleton
  ownership need a concrete implementation audit. This planning audit identifies
  evidence, not a claim that every dependency has already been inventoried.
- Exact material/geometry is judged against the images at matched viewports.
  Gallery CSS styles the gallery, not the photographed application; its numeric
  values must not be presented as recovered frontend tokens.

## Evidence limits

The primary audit used existing screenshots and a read-only browser inspection
against the already-running isolated Hub. It did not start or alter services,
probe Git, perform credential operations, install dependencies, or rerun the
historical suites. No “all checkpoints passed” or user sign-off is implied. The
review matrix in `screen-map.md` is prospective.
