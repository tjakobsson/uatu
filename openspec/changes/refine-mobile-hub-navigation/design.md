## Context

See `proposal.md` for motivation and the delta specs for observable acceptance.

This branch was created from `main`; after fetching origin during planning, local `main` and `origin/main` both pointed to `b697458f08b1cc1208836cd2db99a3d6f58b4216`. Recheck the baseline before implementation. `design/hub-mobile/` retains only the final static gallery, screenshots, README, and historical verification report. The executable prototype, its dependencies, generated fixtures, and earlier iterations have been removed; none is product code.

The user approved the refined B visual direction and its subsequent UX corrections, then explicitly limited transfer to UX/design rather than mock implementation. The key production facts are:

- Hub pages are separate server-served documents; `src/shell/hub-nav.ts` navigates to `/` and `/s/<id>/...` using the existing browser navigation path.
- Files, Preview, Chat, and Terminal are surfaces in one workspace SPA. Their instances and in-page state are preserved by their existing owners.
- Workspace child processes and PTYs are server-owned. Leaving a page detaches the browser transport; it does not itself terminate a shell. Re-entry uses existing persistence, inventory, reconstruction, and explicit attachment/takeover rules.
- `appState` has one owner per field, enforced by `src/shell/state-ownership.test.ts`. Its owner mutators, not DOM content or duplicated state, determine selection, scope, modes, and persistence.
- The HTTP/API reference is `api/openapi.yaml`, with streaming lifecycle in `api/streaming.yaml` and endpoint inventory in `api/operations.yaml`.
- Existing workspace presentation is base-path scoped. The newly approved handle/auto-hide/Preview-side preferences are intentionally a narrow Hub-origin, device-local exception.
- The prototype uses an iframe, fake services, synthetic search-result clicks, and a shared fixture. None of those establish production lifecycle guarantees or belongs in the implementation.

## Goals / Non-Goals

**Goals**

- Integrate the approved mobile presentation into the existing owners and route boundaries, with an auditable parity matrix rather than a reduced mobile feature set.
- Add the selector, Return intent, and sibling-file controls without changing server session semantics or workspace interiors beyond reclaiming navigation space and adding the requested overlays.
- Make loading, identity, drafts, errors, timing, attention, and accessibility states explicit and testable.
- Use browser-based acceptance, including Chromium and WebKit, alongside the repository's full required checks.

**Non-Goals**

- No persistent hidden-workspace host, iframe embedding, multiple resident SPAs, or new application router replacing current full-page Hub/workspace navigation.
- No promise of a live socket, unsent draft, or in-flight client upload surviving full document navigation beyond the current implementation's behavior. Preserve existing restoration and accepted server-side work; broader cross-page retention is a separate change.
- No redesign of the file tree, Preview header/body/view modes, Chat, Terminal, desktop layout, native macOS client, or provider interfaces.
- No new public endpoint, wire schema, API revision, dependency, font, manual version bump, or production import of prototype code, assets, fixtures, styles, or preference keys.
- No physical iPhone, Simulator, Appium, or device-farm acceptance gate for this iteration.

## Decisions

### D1. Preserve document and server lifetimes

Keep canonical Hub pages and workspace documents. A Hub action remains navigation, not Stop. Surface selection remains an in-page operation. Browser history identifies a workspace through its stable session URL and validated state, independently of the object selected in a management form.

For navigation-context restoration, retain safe client history/scroll hints using the existing page lifecycle and `pageshow`/Back/Forward handling. A cached stopped or removed workspace must go through the existing unavailable/recovery presentation, not be silently started or replaced. Revalidate live state after BFCache restoration and clear stale opening overlays.

**Alternative rejected:** retaining the prototype iframe or creating an equivalent resident-workspace shell. Either would change the architecture, authentication boundary, and resource lifecycle merely to reproduce a test harness convenience.

### D2. Use the existing presentation boundary

Workspace changes follow the existing `ui-mode` resolver and its stored per-base-path overrides. Touch mode receives the overlay selector at phone and tablet widths; desktop mode keeps its present chrome. Existing coarse-pointer keybars and size steppers remain available even in desktop mode.

Hub pages gain touch presentation for coarse-pointer browsers, with responsive wrapping for narrow/landscape and enlarged-text cases. Fine-pointer Hub pages and native Desktop preserve their current layout and titlebar inset. Do not silently reinterpret a workspace-local mode preference as a Hub-wide setting.

