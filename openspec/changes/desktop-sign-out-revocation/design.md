## Context

The desktop is the single owner of hub credentials: `HubAPI` sends no cookies of
its own, `HubKeychain` holds the password and the current session cookie per
roster entry, and `HubCookies.inject` pushes that cookie into the WKWebView
store before a navigation to the hub origin. Sign-out, however, is a purely
web-side act today:

- The hub dashboard signs out with `<form method="post" action="/logout">`
  (`src/hub/pages.ts:324`) — a **main-frame navigation**.
- The in-session workspace switcher signs out with `fetch("/logout", {method:
  "POST"})` followed by `location.href = "/login"` (`src/shell/hub-nav.ts:175`)
  — the POST is **not** a navigation; only the follow-on GET is.

Either way the hub answers with `uatu_hub=; Max-Age=0`, so only the web view's
copy is cleared. Native state is untouched: `HubConnection.cookie` still reads a
valid value from the Keychain, `probe()` keeps returning `.connected`, and even
with the cookie gone, `probe()`'s silent re-login path
(`HubRoster.swift:167`) mints a fresh one from the stored password. The window,
meanwhile, sits on the hub's web login page — the stranded-tab item on the
archived `unify-desktop-on-hub` deferred list.

Two constraints shape the design. First, remote hubs run **their own** uatu
version, so detection cannot depend on the remote being new enough. Second, the
hub's logout is cookie removal, not key rotation — a captured cookie value still
verifies server-side (asserted in `src/hub/hub.integration.test.ts:635`), so
"revocation" here means revoking *the desktop's* ability to re-authenticate, not
invalidating the token hub-side.

## Goals / Non-Goals

**Goals:**

- Sign-out inside the web view revokes the desktop's ability to re-authenticate
  to that hub until the user signs in natively again.
- The revocation is durable across app restarts.
- Every window showing that hub returns to the native splash, not the hub's web
  login page.
- Detection works against hubs older than this change.

**Non-Goals:**

- Server-side session revocation / token versioning. Worth doing, hub-wide in
  scope, and independent of this bug.
- Any change to the local (`--local`) hub, which has no login, no `/logout`, and
  no sign-out entry.
- Reworking the splash's signed-out presentation: `SplashView`'s `.signedOut`
  card state and its "Sign In…" button already exist and simply become
  reachable.

## Decisions

### D1 — Three layered signals, two different strengths

No single observable covers both entry points across hub versions, so detection
is layered. Two signals are *authoritative* (they mean a deliberate sign-out and
trigger revocation); one is *advisory* (it means this window's session is over
and only affects the window).

| | Signal | Strength | Covers |
|---|---|---|---|
| A | Main-frame navigation POST to `<hub>/logout` | authoritative | Dashboard form; switcher after D3 |
| B | `uatu_hub` disappears from the WKWebView cookie store for a known hub host | authoritative | Any mechanism, any hub version |
| C | Main-frame navigation to `<hub>/login` | advisory | Stranded tab; expired session |

Revocation is idempotent, so A and B firing for the same sign-out is harmless —
and expected, since the dashboard path trips both.

*Alternative considered:* a `WKUserScript` or `WKScriptMessageHandler` hooking
the page's sign-out. Rejected: `WebViewHost.applyTitlebarInset` owns the user
content controller with a `removeAllUserScripts()` full replace and documents
that contract as safe only while it is the sole script; a second script means
revisiting it, and injecting native-privileged JS into every hub origin is a
larger trust surface than reading navigation and cookie state.

### D2 — Signal A allows the navigation rather than cancelling it

`decidePolicyFor` reports the sign-out and returns `.allow`. The hub still
receives the POST (so if it ever grows server-side revocation, it gets the
chance), still clears the browser cookie, and the resulting `/login` navigation
is simply superseded when the window drops to the splash. Cancelling would keep
the web-view cookie alive and require us to clear it — a strictly worse contract
for no gain.

The window's detached web view is left holding whatever it last loaded; the next
`open()` replaces it via `loadWeb`.

### D3 — The in-session switcher submits a form POST

`src/shell/hub-nav.ts` changes from `fetch("/logout")` + `location.href` to
submitting a form POST to `/logout` — exactly what the hub dashboard already
does. This makes both sign-out entry points one mechanism, lands them both under
Signal A, and drops a dependency on the fetch resolving before the location
assignment. Same-origin form POSTs send `Origin`, so the hub's CSRF check
(`isSameOriginRequest`) is satisfied the same way the dashboard's already is.

This is a forward fix, not the safety net: a hub older than this change still
uses `fetch`, which is what D1's Signal B is for.

### D4 — The latch is the absence of the stored password, not a new flag

Revocation deletes **both** Keychain items. `probe()`'s silent re-login is
already conditioned on `HubKeychain.get(account: entry.passwordAccount)`
returning a password (`HubRoster.swift:167`), so with the password gone the
existing code path falls through to `state = .signedOut` on its own — durably,
across restarts, with no new persisted state to keep in sync and nothing an
attacker with preferences access could flip back. `signIn(password:)` re-stores
both items and is the only way back, which is precisely "until the user opts
back in".

*Alternative considered:* keep the password and add a `signedOut` boolean to the
roster entry. Rejected — it leaves a re-usable credential on disk to protect a
security property with a UserDefaults flag, and the issue is explicit that
cookie-only (or flag-only) clearing is cosmetic.

