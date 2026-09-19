## Context

See `proposal.md` for the motivation and the four delta specs for the behavior contract.

- `src/chat/adapter.ts` already observes live turns and pending interactions across conversations. `ChatActivity` exposes only workspace-wide `working` and `awaiting` booleans; neither identifies a new question or the completion of one conversation while another continues.
- `src/shell/live.ts` suspends a hidden page's live channel. `src/hub/live-broker.ts` releases child subscriptions after their last page subscriber leaves. Both are intentional connection-budget behavior.
- `src/shell/pwa.ts` registers no worker and removes identified old `/sw.js` registrations. Hub session manifests have origin scope, but generic mounts have path scope. The main base-path spec still contains an obsolete per-session worker requirement.
- `src/styles.css` sizes the desktop `.app-shell` to `100vh`. Most physical safe-area padding is under touch-mode selectors. `src/chat/viewport.ts` writes visual height/offset variables, but only touch chat consumes them. Its keyboard boolean ignores occlusions at or below an 80-pixel threshold, which must not govern desktop geometry.
- The imitation macOS titlebar frost is gated on `html.uatu-desktop-host`. Changing the PWA's UI mode does not set that marker. The screenshots establish obscured headers and focus-induced upward movement; they do not establish whether the iPad's blur is native or application-rendered. Verify that distinction on-device before changing blur rules.

## Goals / Non-Goals

**Goals**

- One provider-independent notification event model, with server observation independent of page presence.
- One push enrollment per browser registration context, with user-owned per-device workspace preferences.
- A hub-owned worker that can open any authorized workspace without handling ordinary network requests.
- One owner for desktop workspace viewport geometry, so chat, preview, sidebar, and docked terminal agree about the available rectangle.

**Non-goals**

- Offline chat/document caching, background page polling, a hosted notification relay, and native macOS notification integration.
- Notifications for every tool/subagent/background-task completion, failures, or cancelled turns; notification inline reply actions and app-icon badges.
- Guaranteed delivery while the hub/agent is stopped, after platform force-quit restrictions, or at a specific OS presentation time.
- Redesigning the desktop layout or removing the macOS wrapper's titlebar treatment.

## Decisions

### D1. The hub owns Web Push delivery and persistent device state

Add a notification domain under `src/hub/` for enrollment persistence, event consumption, and sending. Use the existing private hub state root and atomic state-file conventions for VAPID identity, enrollment records, and a versioned delivery journal. Persist journal insertion and its upstream cursor together before acknowledging an event locally; record terminal outcomes atomically. Retain deduplication identities for 24 hours and delivery payloads only while needed for their five-minute lifetime. Bound replay and journal storage by count/bytes as well as age, with an explicit gap recovery path rather than unbounded growth.

An enrollment stores an opaque id, owning user, authorizing hub session reference, push endpoint and encryption keys, selected workspace ids, category preferences, creation/update timestamps, and delivery status. The public id is not a bearer credential. Revalidate the authorizing session and workspace membership before each send. Logout, session expiration/revocation, disable, and account deletion invalidate unsent deliveries. Re-enrollment under a new login must reconcile ownership explicitly; an endpoint is not automatically reassigned to another account.

Expose authenticated hub operations to read notification capabilities/public VAPID key, reconcile the current enrollment, update its preferences, and remove it. Reuse hub cookie/bearer and CSRF conventions. Publish these operations in `api/openapi.yaml`, route coverage, and API tests; classify the child feed as internal. Validate subscription payloads and destination endpoints, and do not follow push endpoint redirects into arbitrary hub-local resources.

Generate the VAPID keypair once and retain it across restart. Add a documented notification contact setting for a valid VAPID subject; unavailable sender configuration must be reported before the UI claims enrollment succeeded. Use a maintained Web Push library behind a small sender interface instead of implementing encryption/VAPID by hand. Verify Bun and compiled-binary compatibility and license acceptance before pinning the dependency.

Alternative considered: page-triggered `Notification` calls. They stop working when the page is suspended and would require undoing the hidden-page connection policy. A hosted relay adds a service and account dependency that self-hosted hubs do not need.

### D2. Emit distinct live occurrences from the chat service

Introduce a shared notification-event type near the chat service boundary. Each occurrence carries workspace context, agent-qualified conversation id, event kind, source time, and a stable request or turn identity. Questions and permission requests use their existing stable request ids. Providers must attach a correlated turn identity and final outcome to notification lifecycle events before those events cross the shared boundary. A server-issued identity is valid only when the provider can correlate both ends of that specific execution; assigning an unqualified completion to whichever turn is currently running is not valid.

