> **Archived unverified, superseded by one-trust-model
> ([#218](https://github.com/tjakobsson/uatu/pull/218)).** That change replaced
> this one's client-side revocation model (two Keychain secrets,
> cookie-disappearance detection) with server-side sessions and a single
> session-id credential, and absorbed the still-true requirements — sign-out
> revokes and forgets, every window returns to the splash, no silent re-login
> after revocation — into the main `desktop-hub-connect` spec. The remaining
> manual passes (5.3–5.6) verify behavior that no longer exists in this form,
> so this change is archived with `--skip-specs`: syncing its deltas would
> reintroduce the pre-#218 model and the removed `--local` mode.

## 1. Revocation Primitives

- [x] 1.1 Add `HubCookies.clear(for:)` in `HubAPI.swift`, deleting the `uatu_hub` cookie for a hub's host from the shared web-view cookie store, alongside the existing `inject`.
- [x] 1.2 Add `HubConnection.signOut()` in `HubRoster.swift`: delete both Keychain items, clear the web-view cookie, and set `state = .signedOut` synchronously; make repeat calls idempotent.
- [x] 1.3 Confirm `probe()` needs no new latch — with the password gone its existing silent-relogin guard falls through to `.signedOut` — and note that reasoning where the guard lives.

## 2. Sign-Out Detection

- [x] 2.1 Add a hub-origin sign-out hook to `WebViewHost.swift`: in `decidePolicyFor`, report a main-frame `POST` navigation to `<hub>/logout` and allow it.
- [x] 2.2 Add an advisory hook for a main-frame navigation to `<hub>/login`, distinct from the sign-out hook, for the window-level return to the splash.
- [x] 2.3 Add cookie-store observation (`WKHTTPCookieStoreObserver`) scoped to configured hub hosts, reporting the disappearance of `uatu_hub` as a sign-out.
- [x] 2.4 Resolve a navigated URL to a roster entry (host match against `HubRoster.shared`) so signals only fire for configured remote hubs and never for the local hub.

## 3. Window And Roster Response

- [x] 3.1 Wire the sign-out signal in `ContentView.swift` to `signOut()` on the matching connection.
- [x] 3.2 Return the window to the splash via the existing `showSplash()` on both the sign-out signal and the advisory `/login` signal.
- [x] 3.3 Observe the connection's `.signedOut` transition per window so every window showing that hub returns to the splash, not only the one where sign-out happened.
- [x] 3.4 Verify the splash card reaches `.signedOut` with its existing "Sign In…" button and that `signIn(password:)` restores both secrets and normal probing.

## 4. SPA Sign-Out Entry

- [x] 4.1 Change the switcher's sign-out entry in `src/shell/hub-nav.ts` from `fetch("/logout")` + `location.href` to a same-origin form `POST` navigation to `/logout`.
- [x] 4.2 Extend `src/shell/hub-nav.test.ts` to assert the form-POST mechanism and that local mode still omits the entry.

## 5. Verification

- [x] 5.1 Run `bun test` and the type check, plus `bun run build` (Desktop CI embeds `dist/uatu`).
- [x] 5.2 Build the desktop app (`xcodebuild -scheme UatuCodeDesktop -configuration Release`) and confirm it launches with the embedded binary.
- [ ] 5.3 Manual pass against a real remote hub — sign out from the dashboard, and separately from the in-session switcher; confirm for each that the window lands on the native splash, the card reads sign-in required, and the app issues no further authenticated requests. Record findings inline.
- [ ] 5.4 Manual pass for the multi-window case: two windows on one hub, sign out in one, confirm both return to the splash. Record findings inline.
- [ ] 5.5 Manual pass for durability and recovery: relaunch the app and confirm the hub is still signed out, then sign in from the card and confirm the hub reconnects. Record findings inline.
- [ ] 5.6 Manual pass for non-regression: the local hub still opens with no sign-out entry, and a signed-in remote hub still opens sessions without showing the login page. Record findings inline.

## Notes

This change corrects behavior introduced by
[PR #169](https://github.com/tjakobsson/uatu/pull/169) after the latest stable
tag (`v0.4.0`), so the broken behavior never shipped to users. Per the
release-note discipline in `CLAUDE.md`, the PR keeps a truthful `fix(desktop):`
title but its body must carry a Release Please override before squash merge:

```text
BEGIN_COMMIT_OVERRIDE
chore(desktop): stabilize hub sign-out before release
END_COMMIT_OVERRIDE
```

The PR closes [issue #170](https://github.com/tjakobsson/uatu/issues/170) and
should land before the open 0.5.0 release PR
([#164](https://github.com/tjakobsson/uatu/pull/164)) merges, since the issue is
on that milestone. It also resolves the stranded-tab entry on the archived
`unify-desktop-on-hub` deferred list.

`desktop/macos/**` edits trigger the path-filtered Desktop CI workflow; there is
no Swift test target, so section 5's manual passes are the Swift-side
verification of record.
