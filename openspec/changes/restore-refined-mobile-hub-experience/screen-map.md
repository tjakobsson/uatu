# Touch Hub screen/state map and frontend-review scenarios

## Reading this map

**P** = directly pictured, **D** = derived from a pictured composition,
**E** = unpictured extension requiring visual/interaction review. Anchors are
filenames under `design/hub-mobile/screenshots-refined/`; see
`reference-contract.md` for materials, typography and exceptions.

This is the actual shipping frontend, rendered with **synthetic services only**
in the review stage. Mock implementations, fixtures, transport interception and
scenario controls live under `tests/`, never `src/`. A durable frontend service
interface supplies data, pending states, results and streams; it is not a set of
buttons that bypasses the real frontend event/state owners. No review action may
fall through to real Hub operations, Git, filesystem mutation, credential tools,
providers or PTYs. Mocked operation outcomes demonstrate presentation and intent,
not backend correctness or authorization enforcement.

## Navigation skeleton

```text
Login (no authenticated dock)
  +-- simulated successful sign-in --> Hub
Hub -- Settings -- identity / credentials / defaults / devices / security / navigation
 |       +-- details -- task sheet -- review / cancel / outcome
 +-- Add Workspace -- browse / create / clone -- task / progress / recovery
 +-- workspace menu -- information / rename / assignments / stop / forget
 +-- Open or explicit simulated Start --> current workspace root
         Files <--> Preview <--> Chat <--> Terminal
         +-- Hub --> Settings/details --> Return to same mounted workspace
```

Hub and workspace roots coexist in one document, without iframes. Hub and
Settings scroll and form context are separate from workspace surface state.
Only the active presentation receives focus/input. Ordinary Hub detours do not
remount the workspace, replace File objects or abort ongoing client work. Keep
the existing workspace interiors, not a freshly designed facsimile.

## Screen and state inventory

