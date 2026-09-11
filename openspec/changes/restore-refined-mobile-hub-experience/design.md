## Context

See `proposal.md` for motivation and `diagnosis.md` for evidence. The previous change produced working surface navigation but did not implement the refined Hub composition. Its real-Hub screenshots were documentary captures, not visual assertions. The user now requires reference fidelity, frame-free workspace continuity, and frontend approval against a mocked backend before live integration.

The repository has two document-global frontend implementations. `src/hub/pages.ts` emits Hub documents with a large inline controller. `src/app.ts` queries workspace elements at module initialization and wires singleton owners; `src/shell/state.ts` owns workspace state. Hub links currently perform document navigation. Chat retains pending File objects and asynchronous uploads that cannot be recreated from persisted text; non-BFCache pagehide disposes its work. These facts make a same-document module extraction necessary, rather than another stylesheet override or saved-state approximation.

This design is required because the change crosses presentation, navigation, interaction ownership, and client lifetime seams. It describes the frontend-first stage, not a completed live integration.

## Goals / Non-Goals

**Goals**

- Give the approved UI one reusable implementation and a backend interface that can be driven synthetically now and connected to real operations later.
- Reproduce whole-screen composition and complete interaction flows, with named review states and explicit exceptions rather than loosely inspired styling.
- Preserve exactly one workspace instance on ordinary Hub/Settings detours without embedding frames or duplicating state owners.
- Keep server effects outside the frontend review environment and make unexpected mock gaps fail visibly.

**Non-Goals**

- No real branch probes, credential tools, clone jobs, filesystem onboarding mutations, live authentication/session mutations, or provider/PTY processes in this stage.
- No replacement of current production desktop pages, standalone behavior, or workspace interiors. No native Desktop implementation changes.
- No multiple resident workspaces, new workspace singleton, iframe, restore-from-screenshot UI, or alternate mock-only frontend.
- No promise that pending browser work survives an OS process eviction or explicit reload. Ordinary view navigation must not cause those losses itself.
- No automatic promotion of frontend approval into backend or release approval. Do not archive/sync these production-facing deltas merely because the mock review is ready.

## Decisions

### D1. Separate frontend ownership from backend execution

Place reusable Hub frontend modules under the existing `src/hub/` feature, preferably a cohesive `mobile/` area rather than further growing the inline `pages.ts` controller. Provide a scoped root and an explicit backend interface. Its responsibilities are authenticated view data, typed operation intents/results, progress streams, and invalidation—not arbitrary HTML or a generic untyped action dispatcher.

Reuse existing domain types where they express the real contract. Readiness, assignment, clone result, registration, and running state must not collapse into a single Boolean to simplify the mock. Branch metadata is an explicit discriminated frontend value (named, detached, unborn, non-Git, loading, unavailable), not a guessed `main`. Its eventual wire format is deferred rather than silently added to the published API in this stage.

Frontend behavior owns form drafts, validation, focus, sheet transitions, pending state, contextual errors, and intent sequencing. The backend adapter owns effects and transport. Backend failures cannot tell the UI to replace itself with unrelated markup. Do not copy fake prototype services or credentials into `src/`.

**Approved implementation refinement (2026-09-09):** Extend this frontend-only
seam with explicit credential protection/lock facts, available OpenPGP user-ID
facts, and saved tool override separately from detected/effective path. Reuse
existing public/domain DTOs, but do not infer these additional facts from
readiness prose, names or key text. Unknown/not-applicable states remain explicit.
Populate and test the facts synthetically; live acquisition and public API
changes remain deferred.

Clone submission also receives an explicit non-secret attempt identity and an
authoritative reconciliation operation. A lost response must not force a choice
between blind resubmission and guessing from dashboard registration. Bind the
attempt to its authenticated owner; preserve only a scoped non-secret recovery
hint across reload. Distinguish accepted job, authoritatively not accepted,
pending/unknown, and expired/unavailable lookup. Only authoritative nonacceptance
permits a new explicitly authorized submission; uncertainty cannot become safe
retry merely through Back, Discard, reload or missing workspace registration.
The synthetic implementation exercises these outcomes without asserting that a
live adapter already provides idempotency or recovery guarantees.

