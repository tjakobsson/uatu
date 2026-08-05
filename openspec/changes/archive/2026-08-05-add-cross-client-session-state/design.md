## Context

Hub gives every workspace a stable id and every remote request an authenticated user, but the SPA still reads semantic preferences from origin-scoped `localStorage`. Under Hub, every `/s/<workspace>/` path shares that storage namespace, while another browser or Mac has none of it. The watch child also holds one mutable scope and compare target for all SSE subscribers. Terminal panes compound the mismatch: browser-generated ids and local/session-storage hint ownership select PTYs, while a bounded raw-byte tail attempts to reconstruct a fresh xterm after reload or takeover.

The terminal symptom in issue #168 is not expected to be a slave-PTY raw/cooked transition: Uatu does not change termios on detach. A fresh xterm has instead lost alternate-screen, cursor, parser, mouse, paste, and scrollback state. Replaying an arbitrary tail can begin after mode setup or inside an escape sequence, and currently happens before the attaching client reports its dimensions.

Browser and macOS Desktop are the target clients. Future iOS/iPadOS clients constrain the boundary—semantic continuity cannot contain pixel geometry—but their native shells are out of scope.

## Goals / Non-Goals

**Goals:**

- Give one user durable semantic continuity per Hub workspace across browsers and Desktop.
- Keep active clients independent and keep all viewport-dependent presentation local.
- Remove session-global mutation for personal compare target and browsing scope.
- Make PTYs authoritative server resources with explicit create, attach, takeover, list, and terminate operations.
- Reconstruct a coherent terminal on a fresh emulator at different dimensions, including alternate-screen TUIs.
- Delete legacy semantic storage and terminal hint ownership instead of maintaining two persistence models.

**Non-Goals:**

- Live collaborative navigation, shared cursor/selection, or synchronized layouts.
- Stable per-device identities or cloud-synchronized device geometry.
- Simultaneous interactive attachment of multiple clients to one PTY.
- PTY survival across a watch-child restart; stale remembered PTY ids are tolerated and cleared.
- Restoring document scroll offsets.
- Building the iOS/iPadOS native clients in this change.

## Decisions

### D1: Four explicit state lifetimes

State is classified rather than routed through one universal store:

| Lifetime | Owner | Examples |
|---|---|---|
| Shared session resource | watch child, surfaced through Hub | documents, repositories, live PTYs |
| Personal workspace resume | Hub, keyed by user + workspace | document path, Follow, preview mode, compare target, Files filter, last PTY reference |
| Client presentation | browser storage or native preferences | widths, heights, docking, split ratios, pane arrangement, zoom, window state |
| Transient window state | memory/session storage | open search, focus, active surface, current attachment ownership |

This keeps geometry adaptable to each screen and prevents a phone or narrow browser from overwriting a Mac layout. A stable client id was rejected for now: local storage already separates physical clients, and server-side device profiles add lifecycle and naming UX without being needed for semantic resume.

### D2: Hub owns a versioned personal-workspace-state document

The Hub stores a versioned JSON document in its state directory, keyed by authenticated username and workspace id. Local mode uses the literal stable identity `local`. The stored record uses a relative document path rather than a child-process document id, because paths survive child restarts and absolute host paths must not be exposed.

The initial shape is:

```ts
type PersonalWorkspaceStateV1 = {
  version: 1;
  documentPath?: string;
  follow?: boolean;
  previewMode?: "rendered" | "source" | "diff";
  compareTarget?: "base" | "last-commit";
  filesFilter?: "all" | "changed";
  lastPtyId?: string;
};
```

The Hub intercepts authenticated `GET` and `PATCH` requests for a personal-state endpoint under the workspace prefix before the catch-all child proxy. This lets the existing `appUrl()` base-path discipline work unchanged while keeping identity and durable storage out of the child. PATCH validates known fields, ignores no unknown fields, applies partial updates atomically, and is origin/CSRF checked. Serialized mutations plus temp-file-and-rename persistence mirror the workspace registry's crash guarantees.

Putting this file in `.uatu.json` was rejected because it is personal, mutable runtime data that must not enter the repository. Giving it to the child was rejected because child restarts would lose it and the child deliberately does not know Hub users.

