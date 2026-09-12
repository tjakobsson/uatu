# Task 1.3 — scoped same-document integration audit

> Current entry points: [evidence index](README.md) and [verification](verification.md). Keep the interface guidance below; its recorded verification and generated-artifact paths are historical at pre-cleanup commit `373ef6350032f6a0f2a91c2037ebafb553bc002f`, not new acceptance.

Audited 2026-09-09 against the preserved dirty-tree baseline. This is an
implementation map, not evidence that continuity already works. References are
to the current working tree; later edits can move line numbers.

## Ownership boundary

One coordinator owns only foreground Hub/workspace presentation, Hub view/scroll
context, modal precedence and route dispatch. `src/shell/state.ts:170–216`
remains the sole workspace state singleton. Document selection, active surface,
File attachments, streams, xterm and preferences retain their existing owners.
Exactly one workspace can remain resident; opening B is the existing document
lifetime boundary. No iframe, replacement client, or serialized attachment state.

## Integration map

| Concern | Existing owner and evidence | Required bounded change | Verification |
| --- | --- | --- | --- |
| Single-shot boot | `src/app.ts:28–90` queries workspace DOM at import time; `:92–138` wires owners and boots. `src/shell/boot.ts:39–181` loads state and starts clients. | Extract a single-shot boot/bootstrap seam, preserving current production default and initialization order. Mount unique workspace markup before importing modules that query it. Do not start workspace boot at a displayed Hub URL interpreted as a document. | Same workspace root/client sentinels and exactly one boot on every round trip. Direct Hub and workspace route loads tested separately. |
| Workspace DOM | `preview/mount.ts:69–77`, view-mode/layout/header/empty/commit-message/anchors/mermaid/diff/outline; `sidebar/shell.ts:25–31`, panes/search-pane/tree-mount/files-filter/git-log/change-overview; `find/find-bar.ts:19–34`; `terminal/panel.ts:234–273`; `chat/surface.ts:186–189`. | Retain one uniquely identified workspace root; scope all new Hub queries/IDs locally. Inject/scoped-query existing owners only where actual coexistence requires it. Avoid a parameterized multi-workspace rewrite. | No Hub update selects/replaces workspace DOM. Current interiors remain unchanged. |
| CSS and measurements | `styles.css:190–206` owns body overflow/height; touch rules at `:6993–7004,7275–7287,7303–7326,7378–7404` depend on global mode/tab attributes. | Strict Hub-root CSS and one foreground attribute; preserve workspace measurements when inactive. Set inactive root inert/aria-hidden without assuming whole-root `display:none` is safe. No generic Hub body/main/button/row/pane rules. | Hidden root cannot receive input/accessibility focus; terminal rows/columns and surface scroll do not reset. Desktop/native inset comparisons. |
| Stable request base | `shared/app-url.ts:14–27` caches injected meta; `:35–59` builds/decodes URLs. `shell/boot.ts:55–65`, `shell/events.ts:97–103` already use it. `hub-nav.ts:66–79,193–196` derives identity from it. | Bind workspace meta before imports/boot; never reset it on `/settings`. Hub interface uses explicit origin routes, not workspace `appUrl()`. Do not rewrite document base. | HTTP/SSE/WS remain `/s/A/...` while displayed route is Hub; managing B never retargets A. |
| History partition | `shell/history.ts:118–235` currently handles all popstate; transient interceptors at `:125–149`; canonical workspace writes at `:37–77`. Boot parses URL and replaces history at `shell/boot.ts:39–48,77–149`. | Refactor one dispatch seam before document selection, not a racing second listener. Hub routes/detail contexts go to coordinator; A routes delegate existing document/hash/commit logic; B uses full navigation. Preserve existing workspace history fields alongside namespaced coordinator context. | Back/Forward and direct loads, independent Hub scroll, hashes and commit queries; no false document load, Follow change, or implicit Start on Hub history. |
| Hub links and Return | `shell/hub-nav.ts:184–209,222–289` wires navigation; BFCache handling at `:315–355`. `shell/tab-bar.ts:369–378` gives touch Hub its href. | Intercept only eligible touch Hub navigation, retain canonical href fallback and desktop behavior. Ask existing selector owner to expand on Return; never set active tab to Preview. | All four surfaces preserved; fresh/visited/renamed/duplicate/stopped/missing Return, manage B then Return A. |
| Selector ownership | `shell/tab-bar.ts:17–28,40–79,134–399,401–466` owns ready state, active tab, placement and idle timing. | Gate its global handlers by foreground/modal context; expose narrow reveal method rather than another timer/tab state. Preserve seven-second and held-input policy. | No hidden selector competes with Hub dock/sheet; Return expansion does not steal focus. |
| Find shortcuts | `find/shortcut.ts:108–165` capture shortcuts/Escape; native bridge at `:177–209`. | Gate workspace shortcuts and native bridge at existing owner when Hub/sheet foreground. | Hub form typing, Cmd/Ctrl-F, Shift-Cmd-F, Cmd-G and Escape cannot activate hidden find/search. |
| Interaction tracking | `find/active-surface.ts:141–173` globally tracks pointer/focus. `tab-bar.ts:290–339` globally handles pointer/focus/input/key/blur/visibility. | Ignore non-workspace events when inactive; Hub focus must not rewrite workspace active-surface state or selector policy. | Hub forms do not change selected workspace surface or attention acknowledgement. |
| Other global shortcuts | `terminal/panel.ts:1811–1875`; `preview/outline.ts:760–792`; `hub-nav.ts:379–393`; temporary Chat agent-menu capture listener `chat/ui.ts:2332`. | Gate through existing owner and modal precedence. Inert alone is insufficient for document listeners. Close/restore focus only within current foreground context. | Escape, terminal toggle/split and ordinary typing produce no terminal bytes, hidden overlay activation, or focus steal. |
| Async state and focus | Preview generation checks `preview/mount.ts:79–88,117–161`, `load-generation.ts:23–39`; SSE channel generation `shell/events.ts:97–117`; Chat conversation checks `chat/ui.ts:3030–3043,3082–3119,3225–3229,3280–3288,3374–3452`. | Preserve background state updates; gate presentation/focus effects. Coordinator auth/workspace generations prevent invalidated protected roots from resurfacing. Do not replace existing document/conversation ownership checks. | Delayed responses while Settings active cannot replace its view/focus; stale 401/revoke/Stop/removal completions cannot restore retained access. |
| Focus entry points | Chat restored-draft focus `chat/ui.ts:3062–3068`; Terminal deferred focus `terminal/panel.ts:920,1128,1524,1654–1662,1953–1959`; find open/close `find/find-bar.ts:260,296,318`; search `sidebar/search-pane.ts:385–414`. | Check current foreground after awaits/deferred callbacks. Capture outgoing-root focus deliberately; sheet dismissal restores only a still-valid trigger in current context. Return does not focus selector. | Complete pending operations during a Hub form/sheet; focus stays with active task. |
| Chat lifetime/activity | Pending File/staging ownership `chat/ui.ts:3046–3068,3233–3335`; pagehide disposal `:3474–3499`; visibility predicate/observers `:3823–3876`. | Add foreground to existing activity predicate/observer, not document visibility spoofing. Preserve uploads/streams/maps; pause only inactive rendering/read acknowledgement. Ordinary detour must never emit teardown/pagehide. | Exact File object and draft identity, continuing upload/stream, one request/transport; no reconstructed filename substitute. |
| Geometry and scroll | Terminal resize/reveal/refit `terminal/panel.ts:1753–1761,1930–1958`; UI-mode resize `shell/ui-mode.ts:97–104`; tab viewport/ResizeObserver `tab-bar.ts:204–225,329–339`; preview outline/file-navigation/mermaid and Chat/terminal viewport helpers. | Capture existing surface anchor before foreground change, suppress zero-size terminal fits, reconcile once after visible geometry returns. Preserve Hub scroll separately from existing surface owners. | Output during Hub detour, changed viewport/keyboard, terminal geometry and all surface scroll positions preserved on Return. |
| UI mode and preferences | `shell/ui-mode.ts:56–119`; `state.ts:203–210` and `tab-bar.ts:40–79`; anti-flash `index.html:15–59`; `navigation-preferences.ts:10–18,40–71`. | Read eligibility without overwriting mode/tab. Sheets use existing preference setter and draft/Cancel/Done; preserve one-time authenticated Hub-scope promotion and storage fallback. Explicit mode escape retains existing desktop/standalone defaults. | Cancel/no-op/Done, cross-tab update, storage denial, live mode switch; no semantic preference leakage. |