**Alternative rejected:** a polished static prototype with separate event handlers that would later be translated into the current pages. That repeats the fidelity-loss path. A view that works only against fixture shape rather than the real operation model is also unacceptable.

### D2. One same-document coordinator and one retained workspace

Introduce a narrow mobile navigation seam that owns Hub view selection and dispatch between Hub and workspace history. It does not own document selection, active workspace surface, chat drafts, terminal attachment, or credential state. These remain behind their existing interfaces.

```text
Test-owned backend responses and streams
                 |
                 v
        Production backend interface
                 |
                 v
        Mobile navigation coordinator
          /                     \
         v                       v
Scoped Hub root             Existing workspace root
overview/detail/sheet        Files/Preview/Chat/Terminal
          \                     /
           +-- one document ----+
```

Extract reusable Hub views and scoped handlers; never inject the existing inline document controller into the workspace. The workspace boot path remains single-shot. The review entry assembles the real workspace markup/client and Hub root so their lifecycle is the one intended for later integration. Necessary boot/bootstrap extraction belongs in product modules and must preserve the existing entry behavior by default.

An ordinary Hub/Settings detour changes foreground presentation and interaction, not workspace lifetime. Preserve File objects, promises, stream subscriptions, xterm instance, selected surface and viewport state. A visibility change must not trigger a zero-size resize that destroys terminal geometry or scroll. Choose a root-visibility treatment that preserves required measurements; verify those properties rather than assuming `display:none` is harmless.

**Alternatives rejected:** user explicitly rejected a persistent iframe host. BFCache and local-storage reconstruction cannot guarantee memory-only continuity. Multiple mounted workspace SPAs would conflict with singleton assumptions and are not required.

### D3. Scope style, input, focus, and measurement—not just markup

The new Hub visual rules are scoped to its root. Do not add generic `.row`, `.pane`, `button`, or `main` rules that can affect workspace interiors. Hub event handlers query within their root, with namespaced IDs where associations require them. Extract a small visual vocabulary for grouped sections, icon rows, action capsules, dock materials, and sheets; avoid an unrelated generic design-system rewrite.

Use one explicit foreground-context signal to gate workspace-global shortcuts and pointer/focus handlers through their owning modules. Merely setting a root inert does not prevent document-level key listeners from seeing Hub input. Conversely, retaining workspace background work does not authorize it to focus controls or promote a surface over Settings. Modals take precedence over either root, return focus appropriately, and make underlying navigation inert.

Keep the current per-workspace UI-mode owner and shared navigation-preference owner. Hub presentation remains coarse-pointer scoped; the integrated mobile coordinator is used only in its eligible touch workspace context. Desktop and standalone paths retain their existing defaults and escape routes. Switching modes follows existing surface normalization; it does not silently replace the Hub-wide preferences or introduce a second active-tab store.

### D4. Canonical history with a stable workspace request context

The coordinator recognizes Hub routes (`/`, `/settings`, `/clone`), their validated frontend detail/sheet context, and `/s/<id>/...` workspace locations. Detail views should initially use safe query/history context on existing Hub routes rather than inventing public server endpoints for the review. URLs contain no secrets or raw host path authority.

While a workspace is retained, ordinary Hub and Settings transitions use the History API in the same document. The workspace's request base path is fixed to its original authenticated context and does not follow the top-level displayed Hub path. Continue routing workspace URLs through `appUrl()` and explicit Hub-origin URLs through their existing helper; do not temporarily rewrite the document base to make relative requests work.

Partition `popstate` dispatch before the workspace document-selection owner runs. A Hub URL must not be parsed as a file, while a workspace file/hash/commit query retains its current semantics. Preserve Hub per-view scroll separately from workspace scroll. Direct load/reload uses explicit URL precedence and a fresh boot; it is not a retained-workspace guarantee. The review server must support direct loading the tested canonical routes, not only navigation from its landing page.

The retained target is A during A -> Hub -> Settings -> A, even when a management form concerns B. Opening another workspace is a distinct boundary, not a promise to retain A as a second resident SPA. Use the existing cross-workspace navigation lifetime for that case and identify the boundary in review evidence; do not claim an A/B residency feature. The later live integration must preserve canonical route fallbacks on the real server.