Refine the current Hub page rendering and shared helpers rather than replacing the delivery mechanism. Extract only genuinely shared client/style pieces needed to avoid duplicated form behavior. Continue using the route table and fetch-fallback conventions already used by production and test harnesses.

**Alternative rejected:** width alone as the global mobile-mode switch, which would contradict the existing tablet/desktop-override contract and risk stranding coarse-pointer desktop users.

### D3. Return is a small, validated client navigation hint

Record the stable workspace id only after a confirmed Hub workspace successfully opens. Keep the hint in the browser's session context for that Hub, not as the current management selection and not as server-side personal workspace state. Resolve its display label and current state from authenticated Hub data.

Use a production-specific session-storage namespace, separate from device preferences. Session storage is not proof of a unique physical tab: browsers can copy it for opener-created or duplicated tabs. The user chose the simplest implementation policy during planning: allow a copied genuine visit hint as inherited browsing context, subject to fresh validation. Do not add window-name protocols, tab election, or server-side provenance infrastructure. An independently opened context without a hint has only Hub and Settings; if a browser does not copy context, do not manufacture it. Ordinary reload/Back can retain and revalidate a hint.

Validate against the current authentication session; the existing current-device session handle from `GET /api/hub/sessions` can bind the hint without exposing or persisting an auth token. Clear/invalidate on logout, unauthorized responses, session-handle change, missing registration, or invalid data. Copied records are not exempt. The hint is a convenience, never an authorization mechanism.

Run validation as best-effort background work, separate from workspace boot and surface/selector readiness. Reuse a sufficiently fresh authenticated Hub snapshot where available and obtain current-session identity through the existing endpoint. Bound each combined validation attempt to three seconds; issue independent reads concurrently. Do not abort an existing shared Hub refresh merely because the Return consumer times out. Validate on eligible workspace entry, Hub page entry/`pageshow`, authentication changes, and before using a hint whose validation has expired under the existing Hub refresh cadence. After timeout/failure, withhold the actionable hint and retry through normal refresh or an explicit retry, not a tight new polling loop.

Give attempts a generation/authentication epoch. Logout and unauthorized responses synchronously clear the hint and invalidate pending work; a later successful response from that work cannot write it back. Replace or cancel owned requests on supersession/navigation, and accept a result only for the current attempt and session. A slow or failed Return check cannot disable the four surfaces, ordinary Hub actions, or the existing Hub navigation affordance. Record a newly opened workspace only when its hint can be bound safely; unavailable validation is not permission to use an unverified fallback.

Return occupies the first position, followed by Hub and Settings, throughout authenticated Hub subpages. It navigates to the canonical workspace root and lets current explicit-navigation/personal-state precedence decide restoration. It does not invent a path from a display name. A stopped target uses the existing credential-aware Start path after explicit activation; browser Back never issues Start. Preserve duplicate-name disambiguation.

**Alternatives rejected:** a global `current` variable shared by forms and routing, a durable cross-user Return cache, raw saved URLs containing tokens, or treating a cached hint as proof the session is running.

### D4. Evolve the surface-navigation owner, not the surfaces

Keep the four surface tabs and existing owner callbacks in `src/shell/tab-bar.ts`. The overlay contains a distinct Hub navigation action only after the existing base-path-plus-Hub-probe detection succeeds. Existing sidebar workspace switching and mode escape remain intact, so functionality and workspace interior layout are not reduced.

Separate two geometry concepts: reserved navigation inset becomes zero in touch overlay mode; measured overlay bounds remain available for placement of Preview controls. Update the relevant viewport calculations through their owning modules rather than leaving a hidden bar in layout or rewriting Terminal/Chat CSS wholesale. Safe-area and keyboard bounds still apply.

Observe and display both existing Terminal unseen-output and Chat attention state. The surface owners still clear/acknowledge those signals. No new terminal input, attachment, queue, or provider behavior is introduced.

**Alternatives rejected:** another tree or surface instance, synthetic clicks on hidden production controls, direct writes to other modules' `appState` fields, or treating the Hub action as a fifth surface tab.

### D5. Bound and accessible overlay state

