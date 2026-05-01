## Context

The browser UI is a Single-Page Application served at `/` and backed by `Bun.serve` route handlers in `src/cli.ts`. The catch-all `fetch` handler in `src/cli.ts` delegates to `staticFileResponse` (`src/server.ts:493`), which streams raw bytes for any path that resolves to a non-ignored file inside a watched root — that's what makes `<img src="./hero.svg">` work in rendered previews. The same handler also serves raw markdown source for `/README.md`, which is the proximate cause of the direct-link problem.

On the client side (`src/app.ts`), navigation between documents happens entirely through `loadDocument(id)` and DOM swaps. There is no use of `history.pushState`, `history.replaceState`, or `popstate` anywhere — `grep` confirms zero history-API references in the file. The cross-document click handler (`initCrossDocAnchorHandler`, `src/app.ts:148`) already intercepts in-app link navigation and does the right swap, but it never updates the URL. The result: from the browser's perspective, every uatu session is a single page at `/` no matter how many documents the user reads.

A recent fix ("cross-document links preserve extension and route through SPA", commit `4ef5913`) made cross-doc clicks reliable for `.adoc`/`.md` extensions, but only for in-app interception — a typed URL or shared link still falls through to the static fallback.

The watch session model (`/api/scope` POST in `src/cli.ts:91`) supports two scope kinds: `folder` (default) and `file` (pinned). When pinned, the sidebar contains exactly one document and `/api/document?id=<other>` returns 404. The new direct-link behavior must respect that.

## Goals / Non-Goals

**Goals:**
- The address bar reflects the document currently rendered in the preview, at all times.
- Direct top-level navigation to `/<doc-path>` (typed URL, refresh, bookmark, shared link) renders that document in the SPA, not the raw file source.
- Browser back/forward steps through the user's reading path within the SPA, undoing user-initiated selections only — not file-system-driven follow-mode auto-switches.
- Arriving via a direct link disables follow mode for the session, so a file change does not yank the user away from the document they explicitly asked to see.
- All existing capabilities (cross-doc click interception, asset serving, follow-mode auto-switch, pin scope, fragment scrolling) keep working unchanged.

**Non-Goals:**
- No new server routes. The dispatch decision happens inside the existing catch-all handler.
- No URL grammar for pin state. Pin remains a server-side session concept; the URL grammar stays "one path = one selected doc".
- No URL grammar for follow state. Follow remains a per-session toggle; the URL does not encode it.
- No deep-link-into-arbitrary-anchor support beyond what fragments already provide (we reuse the existing `user-content-`-aware scroll logic).
- No persistence of history state across page reloads beyond what the browser already does natively (back-forward cache is fine; we do not implement bespoke session restore).
- No change to the static-file fallback's security posture. The Accept-based dispatch happens before the security checks, so traversal/symlink/secret rules continue to apply unchanged.

## Decisions

### D1. Server uses `Accept`-header content negotiation to choose SPA-shell vs. raw-bytes