### D3: Explicit URL, then personal state, then session default

Boot precedence is deterministic:

1. A document pathname, commit-preview query, review-score query, or fragment-bearing explicit route wins.
2. At the workspace root, a valid personal document path and semantic preferences are restored.
3. Missing, invalid, or stale fields fall back independently to current defaults.

The SPA fetches child state and personal state concurrently, resolves stored paths against the current corpus, then renders once. Mutators PATCH changed semantic fields without waiting to update the UI. Writes are last-write-wins for future opens; personal-state changes are not broadcast and never move another already-open client.

### D4: Personal compare target and scope become request context

The child cannot retain one global compare target or scope when clients may differ. The SPA supplies compare target and scope on state-bearing requests. The watch session maintains the unscoped corpus and computes/caches review snapshots per supported compare target; each `/api/state`, SSE subscription, diff request, and search request receives the caller's context. A client changing context reconnects or refreshes its own stream rather than mutating shared child state.

Only compare target is durably stored in V1. Browsing scope is client runtime state: watched roots remain shared launch configuration, while pinning/narrowing one view cannot narrow another client's corpus. This avoids a per-subscriber mutable server object while preserving the existing single-file launch constraint.

Forwarding Hub identity into the child was rejected: request context is sufficient and preserves the child's standalone localhost model.

### D5: One client persistence adapter, namespaced by workspace

The SPA replaces scattered direct semantic `localStorage` access with a personal-state adapter. Remaining web presentation values use one client-presentation adapter whose namespace includes the base path/workspace id, preventing `/s/alpha/` and `/s/beta/` from sharing values on one Hub origin. Desktop-native geometry remains in `UserDefaults`; web-owned geometry inside WKWebView remains in the web adapter.

This release deliberately performs a clean reset. Legacy keys are neither migrated nor used as fallback, and obsolete terminal pane-id hints are removed. Maintaining compatibility would preserve the cross-workspace ambiguity the change is removing.

### D6: PTYs are server-created resources, panes are client presentation

Creating a terminal pane no longer mints a PTY UUID in the browser. An authenticated POST creates a PTY resource and returns its server id; inventory lists all live PTYs; WebSocket attach names an existing id; DELETE terminates it. A pane is only a local presentation object referring to a PTY id.

One PTY has at most one interactive attachment because its kernel window size and input stream are singular. Attaching to a held PTY requires an explicit takeover and parks the previous holder. A new client lists existing PTYs and requires an explicit attach; `lastPtyId` may highlight the prior choice but never auto-attaches or takes over. Per-window session storage may retain currently attached ids across a reload, namespaced by workspace, but shared localStorage restart hints and collision-driven id replacement are removed.

The resource stays in the watch child rather than moving the PTY process into Hub: the child already owns cwd, terminal configuration, shutdown, metrics, and the loopback security boundary. Hub continues to proxy the API and WebSocket.

### D7: Attach is a ready handshake, not immediate replay

After WebSocket upgrade, the server does not replay or resize. The fresh xterm opens and fits locally, then sends an attach-ready control frame containing its columns and rows. Only then does the server grant attachment, set the PTY and server terminal model to those dimensions, and send a coherent snapshot followed by live output. Message ordering on the server event loop establishes the snapshot/live-output boundary.

This fixes the current old-size ordering and gives future clients one protocol independent of pixels. Input is ignored until readiness completes. Takeover ownership is not transferred until the new client is ready, preventing a failed half-attach from unnecessarily parking the current holder.

### D8: Maintain server-side terminal emulator state for reconstruction

Each PTY owns a headless terminal model at the PTY's current dimensions. All output is copied once into that model whether attached or detached. On attach-ready, the model is resized, the PTY receives the new size/SIGWINCH, and the server serializes a complete reconstruction stream for the fresh client before forwarding subsequent bytes.

Implementation starts with a compatibility spike against the xterm 6 headless and serialization packages. The spike must verify normal scrollback, alternate screen, cursor placement, mouse/bracketed-paste modes where supported, UTF-8 chunk boundaries, and resize from a large to small grid using representative TUIs (`vim`/`nvim`, `htop`/`btop`, and `lazygit` when installed). The selected packages go through the existing license audit.

