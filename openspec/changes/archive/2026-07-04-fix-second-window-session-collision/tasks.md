# Tasks — fix-second-window-session-collision

## 1. Server: auth probe

- [x] 1.1 Add a shared `GET /api/auth` handler (beside the auth helpers in
      `src/terminal/auth.ts` or as a small factory both servers import):
      204 with `cache-control: no-store` when the request carries a valid
      cookie or `t` query token, 401 otherwise.
- [x] 1.2 Wire it into the fetch fallback in `src/cli.ts` and
      `tests/e2e/server.ts` next to the existing POST /api/auth branch.
- [x] 1.3 Unit tests: 204 via cookie, 204 via `?t=`, 401 with no/invalid
      credentials; POST behavior unchanged.

## 2. Pane-record ownership

- [x] 2.1 In `src/terminal/pane-state.ts`: split pane records (sessionStorage,
      per-window) from restart hints and layout prefs (localStorage). Boot
      resolution: own records → adopt hints → fresh. Legacy localStorage
      records are read as hints (no migration code).
- [x] 2.2 Claimant windows write their records to both stores; collision
      losers write only their own sessionStorage and never the hints.
- [x] 2.3 Update `pane-state.test.ts` for the two-store model (in-memory
      Storage stubs for both).

## 3. Client: collision recovery

- [x] 3.1 In `src/terminal/client.ts` close-before-open: probe
      `GET /api/auth`; on 204 invoke a new `onCollision` callback (or
      equivalent) instead of `showPasteTokenUI`; on 401 keep the form.
      Cap collision retry at one per attach.
- [x] 3.2 In `src/terminal/panel.ts`: handle collision by minting a fresh
      sessionId for the pane, updating the pane's own record, reconnecting,
      and leaving the shared hints untouched.
- [x] 3.3 Update the `client.ts` comment block that documents the 409
      false-positive — it is now handled, not accepted.

## 4. E2E and suites

- [x] 4.1 Two-window E2E (same Playwright context = shared localStorage,
      two pages): window 1 opens a terminal; window 2 opens the terminal and
      reaches a working shell with no paste-token form; window 1's shell
      still responds; reload window 1 → it reattaches to its original
      session.
- [x] 4.2 Auth-failure E2E still shows the form: probe 401 path (e.g. clear
      cookie + no token) renders the paste-token UI.
- [x] 4.3 Run `bun test` and the full `bun test:e2e`; fix regressions.

## 5. Docs and spec sync

- [x] 5.1 Validate (`openspec validate fix-second-window-session-collision`).
- [x] 5.2 Archive the change once it has landed (tested + merged).
