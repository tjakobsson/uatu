# cache-discipline — tasks

## 1. Pin the header invariants

- [x] 1.1 Audit every HTML-serving path (shell at `/`, shell under base path, static fallback HTML, hub login/dashboard) and set `Cache-Control: no-cache` where missing (hub pages notably).
- [x] 1.2 Audit bundle-asset serving: confirm hashed filenames from the bundler, attach `immutable` headers on every bundle-asset path (JS, CSS, woff2), leave fixed-name icon/manifest lifetimes as-is.
- [x] 1.3 Add the guard tests: route-table walk asserting HTML `no-cache` + asset `immutable`/hashed-shape; static check that the shell HTML references only hashed bundle URLs; run the header assertions against the hub-proxied path in an integration test.

## 2. Build-keyed shell cache + staleness audit

- [x] 2.1 Key `shellCache` in `src/server/navigation.ts` by build identity (commit from `shared/version.ts`) in addition to host/port/basePath.
- [x] 2.2 Reproduce the historical dev/hub staleness flow (rebuild while hub children live; hard-refresh vs normal navigation) and verify it is closed; document the found mechanism in the PR description.

## 3. Version handshake

- [x] 3.1 Add `build: {version, commit, apiRevision}` to the state payload (server side; `apiRevision` starts at 1, documented in ARCHITECTURE.md's extend recipes).
- [x] 3.2 Embed the client build identity at bundle time; compare on boot and on SSE reconnect.
- [x] 3.3 Mismatch policy: one automatic reload per observed server identity (sessionStorage guard), then a persistent visible stale-client notice; unit-test the guard's loop protection.

## 4. Delete the vestigial stale-hint machinery

- [x] 4.1 Remove `src/shell/stale-hint.ts`, `stale-hint-mount.ts`, the `staleHint` appState field, and the `applyStaleHint`/`nextStaleHint` call sites in `follow.ts`/`events.ts`/`history.ts`; delete their tests.
- [x] 4.2 Confirm no e2e references the hint; update `CLAUDE.md`'s shell folder listing.

## 5. Verification

- [x] 5.1 Full `bun test` + `bun test:e2e` green.
- [x] 5.2 Manual: rebuild server mid-session → client reloads once and matches; simulate persistent mismatch (hand-edited identity) → notice appears, no loop.
- [x] 5.3 Release-note prep: internal-hardening entry (chore-scoped unless a user-visible fix emerges from the audit; then a truthful `fix` entry describing the stale-UI symptom).
