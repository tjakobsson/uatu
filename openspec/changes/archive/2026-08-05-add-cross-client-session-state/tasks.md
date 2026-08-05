## 1. Hub Personal-State Store

- [x] 1.1 Define and validate the versioned personal workspace-state schema, including relative document paths and optional PTY references.
- [x] 1.2 Implement a serialized atomic Hub state store keyed by user and stable workspace id, with corruption-safe loading and owner-only state files.
- [x] 1.3 Add unit tests for missing/corrupt files, field-level partial updates, concurrent writes, user/workspace isolation, and restart persistence.
- [x] 1.4 Remove all users' personal records when a stopped workspace is forgotten, with failure behavior that cannot silently leave registry/state disagreement.

## 2. Hub Personal-State API

- [x] 2.1 Add workspace-prefixed GET and PATCH personal-state routes that the Hub handles before generic child proxying.
- [x] 2.2 Derive remote identity from the signed Hub session and local identity from the stable literal `local`; never accept a client-selected username.
- [x] 2.3 Apply origin/CSRF checks, strict field validation, and JSON error responses to personal-state updates.
- [x] 2.4 Add Hub integration tests proving auth isolation, local-mode ownership, non-proxying, token/path secrecy, partial updates, and persistence across restart.

## 3. Per-Client Watch Context

- [x] 3.1 Replace mutable watch-session browsing scope with validated scope supplied on state, SSE, search, navigation, and related requests while retaining CLI single-file constraints.
- [x] 3.2 Compute or cache repository snapshots for both supported compare targets and select them from request/subscription context rather than one session-global mutable target.
- [x] 3.3 Make document-diff and project-search requests consume the same explicit scope/compare context as the client's state stream.
- [x] 3.4 Remove or retire the state-mutating scope and compare-target POST behavior so one caller cannot alter other subscribers.
- [x] 3.5 Add unit/integration tests with concurrent subscribers using different scopes and compare targets, including invalid context and cache invalidation after file changes.

## 4. SPA Personal Resume State

- [x] 4.1 Add a client personal-state adapter for GET/PATCH with typed validation, field-level updates, write coalescing, and best-effort failure fallback.
- [x] 4.2 Load child state and personal state during boot and implement explicit URL → personal state → session default precedence without a visible intermediate navigation.
- [x] 4.3 Persist document path and Follow through their existing owner mutators while preserving direct-link Follow-off behavior.
- [x] 4.4 Persist preview mode, compare target, and Files filter through their owner mutators, and reconnect/refetch only the initiating client's contextual state when required.
- [x] 4.5 Resolve stale document and PTY references independently, preserving other valid fields and clearing a PTY reference once inventory proves it absent.
- [x] 4.6 Add unit and E2E coverage for root restore, explicit document/commit/review URL precedence, two open clients remaining independent, and another browser restoring later.

## 5. Client-Local Presentation Cleanup

- [x] 5.1 Inventory every browser localStorage/sessionStorage key and classify it as personal semantic, client presentation, transient window state, credential, or obsolete terminal hint.
- [x] 5.2 Introduce a workspace/base-path-namespaced browser presentation adapter and move retained sidebar, outline, preview-layout, and terminal-layout persistence behind it.
- [x] 5.3 Remove legacy semantic localStorage reads/writes, migration branches, shared PTY restart hints, and fallback behavior so the release performs the specified clean reset.
- [x] 5.4 Verify macOS-native width, zoom, window, and split-browser state remains in `UserDefaults` while WKWebView-owned presentation uses the workspace namespace.
- [x] 5.5 Add tests proving sibling Hub workspaces and different browser contexts do not share physical geometry.

## 6. Terminal Reconstruction Spike