OpenCode's `session.idle` and `session.status` completion frames carry no turn identity. They remain UI status signals, but must not directly produce notification completion. Correlate native step/message lifecycle records to their prompt and final assistant response, using the provider's terminal outcome and message identity. Preserve correlation across live-stream reconnects and reject a delayed old terminal frame after a new turn starts. Cover native and compatibility event families explicitly; do not assume every ended model step ends a user turn.

Claude's result handling knows the owning SDK execution, cancellation state, pending prompts, and remaining background work. Emit the correlated notification outcome there, after resolving cancellation and background-work state, rather than from the earlier generic `completed` status. A result followed by a background state must produce no successful-turn notification. Repeated result identities must not advance the next queued turn.

Hook the adapter's live processing after workspace classification and provider normalization, not the timeline renderer or history projection. Emit `question-pending`, `permission-pending`, and `turn-completed`; carry interaction resolution as a control event so the hub can cancel unsent alerts. Completion requires a known live top-level turn with a successful terminal outcome. Running-to-background is not completion, and child-agent or tool rows do not qualify. Explicitly test both OpenCode and Claude, including conversations not selected in any browser.

Use a small internal workspace notification SSE feed declared through `buildRoutes(deps)`. It combines live occurrences from started agents without starting unused runtimes and supports bounded cursor replay plus an atomic pending-interaction snapshot/live handoff. The service binds subscribers to agents that start later during normal use. Initial enrollment starts from the current feed position, avoiding alerts for old history. Recovery from a known feed gap reconciles still-pending request ids but never infers historical completion from idle state. A recovered pending request keeps its original source time and obeys the same delivery expiry.

Alternative considered: deriving events from `working`/`awaiting` or generic status transitions. Aggregate flags miss simultaneous conversations and a second question while one is pending. Unqualified completion transitions can refer to a previous turn or precede the provider's background-work decision. Subscribing to every full conversation transcript adds unnecessary content and connection work.

### D3. Server observation has its own lifetime

A hub notification coordinator holds at most one child notification-feed connection per running workspace with active, authorized enrollment interest. It shares events among devices, tracks cursors, retries with bounded backoff, and releases the connection when the final eligible enrollment leaves. It listens for workspace start/stop and authorization changes. Observation never starts a stopped child or unused agent runtime.

This feed is separate from the page broker's fixed topic vocabulary. Existing page streams and their refcounted upstream subscriptions retain their current lifecycle; a hidden page still disconnects. Notification state therefore adds connections proportional to observed workspaces, never to device or tab count. Reuse suitable SSE parsing/recovery utilities, but do not make a phantom browser stream to keep the broker alive.

Alternative considered: keeping the page broker's conversation subscriptions alive for notifications. That changes its release guarantee and still requires discovering every relevant conversation. A workspace feed exposes exactly the events delivery needs.

### D4. Queue by event and enrollment, with bounded delivery

Each event/enrollment pair is one journal entry. Before sending, check enrollment authorization, preferences, known interaction resolution, and expiry again. Set push TTL to the remaining portion of five minutes. Treat gone endpoints such as HTTP 404/410 as terminal enrollment failures. Retry network failures, rate limits, and transient server errors with bounded exponential backoff and `Retry-After` where applicable, never beyond expiry. Configuration/authentication errors must not spin in a tight loop or be mislabeled as deleted devices.

The encrypted payload includes a version, logical notification id, kind, workspace label, same-origin destination, and source time. Display generic copy such as "An agent needs your answer" or "Agent turn finished" rather than question/tool/transcript content. Use a stable notification `tag` and disable re-announcement of replacements. A timed-out send may already have reached the platform, so idempotent journal handling and replacement tags reduce duplicates but cannot promise exactly-once OS delivery.

Use the same push path when a page is visible. Do not add a second page-local OS notification or silently discard received pushes based on foreground presence. This keeps the initial behavior deterministic and compatible with Web Push's visible-notification requirement.

Alternative considered: foreground suppression through presence leases. It adds race-prone device presence tracking and can conflict with a platform's requirement to show received pushes. It is not needed for this version.

### D5. A push-only worker belongs to the hub origin

Serve a stable, distinctly named script such as `/push-worker.js` from the hub with origin scope. The script contains no credentials or user data, is reachable without a login cookie for update checks, and uses revalidation-friendly caching. It implements push and notification-click handling, with no `fetch` handler and no content cache. Embed the asset in compiled builds.

