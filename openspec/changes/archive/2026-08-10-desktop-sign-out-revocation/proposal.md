## Why

Signing out of a remote hub inside UatuCode Desktop does not sign you out. The
web view's cookie copy is cleared, but the native layer keeps the Keychain
cookie (which still authenticates state probes) and the Keychain password
(which silently re-logs-in on the next probe by design). The window is left
stranded on the hub's web login page while the app quietly stays authenticated
to that hub. The same action in a browser works correctly, so the desktop
diverges from the security semantics users already learned. 0.5.0's headline is
remote-hub connect and its release bar ends with "sign out securely"; this is
that guarantee not holding, in that exact flow.

Reported from dogfooding [PR #169](https://github.com/tjakobsson/uatu/pull/169)
and independently by Codex review
([comment](https://github.com/tjakobsson/uatu/pull/169#discussion_r3722041054)),
tracked as [issue #170](https://github.com/tjakobsson/uatu/issues/170), and
recorded in the archived `unify-desktop-on-hub` deferred list.

## What Changes

- **Sign-out becomes a native, observed act.** The desktop detects a sign-out
  performed inside the web view — from the hub dashboard's Sign out form or the
  in-session workspace switcher's entry — instead of letting it pass through as
  an ordinary navigation.
- **Revocation clears both secrets.** An observed sign-out deletes the hub's
  Keychain cookie **and** password, and removes the hub cookie from the web
  view's cookie store. Clearing the cookie alone is cosmetic while a stored
  password can silently re-authenticate.
- **Silent re-login is latched off until the user opts back in.** With no stored
  password there is nothing to re-login with, so the roster's existing
  `signedOut` state becomes reachable and durable across app restarts; the
  splash card flips to its existing "Sign In…" affordance. Signing in from the
  native sheet is the only way back.
- **The window returns to the native splash** instead of stranding on the hub's
  web login page — including for windows other than the one where sign-out
  happened, and for a session whose cookie simply expired.
- **The in-session sign-out entry submits a form POST** to `/logout` (matching
  what the hub dashboard already does) rather than a `fetch()` the wrapper
  cannot see as a navigation. A cookie-store observer covers hubs older than
  this change, where the entry is still a `fetch()`.
- Non-goal: server-side session revocation. The hub's logout is cookie clearing,
  not key rotation — a captured cookie value still verifies. Changing that is a
  hub-wide concern (token versioning/rotation) and is out of scope here.

## Capabilities

### New Capabilities

None. The behavior belongs to the existing desktop hub-connect capability.

### Modified Capabilities

- `desktop-hub-connect`: the native layer must observe web-view sign-out and
  revoke both stored secrets; silent re-login gains an explicit "unless signed
  out" bound; a window whose hub session ends returns to the splash rather than
  showing the hub's web login page.
- `hub-dashboard`: the in-session workspace switcher's sign-out entry performs a
  form POST navigation to `/logout`, so that a native wrapper can observe the
  act rather than only its side effects.

## Impact

**Desktop (`desktop/macos/UatuCodeDesktop/`)**

- `WebViewHost.swift` — a sign-out hook on the navigation delegate; observation
  of the hub cookie store.
- `HubAPI.swift` — `HubCookies.clear(for:)` alongside `inject`; a cookie-store
  observation seam.
- `HubRoster.swift` — `HubConnection.signOut()` revocation, and the
  password-absence latch that keeps `probe()` from silently re-logging-in.
- `ContentView.swift` — route the sign-out signal to revocation, and return the
  window to the splash when its hub's session ends.
- `SplashView.swift` — no change expected: the `.signedOut` card state and its
  "Sign In…" button already exist and become reachable.

**SPA (`src/shell/hub-nav.ts`)** — the switcher's sign-out entry changes from
`fetch("/logout")` + `location.href` to a form POST submission; covered by
`src/shell/hub-nav.test.ts`.

**Not affected:** the hub server. `/logout`, its CSRF check, and the cookie-clear
response are unchanged; `src/hub/auth.ts` and `src/hub/server.ts` stay as they
are.

**Verification:** the desktop tree has no Swift test target, so Swift-side
verification is a build plus a scripted manual pass against a real remote hub.
The SPA change is unit-tested. `desktop/macos/**` edits trigger the
path-filtered Desktop CI workflow, which needs `bun run build` output to embed.