Use a small explicit presentation state: visible/hidden, pointer interaction, non-pointer focus, keyboard interaction, auto-hide preference, and committed handle position. Entry expansion does not steal focus, force Preview, or create work. A ready, idle selector uses seven seconds; Keep Open makes dismissal explicit. Held-pointer protection lasts until release/cancel, not pointer leave. Non-pointer focus pauses dismissal; pointer-origin focus and hover do not pin the bar forever. In automatic mode, tapping/typing in workspace content dismisses the selector without intercepting the original action or terminal bytes. Keep Open disables that outside dismissal. The related Preview file-control group is excluded so stepping through files does not move controls beneath the user's finger. Escape respects higher-priority dialogs and falls through to existing owners when navigation is not handling it.

The handle is an edge-docked control with a comfortable hit target and a smaller translucent visual treatment. Store side plus normalized vertical position, clamp using actual visible viewport and safe areas, and distinguish drag from tap. Do not install global touch-prevention that breaks the terminal's swipe/scroll/text-selection behavior.

Use a local materialize-inspired opacity reveal, approximately 180 ms in and 280 ms out, interruptible from current opacity and interactive during reveal. There is no distant geometry match. Reduced Motion is immediate. These timings are design values, not Apple constants. The source references are Apple's [materialize](https://developer.apple.com/documentation/swiftui/glasseffecttransition/materialize), [custom Liquid Glass](https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views), [Motion](https://developer.apple.com/design/human-interface-guidelines/motion), [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility), [Tab Bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars), and [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets).

The hidden selector and bottom form-action placement are deliberate one-handed design choices, not claims of exact UIKit conformance. Follow the documented guidance on legibility, clear states, limited modality, short interruptible effects, and explicit cancellation. Preserve system theme and existing Uatu font/assets instead of copying mock palettes or external SF Symbols/font resources.

### D6. New preferences are narrow and client-local

Introduce production navigation preferences for handle placement, automatic versus explicit dismissal, and Preview control side. In confirmed Hub sessions and Hub pages they share one Hub-origin/browser-profile scope. In standalone serve use the existing workspace/base-path-local presentation scope, with a non-tab navigation-preferences action in place of the unavailable Hub action. It exposes Keep Open and placement without adding a fifth surface tab. A Hub button or Hub Settings dependency must not be required to recover standalone navigation.

Validate side/enums and finite bounded placement. Storage failure falls back to usable in-memory defaults. Synchronize these new preferences between tabs on the same Hub; queue a remote placement update during a local drag, let a completed local gesture commit, and apply committed state on cancellation. Do not propagate navigation, active tab, PTY selection, zoom, pane geometry, or Follow to another client.

Keep existing shipped workspace-scoped keys and precedence. Do not migrate `uatu:prototype:*` data. No personal-state API field or persisted Hub registry change is needed. Document that different origins are different preference scopes; this is not device-to-device or alternate-hostname synchronization.

Do not ship the mock's Prototype display preferences, failure-simulation selectors, fixed theme query, or demo unlock behavior. Browser/test-driven text enlargement verifies that real new controls scale; existing Preview-content and Terminal font-size preferences keep their current meaning and owners.

### D7. Implement sibling navigation as a document capability

Add a small Preview feature owned under `src/preview/`, using the current client corpus and selected destination from their existing owners. Derive siblings by stable root id and exact parent of `relativePath`; use the same file comparator as Files. Do not create an independent unscoped fetch/cache, crawl the filesystem, infer root identity from rendered text, or reuse the prototype's synthetic `.search-hit` adapter.

Invoke the existing user-selection path for Previous/Next so history, Follow Rule A, Files selection, and renderer/load-generation behavior remain consistent for text and images. Back to Files activates the existing surface without a document selection. Preserve existing ordinary binary-anchor behavior and all Rendered/Source/Diff, layout, wrap, outline, metadata, and find controls.

Sequence membership is all indexed direct siblings in the current effective client scope, independent of Files' All/Changed display chip. Preserve the chip and existing selected-file reveal cue. A file pin or CLI single-file constraint cannot be widened. Single-file confirmed sets hide both arrows. Commit/review/empty previews have no file sequence; known-file load failures retain a recoverable file context. Unsupported binaries retain the existing unavailable-preview behavior rather than silently disappearing from file order.