A bounded byte-tail replay remains useful for diagnostics but is not an accepted reconstruction mechanism. Forcing only SIGWINCH was rejected because applications need not re-emit alternate-screen and private-mode setup they believe is still active. Running `stty raw` was rejected because termios belongs to the foreground process and changing it would corrupt ordinary cooked shells.

The spike selected the exact stable pair `@xterm/headless@6.0.0` and `@xterm/addon-serialize@0.14.0`, matching the browser's xterm 6 release. The serializer preserves normal scrollback, alternate-buffer contents/state, application cursor/keypad modes, bracketed paste, focus reporting, and the basic mouse tracking modes. It does not preserve every private mode: cursor visibility/style and mouse coordinate encodings (`?1005`, `?1006`, `?1015`) are notable omissions. Integration therefore keeps a small per-PTY ledger for those demonstrated TUI requirements and appends their restoration sequences to the serialized snapshot. Model writes are drained before resize/serialization because xterm parsing is asynchronous. The package pair is pure JavaScript/MIT and passed the repository license audit; compiled-binary verification remains part of final build validation.

The integrated PTY harness verified normal shell scrollback and fresh-client alternate-screen reconstruction with every representative application installed on the development host: `nvim`, `vim`, `htop`, and `btop`. `lazygit` was not installed, so its case remains conditional in the same test and runs automatically where available. The tests detach each running TUI and assert that a newly attached client receives an alternate-buffer reconstruction; focused model tests cover split UTF-8, scrollback, cursor visibility/style, mouse encoding modes, and large-to-small resize. The mode ledger above is the mitigation for the serializer omissions rather than falling back to raw-tail replay.

## Risks / Trade-offs

- [Headless serialization does not preserve a mode required by a TUI] → Prove the supported matrix in the spike, add protocol-level reconstruction tests, and do not remove the existing path until a coherent snapshot passes those tests.
- [Per-target review snapshots increase git work] → Cache the two finite compare-target variants and invalidate both from the same watcher refresh.
- [Frequent navigation writes churn the Hub state file] → Coalesce/debounce client PATCHes while preserving flush on page lifecycle boundaries where available; serialize atomic Hub writes.
- [Two clients race personal updates] → Accept field-level last-write-wins for future opens; PATCH only changed fields so unrelated settings do not overwrite one another.
- [A stale document or PTY reference survives restart] → Resolve defensively, fall back per field, and clear stale PTY references when inventory proves absence.
- [Clean reset surprises existing users] → Keep defaults conservative and document the one-time reset; avoiding ambiguous migration is intentional.
- [Server terminal models consume memory] → Bound scrollback consistently with the browser and expose model/session counts through existing PTY metrics.
- [The change is broad] → Implement and verify personal state before replacing PTY identity, then land terminal reconstruction behind the new resource protocol.

## Migration Plan

1. Add Hub personal-state persistence and APIs without consuming them in the SPA.
2. Make compare target/scope request-scoped and teach the SPA to read/write personal semantic state.
3. Switch boot precedence and remove legacy semantic storage reads/writes in one release, producing the intentional clean reset.
4. Add server-created PTY lifecycle APIs and attach-ready protocol while retaining existing UI behavior.
5. Complete the headless-terminal spike, add coherent reconstruction, then remove byte-tail restoration, browser-created ids, shared hints, and collision fallback.
6. Verify browser and macOS Desktop against local and authenticated remote Hub, including different viewport sizes and takeover.

Rollback before step 3 is additive. After the clean-reset step, rollback restores old defaults but cannot recover discarded legacy terminal hints; PTYs continue to end with their child session as before.

## Open Questions

- Which xterm headless/serialization package versions provide the required mode fidelity with the currently pinned xterm 6 client? This is resolved by the first terminal implementation spike, not by changing the product contract.
- Whether to persist additional semantic fields later (for example pane visibility or document heading) remains deliberately deferred until browser/Desktop usage demonstrates value.