### D5. Reference-fidelity presentation, including complete workflows

`reference-contract.md` is the visual authority and `screen-map.md` is the coverage inventory. Reconstruct the photographed composition, not the CSS of the gallery itself. Keep current UatuCode branding but use the reference's hierarchy, path treatment, folder/branch/ellipsis/navigation silhouettes, grouped Settings, and task-sheet grammar. Existing fonts remain available for current code/terminal surfaces; no proprietary icon/font package or new dependency is assumed.

The mobile dashboard is a dedicated overview composition, not a desktop pane with mobile padding. Settings is an identity and destination overview with focused details/tasks. Existing shell/credential/readiness information remains available through the reviewed subordinate information hierarchy; complete capability parity must not be traded for a photographed happy path. If satisfying an existing information-placement requirement would crowd the reference card, explicitly propose the overview/detail placement and reconcile that requirement instead of hiding the capability.

Bottom-sheet forms need draft/commit/cancel semantics, not only a bottom border radius. Preview-side and other preference edits use current values, an owned draft, Cancel without committing, and an explicit commit action; a backdrop/Escape dismissal follows the same cancellation policy. Existing mutation confirmations, secret clearing, clone authorized-continuation rules, and partial-operation outcomes remain semantically authoritative. Unpictured compositions are review candidates, not pre-approved interaction-policy changes.

The workspace selector retains its existing seven-second interaction-aware policy and local fade; the Hub return transition can slide the workspace aside in the same document. Keep motion brief and interruptible; detailed Hub-transition timing is tuned during visual review rather than claimed as recovered from still images. Reduced Motion removes travel. Hidden views do not reserve a workspace navigation gutter or become competing focus/scroll targets.

### D6. Test-owned, fail-closed backend and review hosting

Create the review server and fixtures under `tests/` (for example `tests/mobile-hub-review/`) and feature E2E coverage under `tests/e2e/`. The launcher bundles the real product entry/modules; it does not import the production CLI or launch a real Hub to execute synthetic actions. Reuse shared HTTP/asset assembly where a production seam already exists rather than adding a competing product route table.

Mock actual backend transports/operations at the interface used by the frontend. Where the existing workspace clients use HTTP, SSE, or WebSocket directly, supply test-owned protocol-compatible responses so those real clients run. Chat attachments can hold a synthetic upload pending and settle it later; terminal output is a protocol double consumed by the real terminal client, never a real shell. Pending/error/retry sequencing runs through production frontend handlers.

No request or transport may fall through to existing localhost Hubs, providers, credential helpers, or real workspace operations. Unknown requests fail and are logged as missing mock contracts. Use independent synthetic auth, stable fixture identities, a private test state location if needed, and no imported personal credentials. Serving source assets and test fixtures is allowed; review operations cannot mutate host workspaces or read arbitrary files. Reject path traversal and do not expose the repository root.

Use a separate review-controller page/route for scenario selection and reset. It visibly states **mock backend; do not enter real credentials**. Keep review controls out of the product viewport and `src/`, while retaining provenance beside screenshots and in the handoff. Do not make a demo-mode product Settings panel. Existing full-feature endpoints must not appear available merely because a generic mock replies 200.

Launch on a free loopback port and expose a free Tailscale HTTPS port after verifying current listeners/configuration. Do not reuse existing 4700/443, test 4701/8443, or reference 4702/8444 without explicit user permission. No tool installation is needed by assumption; ask if a required browser or tool is missing. The review is tailnet-only, not Funnel, and has its own synthetic session so it does not replace live Hub cookies. Return exact stop/restart/reset commands scoped to these review resources.

### D7. Prove visual fidelity and real frontend lifetime separately

First make a representative vertical slice: dashboard -> workspace -> Hub -> Settings -> Preview-side sheet -> Return. Confirm scoped ownership and in-memory continuity before implementing every detail flow; otherwise the same global-DOM conflicts would be repeated across many screens.