Use explicit loading, ready, index-error, pending-selection, timeout, and missing-target states. A stale index is not evidence of a boundary. Obtain completion/supersession from the existing navigation/load owner or a narrow extension of that owner; do not poll the DOM for truth. Retry revalidates the intended id within current scope, keeps unrelated state intact, and reports disappearance without substituting another file. A source-index failure must not block Back to Files.

### D8. Preserve complete Hub workflows

The visual mock is intentionally incomplete. Production UI must cover the complete capability matrix below, not only the photographed happy paths.

For edit-default forms, initialize the current role/host selection. For an explicit assign-new flow, retain the selected credential and clearly name the assignment/replacement intent instead of disguising it as the current default. Keep the existing ability to set authentication and signing together. Review/back and unlock recovery preserve non-secret in-page draft state and focus; secret clearing/upload-source rules win over draft retention.

Retain existing authorized-operation sequencing. Starting with no assignments still requires its confirmation; locked assigned credentials unlock and continue the same start. For clone, an independent Unlock-and-return recovery is not a new submission. If the existing clone flow continues an already explicitly authorized request after unlock, it remains one operation, not a duplicate job. Cancelling any pre-submission step creates nothing.

Use existing stop/forget APIs in order for any combined mobile action. Show partial results rather than pretending a multi-step action rolled back. Keep streamed clone output, any-prompt masked input, cancellation, bounded replay/reconnect, terminal outcomes, and retry/recovery actions. Navigation away is not job cancellation, HTTP acceptance is not job success, and aborting a browser request is not rollback of a committed operation.

### D9. Non-regression matrix and test ownership

| Area | Must remain intact | Required verification |
| --- | --- | --- |
| Desktop and mode switching | Existing desktop/Native Desktop layout, titlebar inset, zoom, live mode escape, coarse-pointer input affordances, stored workspace geometry | Desktop browser baselines; mode/rotation tests; existing desktop-related tests and path-filtered CI as applicable |
| Hub identity/history | Stable ids, duplicate display names, canonical routes, truthful live chip, Back/Forward and BFCache refresh | Real multi-workspace fixtures; rename/manage-other/back; stopped/removed targets; fresh/expired Return hints |
| Authentication | Login gate, return-to, API 401 versus navigation redirect, origin/CSRF/method protections, device revoke, cookie/bearer behavior, no child-token leak | Existing Hub auth/integration and API contract tests; signed-out and cross-origin cases |
| Native sign-out and PWA | Observable real logout navigation, Keychain invalidation integration, Hub manifest scope/start URL, anonymous branding without version leakage | Existing wrapper/auth/manifest tests; browser navigation assertions, not a simulated sign-out toast |
| Workspace lifecycle | Open/Start/Stop/forget, in-flight races, live shell inventory, credential summaries and opening feedback | Actual Hub endpoints with controlled sessions; stop-success/forget-failure; repeated/failed starts |
| Folders and onboarding | Browse elsewhere, empty folder creation/removal, distinct names, Git-init consent, nested registration coordination, atomic assignments, default-parent fallback | Existing filesystem/Hub integration plus touch-browser flows; invalid paths/collisions/cancel/recovery |
| Credential types | SSH, OpenPGP, tokens; capability-specific generate/import/public-key/unlock/lock/enable/disable/test/delete behavior | Catalog fixture matrix covering all applicable actions, not a hard-coded GitHub SSH card |
| Assignments and tools | Host-specific auth, signing, dual-role selection, replacement, stop/restart implications, layered readiness, optional-tool failure, overrides | Actual request shape assertions; untouched editor; per-role defaults; cancellation and failed stop leave catalog unchanged |
| Secret handling | Masking, import-source exclusivity and size validation, clearing after attempts, no persisted secrets, shared-UID advisory | Existing secret/security tests; error-output sanitization; storage inspection for new hints/preferences |
| Clone | All documented options and terminal result variants; no ambient credential fallback; owner-only replay/input/cancel; stopped default | Clone job integration and browser states for success, clone/register/start/cleanup failure, cancellation, timeout, expired/restarted jobs |
| Workspace surfaces | Same tree/panes/filter, Search, Change Overview/compare, Git Log, Usage, shortcuts, Follow rules, find ownership | Existing feature E2E plus focused selector integration; watcher activity never steals the active surface |
| Preview | Existing renderer/view/layout/wrap/outline/anchors/facts/image/binary behavior | Text, code, image, unsupported binary, duplicate-root, single-file, scoped, Changed-filter, error/retry, race, and history cases |
| Chat | Agent identity/capabilities, drafts and pending-upload ownership, queues/idempotency, prompts/cancel, permissions/questions, drill-down/tasks, scrolling, recovery/attention | Existing chat suites; in-page surface-switch regression; full navigation keeps current documented lifecycle, not a new iframe guarantee |
| Terminal | PTY lifetime, no accidental create/kill/takeover, reconstruction, hidden-pane output, pane cap, keybar, clipboard/find, fullscreen/keyboard sizing, desktop geometry | Existing real PTY/browser tests with controlled commands; transport/state assertions beyond screenshots; unavailable-backend cases |
| Accessibility and persistence | 44px targets, 200% text, meaningful focus/labels/states, Keep Open, reduced motion/transparency, Hub-local sync without semantic leakage | Chromium and WebKit at 320/390 portrait, short landscape, tablet, desktop, and enlarged text; fault injection scoped to test clients |

