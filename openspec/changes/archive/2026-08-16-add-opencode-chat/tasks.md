## 1. OpenCode Runtime Foundation

- [x] 1.1 Add a pinned compatible `@opencode-ai/sdk` runtime dependency, update the lockfile, and extend the license audit/notice inputs as required by the dependency's license tree.
- [x] 1.2 Define provider-independent chat domain types and runtime validators for conversation summaries, snapshots, timeline items, interaction requests, statuses, and ordered events, with representative valid and invalid fixtures.
- [x] 1.3 Implement and unit-test OpenCode executable discovery plus lazy loopback service startup with an ephemeral Basic-auth password, bounded health readiness, bounded diagnostic capture, bind-race retry, and no-shell process spawning.
- [x] 1.4 Implement and unit-test deterministic service disposal for explicit workspace shutdown, startup failure, unexpected OpenCode exit, and repeated/concurrent start or stop calls.
- [x] 1.5 Implement canonical first-root selection and session-directory validation, covering symlink-equivalent paths, direct multi-root serving, missing paths, and non-revealing rejection of foreign session IDs.

## 2. Provider Adapter And Projection

- [x] 2.1 Implement OpenCode conversation inventory, creation, lookup, and normalized paginated history with opaque stable cursors and tests for restart discovery, ordering, page boundaries, and foreign-directory filtering.
- [x] 2.2 Implement message and part normalization for user text, assistant Markdown, reasoning, tool lifecycle, command execution, file changes, notices, turn status, warnings, and errors using recorded OpenCode fixtures.
- [x] 2.3 Implement cumulative-text and incremental-delta reconciliation keyed by provider part identity, with tests proving overlap, replay, and out-of-order provider updates cannot duplicate emitted text or tool entries.
- [x] 2.4 Implement the filtered OpenCode event pump and per-conversation projection, ensuring global provider events are published only after conversation and canonical-directory validation.
- [x] 2.5 Implement generation-tagged, byte-bounded replay rings and atomic snapshot-to-subscription handoff, with tests for ordered replay, live delivery, retention gaps, generation changes, cancellation, and subscriber cleanup.
- [x] 2.6 Implement bounded idempotency receipts for prompt, permission, and question mutations, including concurrent duplicate joining, expiry, and stable provider message identity where the installed SDK supports it.
- [x] 2.7 Implement prompt/steer and abort operations with normalized sending, running, completed, interrupted, and failed transitions while preserving completed timeline content.
- [x] 2.8 Implement permission and structured-question request tracking and responses, covering one-time/session approval, rejection, option and multi-option answers, free-form answers, and duplicate or stale response refusal.

## 3. Workspace Routes And Public Contract

- [x] 3.1 Add chat service dependencies to the single shared route builder and implement authenticated status, conversation inventory/create, and paginated snapshot handlers under the configured base path.
- [x] 3.2 Implement authenticated prompt, cancel, permission-response, and question-response handlers with body validation, request-ID requirements, same-origin mutation enforcement, bounded inputs, normalized errors, and unknown/foreign identity equivalence.
- [x] 3.3 Implement the conversation SSE endpoint with cursor parsing, replay IDs, typed `resync`, keepalive/cancellation handling, no buffering, and correct headers through direct and hub-proxied serving.
- [x] 3.4 Generalize or reuse the existing child workspace credential helpers so chat reads and mutations are gated in direct serve and brokered by the hub without changing the shipped terminal cookie/token behavior.
- [x] 3.5 Wire the lazy chat service into production startup and every graceful/failure shutdown path, and inject a deterministic fake service into the E2E route assembly without placing test harnesses in `src/`.
- [x] 3.6 Add all chat HTTP operations and reusable schemas to `api/openapi.yaml`, add the chat SSE lifecycle and event schemas to `api/streaming.yaml`, and update route coverage, examples, API changelog, and workspace revision only as compatibility validation requires.
- [x] 3.7 Add server and hub integration tests for authentication, CSRF/origin rejection, request idempotency, base-path relocation, unbuffered replayable SSE, stopped workspaces, OpenCode endpoint secrecy, and schema-valid responses/events.

## 4. Web Chat State And Desktop Surface

- [x] 4.1 Add one persistently mounted Chat surface and a desktop Preview/Chat switch that preserves both surfaces, sidebar state, terminal attachment, drafts, selected conversation, expansion state, and reading position.
- [x] 4.2 Implement the chat API client exclusively through `appUrl()`, including status/inventory/snapshot loading, mutations, SSE cursor reconnection, explicit resync, transport errors, and cleanup when changing conversations.
- [x] 4.3 Implement an identity-keyed client projection/reducer that applies snapshots and events idempotently, rejects sequence gaps, updates tool/request entries in place, and retains accepted drafts until their user-message identity appears.
- [x] 4.4 Implement the conversation chooser, new-conversation action, empty/loading/unavailable/error states, older-history affordance, and workspace-scoped presentation persistence.
- [x] 4.5 Implement a sanitized streaming Markdown renderer with coalesced full-item rerendering, safe links, syntax-highlighted code, inert raw tool output, and security tests for script elements, event attributes, and JavaScript URLs.
- [x] 4.6 Implement timeline presentation for user and assistant messages, reasoning, tool and command/file-change activity, turn footers, notices, errors, and running/completed/failed/cancelled states with accessible expandable controls.
- [x] 4.7 Implement contextual permission and structured-question cards whose enabled actions follow the unresolved request projection and become inert with a recorded outcome after resolution.
- [x] 4.8 Implement the autosizing composer with draft retention, empty-input prevention, send/steer states, acceptance correlation, cancellation, keyboard operation, and accessible status announcements.
- [x] 4.9 Implement safe workspace file-reference parsing and navigation through the existing document model, including Preview promotion, optional line reveal, ambiguous-root handling, and inert outside/traversal references.