## Initialization and event ordering

1. Assemble scoped Hub and unique existing workspace roots; establish the retained
   workspace request context before importing workspace modules.
2. Preserve existing initialization order: mode/tab stamps, interaction/find and
   sidebar/preview owners, token/PWA/history, then workspace load and Chat ready.
3. Route dispatch identifies Hub versus workspace before document selection runs.
   A blocking sheet has interaction precedence over either foreground root.
4. A detour captures surface anchors, makes workspace interaction inactive, and
   reveals Hub without teardown. Background operations retain their owners.
5. Return restores geometry/scroll and asks the existing selector to expand.
   Authoritative auth/workspace invalidation overrides this path.

## Boundaries and risks (not implementation completion)

- `src/hub/pages.ts` emits a document-global inline controller. Injecting it is
  unsafe; the planned reusable mobile modules/interface must replace that approach
  only in the isolated review entry, not wire live operations in this stage.
- Singleton base/state/DOM assumptions are compatible with the authorized one
  retained workspace. Multiple resident workspaces would require a materially
  larger redesign and remain explicitly out of scope.
- Global workspace layout and import-time queries warrant targeted coexistence
  fixes. A wholesale root-parameterization/CSS rewrite is not selected here.
- New live auth, credential, filesystem, branch-probing and transport adapters
  remain deferred. Existing owners are audit evidence, not permission to invoke
  privileged services. Synthetic invalidation is not live authorization proof.
- Browser process eviction/reload and cross-workspace replacement remain real
  lifetime boundaries; ordinary detour preservation cannot guarantee survival.

Every required coexistence concern has an existing feature owner above. The
coordinator is a new presentation seam, not a second workspace singleton. Tests
listed above are prospective acceptance checks; this audit ran no browser,
provider, shell, server, credential tool, or live backend operation.