Screenshots demonstrate appearance, not lifecycle or accessibility completeness. The mock's 82 browser checkpoints are useful acceptance examples but do not replace production tests. Retain existing suites even if selectors need intentional presentation updates; do not weaken assertions to make the redesign pass. Physical-device testing is excluded by user decision; do not claim VoiceOver or real-iPhone validation from browser emulation.

### D10. Reconcile only relevant spec drift

The earlier `hub-service` clone cleanup scenario says to remove registration after start failure, while its later onboarding requirement, the current runtime, and `api/streaming.yaml` preserve the configured stopped workspace. The included delta aligns that scenario with current behavior; it authorizes no backend change.

Other pre-existing specification inconsistencies are not invitations to change behavior. In particular, preserve the current active-surface Find behavior and existing tests rather than interpreting older touch shortcut wording as permission to reroute Find. If implementation uncovers an unrelated contract conflict, record it separately and stop before making a behavior change outside this proposal.

## Risks / Trade-offs

- **Full-page navigation differs from the mock's apparent continuity.** Preserve current restoration/reattachment behavior and clearly exclude resident-browser guarantees; test actual route changes, not only surface swaps.
- **Custom collapsed navigation departs from standard always-visible iOS tabs.** Keep the approved seven-second default, explicit Keep Open, accessible focus behavior, status signals, and a consistently reachable handle.
- **Overlays can obscure content.** Keep them small, movable/configurable, and correctly lifted; ensure temporary expansion never traps a required control and preserve scrolling and keyboard escape.
- **Hub-wide preferences could leak workspace semantics.** Restrict the shared namespace to the three new presentation preferences and validate Return independently against the authenticated session.
- **Refactoring inline Hub UI could remove rare features.** Use the matrix as a feature-inventory gate; preserve current routes, request shapes, conditional actions, and contextual error handling before polishing presentation.
- **Polling and re-rendering can destroy focus or form drafts.** Keep task/form ownership stable across state refreshes and use existing request-generation guards rather than rebuilding interactive subtrees indiscriminately.
- **Browser-only acceptance has limits.** Record the exact browsers and test coverage, honor platform preferences in code, and do not silently reintroduce a physical-device gate or claim hardware verification.

## Migration Plan

1. After explicit implementation approval, rebase/update the focused branch against current `main` and establish production baselines and parity fixtures before UI changes.
2. Introduce new production-only presentation keys with validated defaults. Preserve shipped workspace keys; ignore prototype data. No public API or server-state migration is expected.
3. Integrate Hub chrome, selector, and Preview controls incrementally through existing owners, keeping desktop and standalone paths covered at each step.
4. Run focused tests during development and every contribution-guide final gate before final review. A wire-contract change discovered during implementation requires replanning under API-contract publication rules, not an incidental schema extension.
5. Reverting the client presentation changes restores the existing UI; unused navigation keys are harmless and do not alter server state. A client rollback must not reset workspace registrations, credentials, PTYs, or personal state.
6. After implementation and review, sync capability deltas and archive this change before final merge. Use the repository's PR/CI/squash workflow and truthful Conventional Commit/release-note discipline; do not bump versions or edit generated future release notes manually.

No implementation, commit, PR, spec sync, or archive is authorized by this planning step.