Use deterministic fixture clocks, names, branch facts, dimensions and stream sequences. Compare source images at normalized CSS dimensions: reference captures have mixed pixel ratios, and raw PNG size is not a font-size specification. Capture matching regions/states, document current-brand and data substitutions, and inspect overlays/side-by-side comparisons rather than masking away the design. Establish production frontend golden captures only after reviewing their relation to the approved reference; updating goldens is never the fix for an unexplained failure.

Visual tests must detect missing icons, wrong overview hierarchy, sheet anchoring, Return typography and material differences—not just overflow. Behavior tests must assert the same workspace DOM/client sentinel and one boot/transport, exact File/draft ownership, progress while Hub is visible, preserved scroll/surface, valid route dispatch, and no hidden-context key handling. Delayed authentication or workspace-generation responses must not resurrect invalid state. These tests use the mocked backend and do not certify real server enforcement.

Run relevant existing tests for modified frontend owners plus focused Chromium/WebKit mobile coverage where already installed. Exercise light/dark, 320/390 portrait, short landscape, tablet touch, text enlargement, safe areas, keyboard, reduced preferences and desktop non-regression. Full real-backend verification remains a later gate; report what was actually run rather than inheriting historical passes.

### D8. Human approval is a stop, not an implementation checkbox to self-certify

The frontend stage ends with the served URL, named scenarios, reference/actual comparisons, unpictured-state designs, known gaps, and an acceptance record explicitly awaiting the user. The user may request further frontend corrections before integration. Tests cannot mark the user approval complete.

After explicit visual/interaction approval, seek authorization for a separately scoped integration task set covering real Hub HTTP/data adapters, branch probing/public API documentation, deployment/entry routing, credential and clone correctness, authentication/transport invalidation, and full verification. Do not advance into these tasks simply because the user previously said to implement the frontend. Do not sync/archive the production-facing requirements or present them as shipped while the mock-backed frontend is the only active implementation.

## Risks / Trade-offs

### User-requested iOS UX correction (2026-09-10)

The user finds the overall appearance improved but rejects the oversized folder
action cards and repetitive flat readiness lists. Audit every screen/scenario
against Apple's iOS HIG and the Uatu API reference. Preserve the overall refined
visual grammar; the unpictured flow compositions are revised, not accepted as
new goldens. Frequent commands must have one natural home in the lower half of
the screen for one-handed operation. **Do not duplicate a button to improve its
reachability.** Move Back and task-primary controls to a scoped lower toolbar;
keep contextual secondary choices in concise menus and form confirmation in the
existing sheet footer. Account for dock height, text reflow and keyboard/safe area.
Folder entries become compact grouped hierarchy rows. Readiness shows outcomes
and blockers before progressively disclosed diagnostics; preserve every result
without inventing tool provenance absent from the API. Keep all capability,
confirmation, secret-clearing, operation-order and workspace-lifetime semantics.
See `review-evidence/ios-hig-research.md` and the test-owned 27-screen UX audit.

### Settings convention refinement and cold-entry repair (2026-09-10)

The user's subsequent feedback supersedes the blanket lower-half placement
policy above: prioritize conventional iOS Settings navigation and contextual
controls. Only the most frequent workspace/surface/composer commands merit
special lower-screen placement; do not duplicate controls. Settings detail Back
and titles return to the top, settings values and editing stay grouped in
context, and single-option intermediate menus are removed. Ordinary sheet
Save/Cancel remain one clear commit/discard boundary.

Credential presentation must explain what the credential is for and whether its
local setup is usable, not lead with diagnostic counts. Secondary troubleshooting
explains its purpose and the distinction between local checks and remote access.
Preserve supplied diagnostics without inventing tool provenance. Tool-purpose
copy and draft-only automatic discovery make advanced installation controls
understandable. Default Folder distinguishes Hub-wide saved/effective paths and
Hub home, without routine authorization jargon or a destructive-looking reset.

Repair cold workspace entry through existing navigation and coordinator owners:
withhold inert/unmeasured chrome until initialized and ready, show an explicit
loading view with Back to Hub in confirmed Hub contexts, and retain one boot if
the user leaves during loading. Late completion must not steal the foreground.
Confirm known authenticated Hub context before first selector presentation;
preserve standalone behavior, saved surface/placement and canonical initial URL.