Use explicit server-provided hub ownership context, not merely a `/s/.../` pathname, before registering the origin-scoped worker. Add a shared hub URL helper consistent with the existing client URL discipline. Generic base-path sessions continue using `appUrl()` and do not offer hub push enrollment.

Serialize legacy cleanup with worker registration/reconciliation. Identify old Uatu workers by exact scope/script pairs, preserve the current push script, and clean current-workspace legacy registrations as their pages are visited. Inspect active/waiting/installing registrations before calling `unregister()`: a legacy active script with the new push worker waiting must not cause the current registration to be removed. An unrelated registration at the intended root scope is a visible enrollment conflict, not permission to overwrite it.

Same-scope worker updates need particular care: an old running page can still hold old cleanup code. Test an old page alongside a newly enrolled page, and reconcile missing registrations on the next current-version visit. A browser registration lost to old code cannot be repaired by a suspended page; document that upgrade limitation rather than claiming otherwise.

Alternative considered: a worker per workspace. It creates duplicate subscriptions, complicates hub-wide installation and sibling-workspace notification clicks, and ties registration lifetime to a session child.

### D6. Enrollment and notification navigation share existing app entry points

Put a Notifications control in the hub dashboard and workspace sidebar controls, with a reachable collapsed-sidebar affordance. The enrollment form shows supported/unsupported state, permission state, selected workspaces, and the two category toggles. Initial form defaults are both categories and only the current workspace, if present; the user confirms these selections. Added workspaces never subscribe automatically.

Prepare the worker and public-key/configuration state before enabling the user-gesture button so asynchronous setup does not lose the permission gesture on iOS. Call the required permission/subscription API directly from that gesture. On later visits, reconcile browser permission, the existing push subscription, and server enrollment. Revocation disables sending as soon as observed. Do not promise detection of an OS permission change before the platform or a returning client reports it.

Add a shared same-origin conversation destination using the workspace URL plus an encoded agent-qualified conversation parameter. Resolve that parameter after authentication and chat initialization, then open Chat through existing mode-aware navigation. Carry the destination through the hub's validated return-location handling. Reuse a matching conversation window where possible; otherwise open the destination. Do not navigate an unrelated workspace window with an unsaved draft merely because it shares the origin.

Validate the destination again in the worker and app. If it is missing or inaccessible, present the unavailable target and let normal workspace navigation remain available. Do not apply a notification's identifier as a silent replacement for an unrelated stored conversation choice.

Alternative considered: notification clicks landing on the dashboard. It loses the conversation identity precisely when the user needs to answer an agent.

### D7. Desktop viewport geometry belongs to the shell

Add a shell-level viewport controller that exposes the visible rectangle and observes visual-viewport resize/scroll, window resize, and UI-mode changes. Reuse the existing terminal viewport utility where appropriate rather than adding independent corrective loops. Batch writes per animation frame and detach/clear mode-specific overrides when leaving desktop mode.

In desktop mode, size and position the workspace to the actual visible rectangle at normal zoom, with dynamic-viewport CSS as a fallback. Use the measured height and offset directly; do not gate layout correction on the chat keyboard boolean or an 80-pixel cutoff. Account for safe-area overlap once at the outer work area, using a solid background behind the status strip. A panned visual viewport may already exclude part of a physical inset, so calculate remaining overlap rather than subtracting the same inset twice. Child desktop panes fill that rectangle; touch chat and terminal retain their own existing fullscreen geometry without double application.

Track scale as well as geometry so pinch zoom keeps normal browser pan/zoom behavior rather than repeatedly reflowing the entire workspace. The viewport fix must not disable zoom, block touch gestures, repeatedly call `window.scrollTo`, or rely on primary-pointer type to decide whether the hardware has safe areas. Handle the mode's narrow/stacked layout without clipping its scrollable content.

The user authorized implementing this correction using the supplied screenshots and controlled browser geometry before physical reproduction is available. Reserve the reported unsafe area and fit the workspace to the measured visible rectangle. Leave the preview's sticky-header blur intact. Physical acceptance still needs `uatu-desktop-host`, safe-area values, computed blur layers, `scrollY`, visual viewport height/offset/scale, and header/composer rectangles on the reported iPad. Keep macOS native titlebar padding separate from device safe areas to avoid doubled insets.