- [x] 6.1 Evaluate xterm 6-compatible headless and serialization packages, document their APIs/mode coverage, and run the repository license audit before selection.
- [x] 6.2 Build a focused harness that feeds split UTF-8 and ANSI output through a server terminal model and reconstructs a fresh browser xterm at equal and different dimensions.
- [x] 6.3 Verify ordinary shell scrollback plus available `vim`/`nvim`, `htop`/`btop`, and `lazygit` alternate-screen behavior; record unsupported modes and the chosen mitigation in `design.md` before integration.

## 7. Server-Owned PTY Resources

- [x] 7.1 Refactor terminal sessions so the child server generates PTY ids and can create a PTY independently of WebSocket upgrade.
- [x] 7.2 Add authenticated POST creation to the terminal inventory API with validated initial dimensions and existing shell/cwd/environment behavior.
- [x] 7.3 Change WebSocket preparation to require an existing resource id and return distinct malformed, unknown, attached, and takeover outcomes without implicit spawning.
- [x] 7.4 Keep explicit DELETE/close termination, detached lifetime, process labels, metrics, shell-exit cleanup, and child-shutdown cleanup correct under the resource model.
- [x] 7.5 Add server and Hub-proxy integration tests for create/list/attach/detach/takeover/terminate, unknown ids, auth/origin gates, and preserved close codes.

## 8. Attach-Ready Ownership Protocol

- [x] 8.1 Add the attach-ready control frame and server state machine that ignores input and defers ownership, resize, and reconstruction until valid fitted dimensions arrive.
- [x] 8.2 Make takeover transactional: park the previous holder only after the replacement is ready, and preserve it when the prospective socket fails early.
- [x] 8.3 Update the browser terminal mount to open and fit xterm before readiness, then process reconstruction before live output and normal input.
- [x] 8.4 Add protocol tests for old-size to new-size attachment, pre-ready input, malformed/duplicate readiness, output ordering, failed half-takeover, and explicit take-back.

## 9. Stateful Terminal Reconstruction

- [x] 9.1 Attach one bounded server terminal model to each PTY and feed copied output into it while attached and detached without cross-session decoder state.
- [x] 9.2 Keep PTY and model dimensions synchronized and serialize a coherent snapshot at the attach-ready/live-output boundary.
- [x] 9.3 Remove raw byte-tail replay as the reattachment correctness path and retain only any bounded diagnostics justified by the spike.
- [x] 9.4 Add regression coverage for issue #168: fresh-client raw-mode TUI resume, alternate screen, scrollback, cursor/mode state, detached output, and large-to-small dimension changes.

## 10. Terminal Client Resource UX

- [x] 10.1 Separate local pane ids/layout from server PTY ids and replace fresh browser UUID creation with the POST resource flow.
- [x] 10.2 Namespace per-window current attachment references by workspace and remove shared hint-owner/collision-replacement behavior.
- [x] 10.3 Update the terminal picker to list every available PTY, highlight but never auto-attach the saved last-active PTY, and require explicit attach/takeover/terminate choices on a new client.
- [x] 10.4 Persist the last-active PTY reference through personal workspace state without persisting dock, dimensions, splits, or pane arrangement to Hub.
- [x] 10.5 Add browser E2E coverage for detached listing, explicit cross-client attach, takeover parking/take-back, local geometry independence, and stale PTY references after child restart; verify the same flows manually in macOS Desktop, which has no E2E harness.

## 11. Verification And Documentation

- [x] 11.1 Update architecture and self-hosting documentation with the four state lifetimes, Hub personal-state storage, request-scoped client views, and PTY resource/attachment model.
- [x] 11.2 Update state-ownership, app-URL-discipline, route-table, security, and storage tests for the new adapters and endpoints.
- [x] 11.3 Run `bun test`, `bun run typecheck`, targeted browser/Desktop tests, `bun test:e2e`, `bun run check:licenses`, and `bun run build`.
- [x] 11.4 Manually verify one account across two different-size browsers and macOS Desktop against both local and authenticated remote Hub, including issue #168's TUI resume case.
