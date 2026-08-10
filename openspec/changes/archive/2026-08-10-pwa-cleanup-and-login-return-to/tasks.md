## 1. Legacy service worker cleanup

- [x] 1.1 Add a pure matcher over `{ scope, scriptURL }` to `src/shell/pwa.ts` — true only when the scope is the session base path or the origin root **and** the script path ends in the old `/sw.js` name
- [x] 1.2 Add the cleanup entry point beside it: feature-detect `navigator.serviceWorker`, enumerate `getRegistrations()`, unregister only matches, swallow errors, and return nothing anyone awaits
- [x] 1.3 Write the deletion condition into the section header as a comment naming the release it can be removed in — 0.7.0 (design.md open question, now resolved)
- [x] 1.4 Call the cleanup from boot in `src/app.ts`, positioned so nothing waits on it
- [x] 1.5 Add `src/shell/pwa.test.ts` covering: base-path scope match, origin-root scope match (including from a base-path page), a sibling session's scope, a matching scope with a foreign script path, and a registration with no worker attached
- [x] 1.6 Allowlist `src/shell/pwa.ts` in `src/shared/app-url-discipline.test.ts` — the matcher holds a `/sw.js` literal it compares against rather than requests — and drop the stale service-worker mention from `src/shared/app-url.ts`'s header
- [x] 1.7 Confirm `tests/e2e/pwa.e2e.ts`'s no-registration assertion still passes unchanged on a fresh profile

## 2. Login return-to across form errors

- [x] 2.1 Make `loginPage()` in `src/hub/pages.ts` render `action="/login?next=<encoded>"` when it has a target, keeping the existing hidden `next` input
- [x] 2.2 Add a single HTML-error render helper inside `handleLogin` (`src/hub/server.ts`) taking message and status and closing over the target, so no future branch can omit it
- [x] 2.3 Route the two pre-parse branches — cross-origin rejection and rate limit — through it with the URL-derived target
- [x] 2.4 Route the two post-parse branches — malformed body and invalid credentials — through it, narrowing the target to `safeReturnPath(postedNext)` once a posted value exists
- [x] 2.5 Confirm every target is `safeReturnPath`-validated before it reaches `loginPage`, so an invalid value renders as no target rather than being echoed back
- [x] 2.6 Leave the JSON branches untouched — native clients have no form to re-render
- [x] 2.7 Collapse the success redirect onto the same resolved target, so the redirect and the error re-render can no longer disagree

## 3. Coverage

- [x] 3.1 Extend `src/hub/hub.integration.test.ts` with a wrong-password-then-retry round trip: bounce from a session path, fail once, assert the error page still carries the target, then succeed and assert the redirect lands on the session path
- [x] 3.2 Add a rate-limited render case asserting the target survives a response that fires before the body is parsed, driven through a forwarded-for hop so it fills its own bucket and leaves the shared one alone
- [x] 3.3 Add a negative case: a login failure with an invalid return-to value renders no target, and the subsequent successful login lands on `/`
- [x] 3.4 Assert the login page's form action carries the target, not just the hidden field
- [x] 3.5 Confirm the new tests fail against the unfixed source before trusting them — this repo has shipped vacuous tests before
- [x] 3.6 Run `bun test` and `bun test:e2e`

## Local E2E environment note

`bun test:e2e` finishes 284 passed / 2 failed on macOS, and both failures
reproduce with this change fully stashed — they belong to the tree, not to this
work. CI is green on `main` at `0554851`, the commit this branch starts from.

- `find.e2e.ts` "⌘G steps matches" — the chord is `ControlOrMeta+g`, which CI
  (ubuntu-latest) resolves to `Ctrl+G` and macOS resolves to `⌘G`, where the
  page never sees it.
- `document-tree.e2e.ts` "follow on with a nested default" — waits up to 15s for
  a polling watcher to observe a future-dated `utimes`.

Worth filing separately as macOS-local E2E gaps; explicitly out of scope here.

## Conventions for this change

Work item A ([#181](https://github.com/tjakobsson/uatu/issues/181),
[#183](https://github.com/tjakobsson/uatu/issues/183),
[#191](https://github.com/tjakobsson/uatu/issues/191),
[#192](https://github.com/tjakobsson/uatu/issues/192)) is the sibling change
`touch-scroll-surface-integrity`. Both land in **one PR** — main is squash-only
with required checks, so a second PR would leave the other branch behind and
re-run the full validate cycle.

The PR body closes this work with
`Closes https://github.com/tjakobsson/uatu/issues/209`, alongside the four
separate `Closes` lines work item A needs — one keyword per issue, since a
comma-joined list only closes the first. Verify each issue actually closed after
merge.

Both defects are in code shipped after `v0.4.0`
([#208](https://github.com/tjakobsson/uatu/pull/208)), so the PR keeps its
truthful `fix(...)` title and carries a Release Please override in the body:

```text
BEGIN_COMMIT_OVERRIDE
chore(pwa): stabilize service worker removal and hub login return-to before release
END_COMMIT_OVERRIDE
```

If both changes ship under one squash commit, the two overrides collapse into
whichever single subject the PR body declares — decide that when the PR is
written, and keep it to one `chore(...)` line so Release Please does not emit two
entries for one commit.

Archiving both changes is the branch's **last** commit, inside the same PR, via
the `openspec-archive-change` skill — merging with a change still active forced a
follow-up archive PR last time
([#226](https://github.com/tjakobsson/uatu/pull/226)).