| ID / screen | States and reachable workflow | Reference and review treatment |
| --- | --- | --- |
| H01 Login | Empty, submitting, invalid credentials, rate-limited, unavailable/retry; safe return-target context, keyboard/autofill, password masking. Signed-out page never exposes workspace/version metadata. | **E**; compact current branding and grouped form derived from Hub/sheet grammar. Simulated authentication only. |
| H02 Dashboard | Initial loading; empty registration list with Add Workspace; mixed running/stopped; all running; all stopped; refresh failure with truthful stale/unknown status. Host and count agree with supplied state. | **P/D/E**, `01-hub.png`, `30-history-stopped.png`; empty/loading/error are extensions. |
| H03 Workspace row | Name/path, running state or branch metadata, assigned-auth/signing summary and shell information reachable without losing row clarity; Open/Start and ellipsis. Long/duplicate names disambiguated by path/id. Branch named, detached, non-Git, loading and unavailable states; no invented `main`. | **P/D/E**, `01-hub.png`; branch values simulated and labeled during this phase. Branch acquisition deferred. |
| H04 Workspace actions | View information; rename display name; edit assignments; explicit Start including unassigned confirmation or masked unlock; starting/opening/failure; Stop confirmation and pending/result; forget registration distinct from deleting files; composite partial success if supported. Cancel creates no operation. | **D/E**, row ellipsis in `01-hub.png`, recovery in `30-history-stopped.png`; sheets follow `31-defaults-draft.png`. Preserve existing operation semantics, do not invent a new destructive policy. |
| H05 Hub dock/history | Fresh: Hub, Settings. After genuine open: Return to workspace, Hub, Settings. Return survives Settings and detail browsing; managing B does not replace opened A. Renamed, stopped, missing, auth-expired and refresh-unavailable targets get truthful recovery. Back/Forward never starts or substitutes a workspace. | **P/D/E**, `08-return-hub.png`, `15-return-in-settings.png`, `30-history-stopped.png`; exceptions are review states. |
| S01 Settings overview | Identity card; credential summary group + Add Credential; Workspace settings; Account group; sign out. Loading/empty/error for independently loaded sections. Refresh preserves current detail/form/focus, not wholesale DOM replacement. | **P/D**, `15-return-in-settings.png`, `22-preview-side-setting.png`. |
| S02 Hub identity | Current Hub identity/host and authenticated user as available; connected/reconnecting/unavailable; version only where authorized. Do not manufacture editable identity fields or diagnostic facts absent from the interface. | **D/E**, identity card in `15-return-in-settings.png`; full detail needs review. |
| S03 Credentials list | Empty/mixed SSH, OpenPGP and HTTPS/provider token catalog; name/type/capability/public identifier summary, locked/unlocked/unprotected/disabled/missing-tool/unavailable where applicable; assignment/readiness distinction. Add Credential chooser. Shared-UID advisory and existing dismissal semantics. | **P/D/E**, SSH summary in `15-return-in-settings.png`; complete catalog extends it. |
| S04 SSH detail/tasks | Readiness groups, fingerprint/public key and applicable public-copy/download; auth/signing capabilities and assignments; generate with purposes/passphrase; import file or secondary paste, mutually exclusive and existing size limit; unlock/lock, enable/disable, test, delete, pending/error/cancel/result. | **D/E**, visible SSH detail in `31-defaults-draft.png`; full actions unpictured. Mask and clear submitted secrets/import sources according to existing rules; never redisplay private material. |
| S05 OpenPGP detail/tasks | User ID, public identifier, signing purpose, required tooling and layered readiness; applicable generate/import/public-key/unlock/enable/disable/test/delete; invalid import, tool failure, cancelled review. | **E**, same detail/sheet grammar as S04; no false SSH-specific options or unsupported individual OpenPGP lock action. |
| S06 HTTPS/provider token detail/tasks | Host, username/capabilities, enabled/readiness/assignments; add masked token, applicable test/disable/enable/delete. Show HTTPS Git versus GitHub/GitLab CLI capabilities honestly; saved token never redisplayed. Warn about affected running sessions where current policy requires. | **E**, credential-group grammar; no made-up public-key or passphrase-unlock action for tokens. |
| S07 Tools/missing capability | Per-tool detected path, unavailable/incompatible state, optional absolute-path override, Test pending and separate binary/agent/signing results, sanitized failure. Missing credential/current selection remains visible rather than silently choosing another. | **E**, readiness groups visible in `31-defaults-draft.png`. Tests simulate diagnostics; never invoke tools. |
| S08 Workspace assignments/defaults | Workspace-oriented list; both authentication and signing plus host scope; edit-current initialized accurately, explicit assign-new identified separately; role switch; review/back; no-op edit; replacement/removal warning; stop dependency failure leaves catalog unchanged. | **P/D/E**, `31-defaults-draft.png`; preserve dual-role capability not fully pictured. High-risk confirmations reviewed explicitly. |
| S09 Default Folder | Current default parent; choose/browse or edit, save/clear; pending/invalid/unavailable; fallback notice and browse elsewhere. Distinguish workspace display name from folder and parent path. | **D/E**, Default Folder row in `15-return-in-settings.png`; body unpictured. |
| S10 Navigation preferences | Preview-side Cancel/Done; handle side/vertical placement/reset; automatic seven-second versus Keep Open; shared Hub/device scope explanation. Storage denial fallback; other-tab update; large text and keyboard. No prototype-display controls in product. | **P/D/E**, `22-preview-side-setting.png`, `33-keep-navigation-open.png`; full preference bodies extend pictured sheet. |
| S11 Devices | Device label, issued time, current-session marker; empty/loading/error; revoke another/current session with pending/error and sign-out consequence. Never label issued time “last active” without that fact. | **D/E**, Devices row in `15-return-in-settings.png`; simulated outcomes only. |
| S12 Session Security/sign out | Explain existing session/security behavior and shared-UID limitation; reachable sign out; expired/revoked session and failed sign-out presentation. Do not invent password rotation, biometric locking, credential isolation or new security controls. | **D/E**, partially visible Session Security row in `15-return-in-settings.png`; full page/confirmation requires review. |
| A01 Add Workspace entry | Reachable plus-led card, not third permanent tab. Choose existing folder, create workspace or clone; return/cancel keeps Hub context. | **P/D/E**, card in `01-hub.png`; chooser extends sheet grammar. |
| A02 Folder browse | Default parent/loading, breadcrumbs/up/browse elsewhere, folders/empty/permission-unavailable/retry, selected path, registered/nested registrations, folder secondary actions. Existing folder registration has distinct display name, auth/host/signing, Add stopped or explicit Add and start. | **E**, `src/hub/pages.ts:471–576` is capability evidence; reference Hub rows/sheets provide presentation grammar. |
| A03 Create/folder management | Create empty folder distinct from create workspace with explicit Git-init description/consent; folder/display names, assignments; path/name errors/collision; rename folder/empty-folder removal and affected nested-registration warnings; cancellation, pending and partial failure. | **E**, same source capability range. No real filesystem or Git operations in review. |
| A04 Clone form | Remote URL, destination/parent, checkout folder and separate workspace display name; compatible one-time clone credential distinct from retained auth/host and signing; Start after clone choice. Non-secret draft survives unlock, Settings detour and cancellation/review. Dirty exit offers keep editing/discard. | **D/E**, `32-clone-unlock.png` pictures recovery only, not full clone form. |
| A05 Clone unlock/review | Locked selection, masked unlock pending/error/cancel, return to unchanged form without starting a job for separate unlock; already authorized continuation remains one operation. Disabled/missing/incompatible credential is not “no credentials.” | **P/D/E**, `32-clone-unlock.png`; never adopt the prototype demo-passphrase policy. |
| A06 Clone progress | Pending acceptance versus running phases; streamed sanitized output, any-prompt masked response, cancel pending, reconnect/replay, expired/restarted job; success registered stopped or explicit requested start success. Navigation is not cancellation. | **E**, existing progress UI in `src/hub/pages.ts:507–522`; reframe in approved grouped/material language with current stream semantics. |
| A07 Clone/onboarding recovery | Clone failure; registration failure/retained checkout; start failure with configured stopped workspace retained; cleanup failure; cancellation; timeout/disconnection distinct from authoritative job failure; retry without duplicate job and explicit recovery actions. | **E**; archived `specs/hub-dashboard/spec.md:179–188` and `design.md:110–118` provide semantics, not prior visual approval. |
| W01 Current workspace interiors | Files panes/tree/search/filter/selection/scroll; Preview render/source/diff/layout/find/sibling controls; actual Chat capabilities/draft/File attachments/stream/queue; actual Terminal panes/keybar/scroll/output attention. No changes to interior appearance or semantic ownership. | **P/D**, `02–07`, `09–10`, `16–17` screenshots; `03-main-baseline.png` and the two interior crops illustrate preservation, not current golden files. |
| W02 Navigation overlay | Entry/Return expanded; Close/collapsed handle; seven-second idle; held-pointer/focus protection; outside interaction and Keep Open; dragged handle/right side/clamped resize; unread attention; immediate/reversed fade; reduced motion. | **P**, `04`, `07`, `09–14`, `16–17`, `33` and variant captures. |
| W03 Preview navigation | Left/right; selector raised/lowered; sibling first/middle/last/single; index pending/error; navigation timeout/missing target/retry; Files return/reveal; absent outside Preview. | **P**, `18–27` captures. Exact root identity and current surface owners remain authoritative. |