## 5. Timeline Stability And Touch Navigation

- [x] 5.1 Implement and unit-test the semantic timeline anchor controller for pinned streaming, user scroll-away, unseen-content indication, jump-to-latest, delayed resize, and activity expansion/collapse.
- [x] 5.2 Implement older-page prepend and per-conversation reading-position restoration using item identity plus viewport offset, with tests that preserve the visible item rather than raw scroll height.
- [x] 5.3 Implement a Chat visual-viewport controller that accounts for composer height, safe areas, and visible touch-tab inset while preserving the active timeline anchor across iOS keyboard resize and dismissal.
- [x] 5.4 Extend the boot stamp, app state, tab controller, active-surface behavior, HTML, and CSS from three touch tabs to Files/Preview/Chat/Terminal while preserving per-device active-tab persistence.
- [x] 5.5 Implement live desktop/touch mode normalization so Preview or Chat remains the selected main surface, terminal dock/display state is restored, and neither surface is remounted or promoted by background agent output.
- [x] 5.6 Add responsive styling and accessibility checks for four-tab phone layouts, iPad touch mode, desktop mode, bottom safe-area spacing, hardware-keyboard navigation, focus order, and reduced-motion behavior.

## 6. End-To-End Verification And Documentation

- [x] 6.1 Add desktop Playwright coverage using the fake chat service for conversation creation/resume, streaming Markdown, tool updates, prompt steering, cancellation, permissions, questions, reconnect replay/resync, and file-link navigation.
- [x] 6.2 Add touch Playwright coverage for four-tab navigation, state continuity, software-keyboard geometry, pinned and unpinned streaming, jump-to-latest, history prepend, activity expansion, rotation, and touch/desktop mode switching.
- [x] 6.3 Add an opt-in real-OpenCode integration smoke test that uses an isolated temporary workspace and configuration to verify executable startup, SDK health, session creation/history, event normalization, abort, and clean process teardown without requiring provider credentials in the standard suite.
- [x] 6.4 Verify the existing macOS app loads and retains the web Chat surface, routes file/external links correctly, preserves titlebar inset and native navigation behavior, and requires no provider secret in Keychain; add focused wrapper tests only where host behavior changes.
- [x] 6.5 Document the OpenCode installation/authentication prerequisite, workspace and process lifecycle, direct/hub access model, agent OS-user authority, troubleshooting states, and the explicit exclusions of ACP and non-OpenCode providers.
- [x] 6.6 Run strict OpenSpec validation, unit tests, typecheck, API validation and contract tests, focused and full E2E suites, macOS `xcodebuild`, compiled binary build/smoke, and license audit; resolve every failure before marking the change complete.

## 7. Streaming Performance And Resilience Corrections

Corrections to the first implementation, which rebuilt the entire timeline on
every streamed token and left the provider event pump unsupervised.

- [x] 7.1 Replace full-timeline `innerHTML` rendering with a keyed incremental renderer that keeps one DOM node per item id, patches streaming assistant and reasoning items in place, and rebuilds only items whose shape changed; unit-test that typed question-form input, node identity, and ordering survive streaming.
- [x] 7.2 Decorate file references only within changed nodes instead of re-walking the whole timeline each frame, and delete the unused streaming Markdown renderer left behind by the first implementation.
- [x] 7.3 Coalesce provider updates in a bounded window before the replay ring — concatenating same-item text deltas, replacing repeated tool upserts, flushing urgent updates immediately — while keeping workspace confinement resolved per event at ingest.
- [x] 7.4 Classify OpenCode tool calls into semantic shapes (edit, write, read, search, fetch, todo) and render edits as diffs and file references as navigable buttons, keeping escaped text as the fallback for unknown tools.
- [x] 7.5 Supervise the provider event pump with capped backoff restart so a dead provider stream cannot leave chat silently inert, and bound per-conversation projections with an LRU that skips subscribed conversations.
- [x] 7.6 Make request identities work in non-secure contexts, resync the client after a malformed event, suppress the first transient reconnect banner, and debounce and prune presentation storage instead of writing the whole blob per scroll tick.
- [x] 7.7 Render user messages optimistically with restore-on-failure, and show elapsed turn time from an isolated ticker plus per-item timestamps on hover.

## 8. Live-OpenCode Corrections

Found by running the app against a real OpenCode installation; the fake-service
E2E suite cannot observe any of these.

- [x] 8.1 Read history from both OpenCode message stores: the v2 store serves sessions prompted through the v2 API, while sessions started in the CLI/TUI live only in the classic store and read back empty from v2. Merge both by message id, order by creation, and page locally.
- [x] 8.2 Normalize the classic `{ info, parts }` message shape, which the previous normalizer ignored entirely, so replayed user text, assistant Markdown, reasoning, and tool calls all render.
- [x] 8.3 Stop sending `order` together with `cursor` to the v2 messages endpoint — OpenCode rejects the combination with `InvalidCursorError`, which surfaced as "chat operation failed".
- [x] 8.4 Treat the classic store's `time.end` as completion so replayed reasoning and shell activity do not display as permanently "running".
- [x] 8.5 Re-sync the Preview/Chat segmented control from `setMainSurface` so the selected segment tracks the surface no matter which affordance changed it.
- [x] 8.6 Label tool file references with the workspace-relative path while keeping the absolute path as the navigation target.
