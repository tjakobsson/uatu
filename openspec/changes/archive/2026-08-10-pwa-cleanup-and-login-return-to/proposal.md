## Why

Two P2 findings from the Codex review of
[#208](https://github.com/tjakobsson/uatu/pull/208), tracked as
[#209](https://github.com/tjakobsson/uatu/issues/209) and deferred until the
planned work landed. Both are small, independent, and need no device pass.

1. **The service worker was removed from new profiles, not from existing ones.**
   [#208](https://github.com/tjakobsson/uatu/pull/208) deleted the registration
   call and the `/sw.js` route, which stops *new* installs — but a browser
   profile that loaded uatu before that change still has the old pass-through
   worker installed and controlling its scope. Those profiles silently fail the
   `pwa-install` contract ("`getRegistrations()` resolves to an empty list"), and
   a stale worker keeps intercepting requests, which is exactly the interference
   the E2E suite blocks service workers to avoid. Nothing in `src/` mentions
   `serviceWorker` today, so no cleanup exists.

2. **A failed login forgets where you were going.** `handleLogin` parses
   `postedNext` and honours it on success, but every error branch renders
   `loginPage({ error })` with no `next` — so the re-rendered form loses its
   hidden field and the retry after a mistyped password lands on the dashboard
   instead of the page the gate bounced from. The rate-limit branch makes it
   worse: it fires *before* the body is parsed, which is precisely the
   repeated-wrong-password case.

## What Changes

**Legacy service worker cleanup**

- A one-time boot cleanup unregisters service workers left over from before
  [#208](https://github.com/tjakobsson/uatu/pull/208), scoped to the former uatu
  registration scopes (the session base path and the origin root) and matched on
  the old script path so an unrelated worker on a shared origin is never
  collected.
- Guarded for contexts where `navigator.serviceWorker` is absent — a plain-HTTP
  LAN origin is not a secure context, and uatu is reachable that way.
- Deliberately temporary: the code carries the release it can be deleted in.

**Login return-to survives form errors**

- Every HTML error render of the login page carries the validated return-to
  target, so a wrong password followed by a correct one lands where the gate
  bounced from.
- The form posts to a URL that carries the target, so the branches that answer
  *before* the body is parsed — cross-origin rejection and rate limiting — have
  it too. The hidden field stays as the POST-body carrier it is today.
- **Not changing:** validation. Every target is still run through
  `safeReturnPath` on the way in and on the way out; an invalid target still
  falls back to `/`. Nothing here widens what counts as a valid target.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `pwa-install`: the no-service-worker guarantee extends to profiles upgraded
  from a version that registered one — the app actively unregisters its own
  legacy worker rather than only declining to register a new one.
- `hub-auth`: the return-to target survives a failed login attempt, so the
  return-to guarantee covers the retry path and not only a first-try success.

## Impact

**Code**

- `src/shell/pwa.ts` — the matcher and the cleanup, wired from `src/app.ts` at
  boot. This file already owns the PWA runtime surface and is where the deleted
  `registerServiceWorker()` lived; `src/pwa/` is asset references only.
- `src/hub/server.ts` — the four HTML error renders in `handleLogin`.
- `src/hub/pages.ts` — `loginPage()` puts the target in the form action as well
  as the hidden field.

**Tests**

- `src/shell/pwa.test.ts` — the scope/script matcher as a pure function,
  including the negative case of an unrelated worker on the same origin.
- `src/hub/hub.integration.test.ts` — a wrong-password-then-retry round trip
  asserting the target survives, and a rate-limited render that still carries it.

**Release notes**

Both defects are in code shipped after `v0.4.0`
([#208](https://github.com/tjakobsson/uatu/pull/208)), so the PR keeps its
truthful `fix(...)` title and carries a Release Please override in the body.