### Direct Settings and full-page editors (2026-09-10)

The user subsequently rejected drawers and generic More menus in Settings and
explicitly chose **full-page editors**. This supersedes task-sheet presentation
for the affected Hub management workflows. Applicable commands appear directly
on the relevant Settings page, with state-appropriate Lock/Unlock and type-safe
operations. Compact lists remain; do not recreate a tall action card per folder
or duplicate controls to improve reachability.

One shared task-view owner renders full-page editors/read-only result pages with
header Back/Cancel and Save/Apply. Only explicit consequential confirmations use
small centered dialogs. Editing is not modal drawer navigation: no grabber,
dimmed backdrop or modal keyboard trap. Preserve draft, secret-clearing,
generation, coordinated-stop and pending-command rules through that owner.
Editor/review navigation is an ephemeral workflow in the existing history seam;
history contains no draft or secret. Same-context Back while a command is pending
must not reopen a resubmittable pre-submit editor or lose the command's result.

Remove embedded Troubleshooting/diagnostic panels from ordinary credential and
tool settings. An explicit setup check opens concise Check Results; a specifically
named report view there retains every original result. Report Back returns to
the existing result without running checks again. Long public identifiers/user
IDs receive full-width value treatment rather than a narrow trailing column.

### Information hierarchy, explicit interaction and Boolean switches

After checkpoint `c259efb` was committed and pushed at the user's request, the
next refinement distinguishes read-only facts, editable fields, action rows and
important notices. Purpose, workspace and review data use labeled semantic facts;
review shows Current / After applying and prospective changes rather than prose
or already-completed-looking states. Normalize hosts at explicit Review to meet
the existing API contract while preserving raw drafts on Back and keeping other
hosts/omitted roles unchanged.

Boolean inputs use accessible green switches in rows, retaining draft semantics;
mutually exclusive choices remain selection controls. Opening an editor focuses
its heading, never automatically opens a picker/keyboard or emits changes. Saved
values remain accurate. Ordinary actions no longer inherit filled primary-button
styling that resembles a selection. The security notice is prominent before
credential controls, with its existing per-user dismissal policy; Devices has
one canonical navigation entry, without filtering genuine API device records.

### Shared Uatu Web design system

The user approved consolidating the mobile Hub's existing patterns into a small
Apple-inspired Web design system. `design-system.ts` owns stateless semantic
primitives, `tokens.css` owns a compact semantic theme, and `styles.css` owns one
authoritative recipe per pattern. Actual overview/flow callers use these shared
implementations; compatibility exports do not duplicate renderers. Lifecycle,
validation, effects, history and measured geometry remain with existing owners.

Document the interface and usage in `design/hub-mobile/design-system.md`, and
serve a separately bundled test-owned reference at `/review/design-system` using
the actual modules. Reference examples are local-only, outside product Settings
and shipping bundles. This is not a new framework, native UIKit/SF Symbols port,
desktop/workspace-interior redesign, or authorization for live backend rollout.

### Focused remote-folder selection

Following the user's folder-selector feedback, separate choosing a destination
from managing folders. Use the shared full-page task owner for a read-only Hub
folder picker: Cancel/current location/Choose header, a scrolling directory list,
parent navigation and explicit loading/empty/error recovery. The header stays
visible; Choose returns a backend-verified path once, not a stale request or an
implicit click on a folder row. Caller drafts and cancellation context survive.

Default Folder, Create Workspace parent and Existing Folder registration use the
focused selector. Folder maintenance remains available through the explicit
Manage folders destination in Add Workspace, including retained-path recovery;
no operations are deleted or hidden in More. Native iPhone filesystem pickers
would target the wrong filesystem. No search, favorites, permission flags or
new public API is invented. Add the actual picker to the shared reference catalog.

### Preview examples and recognizable Hub controls (2026-09-11)

After checkpoint `b7d51f7`, the user approved richer synthetic preview content and
an Apple-guided mobile Hub refinement. Add linked Markdown/AsciiDoc examples with
nested folders, tables, source blocks, diagrams and local images through the
test-owned corpus and actual renderers. Do not modify real workspace files.

