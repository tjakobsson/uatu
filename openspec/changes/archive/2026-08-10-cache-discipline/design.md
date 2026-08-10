# cache-discipline — design

## Context

Current state, verified in code: `spaShellResponse` serves the shell with `cache-control: no-cache` and holds a per-process `shellCache` keyed by `host:port:basePath` — safe on the assumption "a rebuild restarts the process", which holds for the compiled binary but is exactly the assumption to stop trusting once hubs keep child processes alive across developer rebuilds. Bun's HTML bundler emits content-hashed chunk filenames, and `navigation.ts` already attaches `public, max-age=31536000, immutable` on some asset paths; fixed-name routes (`/assets/icon-*.png`, `/manifest.webmanifest`, fonts) carry moderate max-ages in `routes.ts`. Hub pages (`hub/pages.ts`) set no cache headers. No client anywhere knows what build its server is running. Historical diagnosis (recorded during earlier debugging): staleness reproduced through HTML/header and shell-cache paths; the service worker was ruled out.

`shared/version.ts` already provides `{version, commitSha, commitShort}` embedded at build time — the handshake reuses it rather than inventing a parallel identity.

The stale-content hint (`shell/stale-hint.ts`) is dead in effect: since Modes were removed, `nextStaleHint` returns `current` or `null` in every branch and no code path constructs a hint. Its spec requirement in `document-rendering` still describes Review/Author modes that no longer exist.

## Goals / Non-Goals

**Goals:**
- Make "the browser ran an old build against a new server" structurally impossible (web) or loudly visible (any client).
- Pin the already-mostly-true header behavior as specified, tested invariants instead of incidental facts.
- Close the remaining reproducible dev/hub staleness path.
- Delete the vestigial stale-hint machinery and its outdated spec text.

**Non-Goals:**
- Offline support or any service-worker caching (the SW is deleted by `hub-pwa-manifest`).
- Changing cache lifetimes for fixed-name non-bundle assets (icons, manifest) beyond what correctness requires.
- Automatic client updates for native apps (they detect and report; updating is the platform's job).
- Removing the terminal-switcher e2e CDP workarounds (they also guard against Chromium request-merging in ways unrelated to this change; simplification is follow-up).

## Decisions

1. **Handshake rides `/api/state` plus a tiny unauthenticated-safe surface.** The state payload gains `build: {version, commit, apiRevision}`. The web client compares against its bundle-embedded identity on boot and on SSE reconnect (the moment a server restart becomes observable). Rationale: no new polling, and reconnect is exactly when skew appears. `apiRevision` is a hand-bumped integer for contract breaks — coarse on purpose; semver parsing of `version` is not the contract. Implementation finding: browsers CLOSE an EventSource permanently when its automatic retry itself fails — exactly the mid-restart window — so "compare on reconnect" requires the client to re-establish the stream itself (`shell/events.ts` schedules a retry whenever the source reports CLOSED). Before this change the app sat on "Reconnecting" forever after any server restart, which is what pushed users into the hard-refresh → stale-cache path.
2. **Web mismatch policy: one automatic reload, then a visible notice.** Reload is guarded by a sessionStorage marker keyed to the server identity; if the marker shows we already reloaded for this identity and still mismatch, render a persistent "client/server version mismatch" notice instead of looping. Native clients (future) get the same data and must surface the notice state; that expectation is worded transport-neutrally in the spec.
3. **Shell cache keys gain the build identity.** `shellCache` key becomes `host:port:basePath:commit` (identity available in-process). This makes the "rebuild restarts the process" assumption unnecessary rather than arguing about where it currently breaks; the audit task then confirms no other stale path remains in the dev/hub flow.
4. **Header pinning is a test, not just code.** A unit test walks the route table asserting: HTML responses (shell at `/`, shell under a base path, hub login/dashboard) carry `no-cache`; bundle-asset responses carry `immutable` and a hashed filename shape; and a static check asserts the shell HTML references bundle assets only via hashed URLs. This is what prevents regression — headers set in three different files today have no common guard.
5. **Stale-hint deletion is total.** `stale-hint.ts`, `stale-hint-mount.ts`, the `staleHint` field in `appState`, and the `applyStaleHint`/`nextStaleHint` call sites in `follow.ts`/`events.ts`/`history.ts` go; the `document-rendering` requirement is REMOVED (its behavior has not existed since Modes were removed — the spec is catching up to reality, which is why this is safe inside a no-new-features change).

## Risks / Trade-offs

- [Reload-on-mismatch interrupts a user mid-terminal-session] → Reload only fires on boot/reconnect (the session was already interrupted by the server restart); the loop guard caps it at one.
- [`apiRevision` forgotten on a breaking change] → It's a convention, not a mechanism; noted in ARCHITECTURE.md's how-to-extend recipes. The version/commit comparison still catches every build mismatch — apiRevision only adds intent ("this break was known").
- [Hub-proxied responses could strip or override headers] → The proxy passes headers through today; the header test suite runs against the hub-proxied path in integration tests, not just the direct one.
- [The historical staleness had a cause this change doesn't fix] → The audit task reproduces the dev/hub flow before and after; if a third mechanism exists, it gets found while the instrumentation (handshake) is in hand to see it.

## Migration Plan

Single release. No data migration; browsers self-correct on first revalidation. Rollback = revert.

## Open Questions

- Whether the hub dashboard should also render the client-notice on mismatch (hub pages are server-rendered, so skew there is near-impossible; default: no).