## Review scenarios (prospective, not passed checkpoints)

| Scenario | Exercise and observe |
| --- | --- |
| R01 First visit and information hierarchy | Simulated Login → empty Hub → mixed Hub. Inspect UatuCode branding, Running/Ready groups, icons, names/paths/branch hierarchy, Add Workspace and two-item dock. Exercise malformed login and unavailable Hub without real authentication. |
| R02 Core continuity, repeated on all four surfaces | Open A, select/scroll each current surface, then Hub → Settings → credential detail → Return. Confirm same workspace/root and selected surface, preserved per-surface and Hub scroll, no document reload/remount or unwanted focus/selection change. Entry selector expands without forcing Preview. |
| R03 Unsent draft and File ownership | In current Chat, type unsent text and attach a harmless test File. Detour through Hub/Settings/details while attachment preparation/upload is pending; Return and verify exact draft, attachment identity/status and ability to continue. Observe same client owner; do not accept a copied filename/string as proof. Separately honor clearing rules for credential-import secrets. |
| R04 Ongoing client work | Feed synthetic Chat streaming/queue/attention and synthetic Terminal output through their real clients while Hub is visible; Return and verify progression, scroll and correct attention acknowledgment, with no cancellation/restart/duplicate request. Also exercise a pending Preview selection. No provider call, executable shell or PTY is created. |
| R05 History and exceptional lifecycle | Open A, manage B, enter Settings, use Back/Forward/Return; rename A; simulate stopped/missing A, auth expiry and delayed responses. Review truthful recovery and no automatic Start/substitution. Reload and opening a different workspace are distinct existing lifetime boundaries, not multiple-resident continuity; Stop/invalidation overrides retention as specified. Do not claim ordinary mock continuity proves live enforcement. |
| R06 All Settings capabilities | Traverse identity, credential types, add/import/generate, applicable detail actions, tool readiness/override, defaults, devices/security and sign out. Inspect masked fields, inline errors, current assignment initialization, no-op edit, dual-role/host choice and review cancellation. Return remains available outside blocking sheets. |
| R07 Onboarding recovery | Browse elsewhere; empty/collision/unavailable folders; create and existing-folder registration; clone form → unlock → cancel/return; progress prompt/reconnect/cancel; each partial outcome. Confirm draft preservation, explicit operation intent and distinction between retained files/registration/running session. All effects remain simulated. |
| R08 Overlay fidelity and navigation preferences | Compare expanded/collapsed Hub/Settings/Return docks and all four workspace surfaces against named images. Exercise drag, keyboard move, Keep Open, focus/held pointer, surface input, seven seconds, reverse fade, Preview left/right and alert placement. |
| R09 Responsive/accessibility extensions | Portrait 320/390, short landscape 844×390, tablet touch, 200% text, virtual keyboard, light/dark, reduced motion/transparency and forced colors. Inspect wrapping Return, scrollable sheet actions, visible focus, safe areas and 44px targets. Browser emulation is not physical-device or VoiceOver validation. |
| R10 Non-redesign and isolation | Compare desktop Hub/workspace/native-inset behavior and current workspace interiors with pre-change evidence, not old prototype data. While Hub is active, hidden workspace shortcuts cannot consume Hub input; while workspace is active, Hub CSS/selectors/listeners cannot alter it. Workspace requests retain their explicit base path across Hub URL changes. |
| R11 Review-environment separation | Review chrome clearly says simulated backend/no real operations and identifies the selected fixture scenario. Switch pending/error cases there, not in product Settings. Audit request/transport logs for blocked unmocked requests; fixture modules must not enter shipping bundles. Capture product viewport without review controls while preserving simulation provenance in adjacent review metadata. |

## Review chrome and handoff boundary

Use separate test-owned review controls to select synthetic user/workspace/catalog
states, delay/fail service responses, drive stream events, reset scenarios and
show request logs. Do not insert “simulate failure”, “unlock with demo”, fake
branch data or prototype appearance preferences into product components. Captures
and the review entry visibly identify the synthetic environment; a screenshot
without controls must still be accompanied by provenance, not presented as live.

Provide a handoff listing each screen/scenario, reference anchor or E extension,
captured viewport, observed result, visual deviations and unresolved decisions.
High-risk destructive/credential confirmations, auth-loss handling, multi-workspace
residency, stopped-history behavior and unpictured workflow compositions require
explicit review rather than invented policy. Missing scenarios remain named gaps.

**Stop for the user's visual and interaction approval.** Automated tests,
screenshot comparisons and historical 82-checkpoint reports do not sign off this
frontend and do not authorize live backend, Git or credential integration.