Commands such as Configure new workspace must look like buttons: one coherent
primary/secondary/destructive hierarchy, accent-filled primary actions, visible
secondary surfaces, pressed/disabled/focus states and adequate targets. Preserve
conventional navigation and disclosure rows; do not turn every command primary.
Use the existing shared design system across Hub, Settings and onboarding.

Verified empty collections use an icon/title/explanation composition, distinct
from loading/error. The directory-only picker says No subfolders and explains
that files are hidden and Choose selects the current folder. It cannot claim
that the folder has no files; no duplicate Choose or management actions are added.

The user clarified and approved the unchanged boundary: Files/Preview/Chat/Terminal
interior layouts, controls, workspace navigation chrome, and Hub↔workspace
transition/retention behavior remain as before. Only synthetic content expands
inside the workspace. Native UIKit guidance is adapted to the Web, not imported
as a new framework or claimed as native Apple certification.

### Creation exit, Security hierarchy and preview freshness (2026-09-11)

At the user's request, commit/push the current refinement before these corrections
(`b5d5f30`). Canceling the whole creation flow returns directly to Add Workspace;
remove the redundant Configure new workspace landing page. Loading cancellation
must reject late responses, while nested picker Cancel and review Back keep the
creation draft and its correct history entry.

Session Security now owns the one Devices navigation entry and its truthful count.
Keep direct safe device routes, contextual Back to Session Security, and existing
revoke/sign-out confirmations. This supersedes the previous overview placement.

The reported preview error is a synthetic freshness-contract defect: repeated
HTTP/SSE `generatedAt` values are rejected after channel replacement. Keep the
production reconciler and file pill unchanged; emit monotonic snapshots without
changing file mtimes or resetting the freshness watermark. Verify same-directory
Previous/Next across Markdown, AsciiDoc, source/text, image and binary entries,
including first/last boundaries and failure/Retry recovery. Do not filter by
format, bypass index readiness, hide errors or cross the parent-directory boundary.
This functional repair does not authorize a workspace-interior redesign.

Browser verification also found an existing product boot restriction that rejected
explicit indexed binary URLs. Remove only that exclusion: the existing document
loader already owns image rendering and unsupported-file fallback. Keep unknown
paths, saved/default selection and follow behavior unchanged. Synthetic image
resources use the production Accept-negotiation helper for HTML navigation versus
embedded bytes, reject query/encoded variants, and remain explicitly allowlisted.

- **Large Hub module extraction** -> move by reviewed vertical slice, keep existing desktop rendering active, reuse domain semantics, and require local ownership rather than copying the global inline controller.
- **Global workspace assumptions survive hiding** -> test input isolation, cached request base, URL dispatch, visibility/resize callbacks and scroll preservation on all four real surfaces before broad UI work.
- **Mock conceals an integration mismatch** -> use existing types/protocols, fail unhandled calls, retain operation logs and explicit future contract gaps; no claim of live backend correctness.
- **Visual review repeats the old failure** -> named reference anchors, whole-flow comparison, explicit deviations and human sign-off; never accept screenshot capture alone as fidelity.
- **Exact photographed geometry conflicts with accessibility or real information** -> use the documented alternate states and review overview/detail extensions; preserve information and targets rather than clipping or inventing values.
- **Background browser suspension** -> preserve the live realm during ordinary navigation and existing reconnect behavior; do not promise indefinite execution or retained File objects after process eviction.
- **Security-sensitive UI remains visually reachable after invalidation** -> foreground coordinator and operation generations block stale responses, clear protected in-memory view state, and exercise synthetic revoke/401/Stop scenarios; real enforcement remains a live integration gate.

## Migration Plan

1. Record current reference and production/frontend baselines without overwriting archived evidence or existing dirty work.
2. Add the reusable frontend and test-only entry/adapter, with existing production entry behavior unchanged by default.
3. Serve the isolated review build and iterate against the reference until the user explicitly approves its visual and interaction design.
4. Stop. Prepare live integration work only after that approval and authorization; publish any added wire contracts there.
5. During review, rollback means stopping only the test launcher/Serve endpoint or removing the new scoped modules. No existing Hub state, credentials, registries, workspace files, or production deployment must be reset.