Revocation also removes the cookie from the WKWebView store via a new
`HubCookies.clear(for:)`, so no live copy outlives the Keychain one.

### D5 — Why cookie-store disappearance is a safe authoritative signal

The obvious objection to Signal B is that a cookie can vanish by expiring, and
treating expiry as sign-out would break the existing "expired cookie recovers
silently" requirement. It does not apply here: `HubCookies.inject` sets no
`.expires` property, so the injected copy is a **session cookie** in the web
view's store with no natural expiry event. Server-side expiry (30 days,
`HUB_COOKIE_MAX_AGE`) is a *verification* failure surfacing as a 401 — which
still routes to the native probe and its silent re-login, untouched by this
change. A disappearance from the store is therefore a `Max-Age=0` clear in all
realistic cases.

The observer is scoped to hosts in the roster, so unrelated cookie traffic is
ignored.

One asymmetry between the two authoritative signals falls out of how cookies
are scoped, and it decides how each resolves a signal to a roster entry.
Cookies belong to a **host** and carry no port; navigations carry a full
**origin**. Two configured hubs may legitimately share a host on different
ports — routine for loopback hubs behind tunnels, and nothing in the add flow
forbids it. So:

- The navigation signal resolves by origin (scheme + host + port, with the
  scheme's default port made explicit), which is exact.
- The cookie signal resolves by host, and revokes **only when exactly one**
  configured hub has that host. With several, the disappearance genuinely
  cannot say which one signed out, and guessing would delete the wrong hub's
  credentials while leaving the signed-out one able to re-authenticate — the
  precise inversion of this change's purpose. Declining to revoke is the safe
  failure: the navigation signal still covers that setup exactly, and only the
  older-hub `fetch` path loses its net.

Same-host hubs already share one `uatu_hub` jar entry in the web view, so only
one of them can be authenticated there at a time. That predates this change and
is left alone.

### D6 — `HubConnection.state` is the broadcast; each window watches its own hub

Revocation sets `state = .signedOut` synchronously rather than waiting for the
next poll. `HubRoster.shared` is `@MainActor @Observable` and hands out one
`HubConnection` per entry, so every window observing that connection reacts at
once. A window whose `currentPage` is `.remoteDashboard(entry)` and whose
connection turns `.signedOut` calls the existing `showSplash()`. That covers the
multi-window case for free: signing out in one window does not leave a sibling
window authenticated against a hub the app has forgotten.

### D7 — Return to the splash, do not auto-present the sign-in sheet

The splash card already carries "Sign In…" for `.signedOut`. Auto-presenting the
native sheet would fire a modal in *every* affected window, and after a
deliberate sign-out the user's intent is usually to stop, not to re-enter a
password. The card is the way back.

## Risks / Trade-offs

- **Signal B fires for a store change that was not a sign-out** (a WebKit data
  wipe, a user clearing website data) → the user re-enters their password once
  from the splash card. The cost is bounded and the failure is in the safe
  direction; D5 explains why expiry is not one of these cases.
- **A hub older than this change signs out via the switcher's `fetch`** → Signal
  A cannot see it. Signal B still revokes, and Signal C still un-strands the
  window. If both A and B were somehow unavailable, the residual behavior is
  today's behavior, no worse.
- **No Swift test target exists in `desktop/macos/`** → the Swift half cannot be
  covered by automated tests in this change. Mitigation: a scripted manual
  acceptance pass against a real remote hub, recorded in `tasks.md` with
  findings, matching how prior desktop changes were verified. The SPA half is
  unit-tested in `src/shell/hub-nav.test.ts`.
- **Deleting the password is destructive and irreversible** — a user who signs
  out casually must retype it. That is the intended semantics of the word
  "sign out", and it is what the browser already does.

## Migration Plan

No migration. Nothing persisted changes shape: roster entries in UserDefaults
and Keychain accounts keep their current layout, and revocation only deletes
items that already exist. Rollback is a plain revert; a hub whose secrets were
already revoked simply shows "Sign In…" until the user signs in again.

## Open Questions

- **When** should the hub gain real server-side revocation, so logout
  invalidates the issued cookie rather than only the browser's copy? Filed as
  https://github.com/tjakobsson/uatu/issues/202 (Future milestone). Out of
  scope here — this change is the point at which the desktop stops papering over
  its absence, and it is the backstop for exactly the class of bug this change
  fixes: a client holding a token copy the hub cannot invalidate. Coarse levers
  already exist (removing a user from the config, deleting `hub.key`); what is
  missing is per-session, no-restart, self-service revocation.

  **Not** an open question, and decided here as a constraint on that future
  work: revocation MUST be per session, never per user. Signing out on one
  device MUST NOT end sessions on another — a per-user session epoch bumped by
  logout is the cheap design and is rejected for that reason, in a product whose
  premise is reaching one hub from a Mac, an iPhone, and an iPad at once. The
  shape that satisfies this is a random per-login session id in the cookie
  payload plus a pruned revocation set in the hub state dir, so logout revokes
  exactly the cookie that performed it. "Sign out everywhere" is a separate,
  later feature; a per-user epoch is the right mechanism for *that*, layered on
  top and invoked deliberately, never as the meaning of the ordinary Sign out
  button.