Alternative considered: replacing `100vh` with `100dvh` alone. Dynamic viewport units do not reliably account for software-keyboard overlay/panning. Raising header z-index also cannot defeat native iPadOS blur or recover a header outside the visible viewport.

### D8. Home Screen icons have an opaque, padded canvas

The user's physical-device testing also exposed a Home Screen icon defect. The existing PNGs had transparent areas that iOS composited as black, and the mark reached the image edges despite being advertised as maskable. Regenerate both existing sizes from the canonical SVG with an opaque white canvas and aspect-preserving placement inside a 39%-radius circle, leaving antialiasing room within the standard 40% safe circle. `scripts/generate-pwa-icons.ts` uses the existing Playwright browser dependency for repeatable rasterization; its check mode verifies the output pixels. Version the icon references through `pwa/icons.ts`, keep the static manifest in sync, and provide Apple touch-icon metadata on both hub and workspace pages. Already-installed iOS Home Screen icons can remain cached; if re-adding the app is needed, the user must check notification enrollment again.

## Risks / Trade-offs

- OS presentation can be delayed by Focus, power settings, or browser policy. Mitigation: describe platform acceptance separately from device display and verify real-device behavior.
- Hub or child downtime can exceed replay retention. Mitigation: bounded replay, persistent delivery state, pending-request reconciliation, and no guessed historical completions.
- A hub restart may also terminate local child work under the existing process lifecycle. Mitigation: persist enrollment/delivery state, but do not promise continued agent execution through hub shutdown.
- Old worker-cleanup code can remove a new same-scope registration. Mitigation: update current cleanup sequencing, test mixed-version pages, and reconcile registration on return.
- A subscription tied to a revoked or expired login stops sending until authenticated reconciliation. Mitigation: show that state on return and explain it in notification settings/help.
- iPadOS keyboard and blur behavior is not faithfully reproduced by desktop WebKit emulation. Mitigation: keep physical-device verification as an explicit acceptance task.
- Coupling geometry to visual viewport measurements can harm pinch zoom or stacked layouts. Mitigation: separate normal-scale keyboard adjustment from zoom behavior and test both wide and narrow layouts.

## Migration Plan

1. Add the sender configuration, persistent state format, internal feed, and authenticated hub operations. Existing installations begin with no enrollment and no automatic permission request.
2. Ship the distinct push worker with revised legacy cleanup and enrollment UI. Generate/persist VAPID identity once; subsequent restarts reuse it.
3. Reconcile current subscriptions during authenticated visits and resume persisted, unexpired deliveries after restart. Document HTTPS, Home Screen installation, outbound push access, and VAPID contact configuration.
4. Ship shell geometry changes with browser regressions and physical iPad evidence. Document the observed source of the blur in the verification result.
5. Before any fix PR, check whether the iPad behavior exists in the latest stable tag and apply the repository's release-note override rule if it only affects unreleased work.

Rollback disables notification sending and unregisters only the identified current push worker through a controlled cleanup release if needed. Do not delete the persistent VAPID identity during rollback. An older binary may remove root registrations through its legacy cleanup; upgrading again must therefore reconcile actual browser enrollment rather than trusting saved server rows. Reverting the viewport change is independent of enrollment state.

## Verification

- Unit tests for provider event identities/classification, no history notifications, journal state/retry/expiry, authorization changes, safe worker cleanup, destination parsing, and viewport metrics including small accessory occlusions and nonzero offsets.
- Hub integration tests with a fake push transport and synthetic child feed. Cover no pages, multiple devices sharing one feed, restart/replay, expired sessions, disabled categories/workspaces, failed endpoints, and public/internal API classification.
- Browser tests for enrollment states, current-worker preservation, notification-click navigation through login, no offline interception, generic mounts, and iPad-sized desktop/touch geometry. Inject viewport measurements only to test the geometry contract, not to claim native keyboard coverage.
- Physical checks on an HTTPS hub: supported desktop browser; installed iPhone/iPad PWA receiving notifications while backgrounded/locked; and the reported 11-inch iPad Pro with Magic Keyboard. On the iPad, compare unfocused/focused composer, accessory-bar show/hide, software keyboard, rotation, collapsed sidebar, mode switching, and zoom. Preserve drafts and capture header/composer positions and screenshots.
- Store automated screenshots and evidence in Playwright's `test-results/` and report through `tests/e2e/evidence.ts`. Assemble change-folder screenshots only at PR time using the documented environment variable; tests must not name or write into this change directory.