When the catch-all `fetch` handler is invoked:
1. Parse the request's `Accept` header. If `text/html` (or `*/*` from a top-level browser navigation, but in practice browsers send explicit `text/html,application/xhtml+xml,...`) outranks the document's natural content type, treat the request as a **navigation request**.
2. For navigation requests: resolve the path against watched roots using the same logic the static fallback uses. If it resolves to a known viewable document (markdown, asciidoc, or text — i.e. `kind !== "binary"` AND it appears in the current scope's index), return the SPA shell — the same `Response` that `/` returns today.
3. Otherwise (Accept does not prefer HTML, OR path resolves to a binary file, OR path does not resolve at all under the navigation rules): fall through to today's `staticFileResponse` unchanged.

**Why `Accept` and not a path namespace:**
- A path namespace (e.g. `/doc/<path>`) would change every URL the user might paste, and the address bar would carry a `/doc/` prefix that is meaningless to anyone who didn't read the docs.
- `Accept` is exactly the signal browsers send to disambiguate "I'm a top-level navigation" from "I'm an `<img src>` sub-resource fetch". Browsers send `text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8` for top-level navigations and `image/avif,image/webp,*/*;q=0.8` (or similar) for `<img>` requests. The same URL serving different bytes for different intents is exactly what content negotiation is for.
- This keeps every existing asset URL working: an `<img src="./hero.svg">` rendered in a preview still receives the SVG bytes; only top-level navigations get rerouted to the SPA shell.

**Alternative considered:** path namespace (`/doc/<path>`) — rejected for the URL-aesthetics and migration reasons above.

**Alternative considered:** `Sec-Fetch-Dest: document` header — modern browsers send this and it's even more precise than `Accept`, but it is not universal across older Safari versions and it doesn't gain us anything beyond what `Accept` already disambiguates here. We keep `Accept` as the primary signal; we may consult `Sec-Fetch-Dest` if cross-checking is needed but it's not required.

### D2. Client uses `pushState` for user actions, `replaceState` for follow auto-switches

| Trigger | History action |
|---|---|
| Initial boot (page load) | `replaceState` to current URL (idempotent; ensures `state.docId` is populated for popstate) |
| User clicks a doc in the sidebar tree | `pushState` |
| User clicks a cross-document link in the preview | `pushState` |
| User pins/unpins (no selection change) | no history action |
| Follow mode auto-switches to a newly changed doc | `replaceState` |
| `popstate` fires (back/forward) | re-select the document for the new URL; **no** `pushState`/`replaceState`; disable follow mode if it was on (same rule as a sidebar/cross-doc click) |

**Rationale for replaceState on follow auto-switch:** the URL must remain truthful — what the address bar shows is what's on screen — but a follow-driven switch is not a user navigation event, so it must not pollute history. If we used `pushState`, the back button would scrub through every file change that fired since the user last clicked something, which is irritating and meaningless. Replace keeps the URL accurate without growing history; back still undoes the user's last actual click.

**Rationale for replaceState on initial boot:** the SPA needs `history.state` to carry the document ID so `popstate` events have an unambiguous target without re-resolving the path each time. The initial entry has `state === null` until we set it.

### D3. Direct-link arrival forces follow off, regardless of CLI default

When the SPA boots:
- If `location.pathname === "/"` → follow follows the CLI default (`/api/state`'s `initialFollow`), today's behavior preserved.
- If `location.pathname` resolves to a known document → `appState.followEnabled = false`, regardless of `payload.initialFollow`. The default doc selection is overridden by the URL-derived doc.

The user can still toggle follow on after arrival; the catch-up behavior of the existing follow toggle (`src/app.ts:263`) handles that.

**Rationale:** a direct link is an explicit "show me this" intent. Follow mode says "show me whatever changes next". They are mutually contradictory; the link wins because it was the most recent explicit signal and because the link's target is what the user expected to see when they pressed Enter or clicked.

### D4. Direct link to unknown / out-of-scope doc → SPA shell + empty preview, not 404

Two sub-cases:
1. **Unknown path** (not under any watched root, or filtered out): server has no way to know whether the SPA shell is the right answer (a typo could match nothing). Approach: navigation requests for paths that do not resolve to a viewable document return today's static-fallback response (which is `404 Not Found`). The SPA shell is *not* served for unresolvable paths — the user gets the same plain 404 they get today. We're solving the "I asked for a real doc and got raw bytes" case, not the typo case.
2. **Path resolves to a viewable document but the server is pinned to a different file**: the navigation request returns the SPA shell. The shell boots, fetches `/api/state`, sees `scope.kind === "file"` with a different `documentId`, and renders the empty-preview state with a message like "Session pinned to `<other-file>`. Unpin to view other documents." The sidebar still works (it shows just the pinned file); the user can unpin and the URL-derived doc selection retries.

**Why not auto-unpin on a direct link?** Pin is an intentional state — the user clicked pin to narrow the session, often to keep follow off and prevent unrelated swaps. Silently dropping pin because someone shared a link would surprise them. Reject is the safer default; the message tells them how to recover.

**Why not hard 404 for unresolvable paths under the SPA?** The SPA shell is heavier than a 404, and serving it for any-path-the-user-typed leaks information about whether a path *might* be a valid SPA route. Today's static fallback already returns 404 for misses; we keep that behavior for navigation requests too.

### D5. Fragment handling reuses `scrollToFragment` from the cross-doc handler

When the SPA boots with `location.hash`, after the document loads, call the same `scrollToFragment(rawId)` helper (`src/app.ts:243`) the cross-doc click handler already uses. It mirrors the `user-content-` prefix sanitize adds to heading ids, so a URL like `/guides/setup.md#installation` lands on the right heading without authors knowing about the prefix.

### D6. Encoding: `encodeURIComponent` per path segment

URLs are constructed as `"/" + relativePath.split("/").map(encodeURIComponent).join("/")`. Decoding mirrors `initCrossDocAnchorHandler`'s pattern: `decodeURIComponent` on the resolved pathname, with a try/catch around it so malformed percent-encoding fails silently rather than crashing. This matches the existing security posture of `resolveStaticFileRequest` (`src/server.ts:431`).

### D7. State payload shape unchanged

We deliberately keep `/api/state` unchanged. The "force follow off on direct link" decision is purely client-side: the client compares `location.pathname` against the document index and overrides `appState.followEnabled` after parsing the payload. No new server field, no schema migration, no contract change for clients on older binaries.

## Risks / Trade-offs

- **[`Accept` header dispatch is heuristic]** → For correctness we rely on browsers actually sending `text/html` first for top-level navigations and not for sub-resource fetches. This is well-established behavior across all current browsers; the failure mode would be a non-browser HTTP client that requests a doc path with `Accept: text/html` and gets the SPA shell instead of raw markdown. Mitigation: this is exactly what we want for shared-link semantics anyway. If a tool needs raw bytes, it can send `Accept: text/markdown` or `Accept: */*` (most curl invocations send `*/*`, which we'll treat as non-HTML-preferring). Document the Accept-based dispatch in the spec so the contract is explicit.

- **[Bookmarklet / curl users get raw markdown when they expect rendered HTML]** → Curl with `Accept: */*` falls through to static-fallback raw bytes. That's actually the behavior power users expect from `curl http://127.0.0.1:NNNN/README.md`. Document this asymmetry in the spec (curl gets raw, browser gets rendered) so it's intentional, not surprising.

- **[Refresh during a follow-mode session preserves the auto-switched URL, then forces follow off]** → If the user has follow on and a file change auto-switches the preview to `setup.md` (URL is now `/setup.md` via replaceState), then refreshes, the page re-boots, sees `/setup.md` in the URL, and forces follow off (D3). The user's follow preference is silently dropped. This is the correct behavior under D3's model — refresh is a top-level navigation, indistinguishable from a typed URL — but worth calling out so we don't misread bug reports later.

- **[History entries grow unbounded during a long session]** → Every doc click pushes one entry. For a long browsing session this could grow the back stack to dozens of entries. Browsers handle this fine and users don't pay attention to back-stack length. No mitigation needed.

- **[Asset URLs that happen to look like doc paths]** → A repo with `<img src="README.md">` (silly but possible) would still serve the SVG/binary bytes when fetched as an image because `<img>` requests don't send `text/html` first. The same path serves different bytes by intent — that's content negotiation working as designed.

- **[Pinned sessions can be linked to but the link is dead until unpin]** → Sharing a link to `/setup.md` while the recipient's server is pinned to `README.md` produces a "Session pinned" message. This is a real friction point but the alternative (auto-unpin on direct-link arrival) silently violates the pin contract. We accept the friction; the message is the recovery path.

## Migration Plan

No data migration. No CLI flag changes. No URL contract changes for existing users (everyone keeps using `/` as today; new behavior only activates when the URL is something other than `/`).

Rollout is a single PR on the `browser-behaviour-and-direct-links` branch. No staged rollout needed — uatu is a local dev tool, not a hosted service.

Rollback strategy: revert the PR. Existing CLI behavior, existing asset serving, existing cross-doc click interception are all unchanged; the new behavior is purely additive on top.

## Open Questions

- **Should `--no-follow` at the CLI override the direct-link "force follow off" rule?** They both want follow off, so the result is the same. No semantic conflict, no decision needed.
- **Should we surface the "session pinned" recovery state with an actual unpin button in the empty-preview message?** Worth considering as a follow-up but not required for this change. The pin button in the preview header is already visible (or will be once the pinned doc loads); the empty-state message can simply point to it.
