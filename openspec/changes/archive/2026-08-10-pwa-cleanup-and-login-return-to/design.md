## Context

Two unrelated defects from the same review
([#209](https://github.com/tjakobsson/uatu/issues/209)); they share a change only
because they are small and ship together.

**Legacy worker.** [#208](https://github.com/tjakobsson/uatu/pull/208) removed
the `navigator.serviceWorker.register()` call and the `/sw.js` route. Removing
the registration *call* does not remove an *existing* registration: the browser
keeps the installed worker and it keeps controlling its scope until something
unregisters it or the script 404s on an update check — and update checks are not
guaranteed to run promptly. `grep serviceWorker src/` finds nothing outside
tests, confirming no cleanup exists. `tests/e2e/pwa.e2e.ts:43` already asserts
`getRegistrations()` is empty; a fresh Playwright profile passes it trivially,
which is why the gap went unseen.

**Login return-to.** `handleLogin` (`src/hub/server.ts:106-193`) computes
`nextTarget` from `?next=` at the top and parses `postedNext` from the form body,
and the success path honours whichever it has. The four HTML error responses do
not:

| Line | Branch | Has the target? |
| --- | --- | --- |
| `:123` | cross-origin rejection | No — fires before the body is read |
| `:133` | rate limited | No — fires before the body is read |
| `:157` | malformed body | No — the parse threw |
| `:166` | invalid credentials | `postedNext` is available, but unused |

Only the last of those can be fixed by "pass `postedNext` through". The other
three answer before the body exists, and the form posts to a bare `/login`, so
the URL has no target either.

## Goals / Non-Goals

**Goals:**

- Upgraded profiles converge on the no-service-worker state without user action.
- The return-to target survives every login-form error, including the two that
  answer before the body is parsed.
- Cleanup code that is trivially deletable, with the deletion point written down.

**Non-Goals:**

- Reintroducing a service worker in any form, or offline behaviour.
- Changing what counts as a valid return-to target. `safeReturnPath` is the
  rule, unchanged.
- The JSON login path. Native clients have no page to return to and no form to
  re-render; their error shapes stay exactly as they are.
- Anything about hub session lifetime, revocation, or CSRF.

## Decisions

### 1. Identify the legacy worker by scope *and* script, not by "everything"

`getRegistrations()` returns every registration the page's origin can see.
Unregistering all of them would be wrong on a hub origin, which by design hosts
several apps' worth of paths, and would make uatu the kind of neighbour it would
not want. The matcher requires **both**:

- scope is the session's own base path or the origin root — the two scopes uatu
  ever registered under; and
- the registration's script path ends in the old script name (`/sw.js`), read
  from `active ?? waiting ?? installing`.

The script check is what makes this safe: an unrelated worker at the origin root
survives, and only a registration that looks like uatu's own is collected.

The matcher is a pure function over `{ scope, scriptURL }` so it is unit-testable
without a service worker environment — including the negative cases, which are
the ones worth guarding.

*Alternative considered:* unregister everything in scope, on the theory that
uatu owns its origin. Rejected — the hub makes that assumption false, and the
tighter rule costs one comparison.

### 2. Guard the API, and never let the cleanup affect boot

`navigator.serviceWorker` is `undefined` outside a secure context. uatu is
routinely served over plain HTTP to a LAN address, which is not one — so an
unguarded property access throws during boot on a real deployment path.

The cleanup is therefore: feature-detect, fire and forget, swallow errors. It
returns nothing anyone awaits, and a rejected `unregister()` is not worth
surfacing to a user who cannot act on it. Boot must not gain a new way to fail
for the sake of a cleanup for a worker most profiles never had.

### 3. It lives in `src/shell/pwa.ts`, not a new module

That file already owns the PWA runtime surface, its header already explains why
there is no service worker, and it is where the deleted `registerServiceWorker()`
lived — the cleanup is the removal's other half and belongs beside it. `src/pwa/`
is asset references only per the folder map, and holds nothing but a test that
reads the manifest and icons off disk; putting runtime code there would split one
concern across two folders to no end.

Cost: `src/shell/pwa.ts` joins the `app-url-discipline` allowlist, because the
matcher needs the literal `/sw.js` — it *matches* a historical script path
rather than building a URL to request, and it must match at the origin root as
well as under the base path, which `appUrl()` cannot express. The allowlist
entry says exactly that.

### 4. It is temporary, and says so in code

The section carries a comment naming the release that deletes it: 0.7.0, two
minors after the 0.5.0 that carries it, by which point no reachable profile can
predate [#208](https://github.com/tjakobsson/uatu/pull/208). Without a number
this becomes permanent scaffolding whose reason has been forgotten. Removing it
is deleting one section and one call.

### 5. The login form carries its target in the action URL as well as the body

The two pre-parse branches can only have the target if it is somewhere readable
before the body: the request URL. So `loginPage({ next })` renders
`action="/login?next=<encoded>"` when it has a target, and keeps the hidden
`next` input it renders today.

`handleLogin` already computes `nextTarget` from `?next=` on the way in, for
every method — so with this change the cross-origin and rate-limit branches
simply render `loginPage({ next: nextTarget })` and are correct with no
restructuring. After the body is parsed, `postedNext` takes precedence when
present, matching the success path's existing precedence.

Belt and braces is deliberate: the hidden field is what the POST body carries
today and what `hub.integration.test.ts:226` asserts, and the query is what
survives a branch that never reads the body. Both are validated by
`safeReturnPath` — on render and again on use — so an attacker-supplied value is
normalised to `/` before it can be reflected into the page or acted on.

*Alternative considered:* parse the form body before the rate-limit check, so
`postedNext` is available everywhere. Rejected — it inverts the limiter's
purpose, which is to answer cheaply before doing work for a client that has
already failed repeatedly.

*Alternative considered:* stash the target in a short-lived cookie at the gate.
Rejected — it adds state, a lifetime question, and a cross-tab interference mode
for something the URL already carries perfectly well.

### 6. One helper, used by every error branch

A single `errorPage(message, status, next)` closure inside `handleLogin` renders
the HTML failures, so the target cannot be forgotten by a branch added later —
the class of defect being fixed. The JSON branches stay as they are.

## Risks / Trade-offs

- **The cleanup unregisters something it should not.** → Two independent
  conditions (scope *and* script path), both unit-tested including the negative
  case. The worst realistic outcome is a stale uatu worker surviving, which is
  the status quo.

- **The legacy path is hard to E2E honestly.** `/sw.js` no longer exists, so the
  suite cannot install the real legacy worker to then remove it. → Unit-test the
  matcher directly, and assert the boot wiring calls the cleanup; the existing
  `tests/e2e/pwa.e2e.ts` no-registration assertion continues to guard the
  fresh-profile case. Do not fake a `/sw.js` route back into the server to make
  an E2E possible — that would reintroduce the thing that was removed.

- **The target now appears in the URL, so it lands in server logs and history.**
  → It is a same-origin path the user just navigated to, already present in the
  gate's redirect (`/login?next=…`) today. No new exposure.

- **Reflecting a target into the form is a reflection surface.** → It is
  `safeReturnPath`-validated before render and HTML-escaped by `loginPage`, and
  an invalid value becomes `/` rather than being echoed. The spec pins this with
  its own scenario.

## Migration Plan

No data, no schema, no config. The service worker cleanup is self-migrating:
affected profiles converge on their next load, unaffected profiles do nothing.
Rollback is a revert, and a reverted cleanup simply leaves legacy workers where
they were.

## Open Questions

- ~~**Which release deletes the cleanup?**~~ Resolved: this work lands in the
  open 0.5.0 release train, so the marker written into the code is "remove once
  0.7.0 ships" — two minors on, by which point no reachable profile can predate
  [#208](https://github.com/tjakobsson/uatu/pull/208).
