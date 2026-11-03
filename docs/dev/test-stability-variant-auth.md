# Variant-boundary test: await workspace authentication

## Cause

[CI run 41601591120](https://github.com/tjakobsson/uatu/actions/runs/41601591120/job/125801457809)
retried `a variant without a model is refused at the boundary`: its initial
request returned 401 instead of the expected 400. The unchanged case reproduced
this locally once in ten attempts on Bun 1.4.4, with four workers and no retries.

Navigation with a URL token starts a fire-and-forget `POST /api/auth` that promotes
the token into the workspace cookie. Navigation completion does not guarantee
that promotion has finished. The test's subsequent `page.request.post` shares
the browser cookie jar, but does not have the page's session-storage credential.
It can therefore hit authentication before reaching variant validation.

Holding the actual auth request confirmed the mechanism: the identical prompt
returned 401 / `authentication required` before promotion and 400 /
`variant requires a model selection` after successful promotion completed.

## Test-only change and regression

The original test now waits for the actual auth POST's successful response and
completion before issuing the variant request. Its title, same-origin header,
prompt, expected 400 and semantic JSON assertion remain intact. No token is added
to the prompt, no cookie is copied, and no product authentication is changed.

The regression holds real auth delivery through a route gate. A callback after
the actual awaited navigation supplies a second gate; the regression verifies
that shared setup is still incomplete while auth remains held. It asserts the
unauthenticated 401, releases promotion in `finally`, completes authentication,
and retains the authenticated 400/JSON assertions.

Independent review caught an earlier regression schedule that could falsely
pass: auth could be released before navigation completed. The corrected version
was mutation-tested by removing only the helper's auth wait while preserving the
navigation callback. Captured source snapshots and their diff were checked before
execution. All three attempts failed the explicit setup-completion assertion,
not a timeout. Restoring the exact fixed source passed both cases ten times each.
Earlier timeout-only mutation attempts are not counted as causal proof.

## Verification

macOS, existing locked dependencies and cached browsers. Prepend the approved
task-local runtime directory to `PATH`; `bun --version` must report `1.4.4`.
Default test budgets were unchanged; all commands used zero retries.

```sh
# Original unchanged case: 9 passed, 1 failed with the CI's exact 401 mismatch.
bun run test:e2e tests/e2e/chat-requests.e2e.ts --project=e2e \
  --grep 'a variant without a model is refused at the boundary' \
  --repeat-each=10 --workers=4 --retries=0 --reporter=line

# Corrected regression with navigation-only helper mutation: 3 assertion failures.
bun run test:e2e tests/e2e/chat-requests.e2e.ts --project=e2e \
  --grep 'a variant boundary check waits for delayed workspace cookie promotion' \
  --repeat-each=3 --workers=4 --retries=0 --reporter=line

# Exact fixed source restored: 20 passed, 13.1 seconds.
bun run test:e2e tests/e2e/chat-requests.e2e.ts --project=e2e \
  --grep 'a variant (without a model is refused at the boundary|boundary check waits for delayed workspace cookie promotion)' \
  --repeat-each=10 --workers=4 --retries=0 --reporter=line
```

The complete changed file subsequently passed **12/12** tests in 10.8 seconds
with four workers, no retries and unchanged default budgets:

```sh
bun run test:e2e tests/e2e/chat-requests.e2e.ts --project=e2e \
  --workers=4 --retries=0 --reporter=line
```

The target and shared fixture remained unchanged during that run; concurrent
diagnostic and documentation edits mean it is not evidence for one exact clean
commit. No target or startup failure occurred, and cleanup checks passed.

Renewed independent Sol review found no actionable findings after the ordering
correction. Whitespace and cleanup checks passed. Raw logs, source snapshots and
failure artifacts remain private; authentication-bearing traces are not public
evidence. Repeated first-attempt GitHub CI acceptance and passing required CI on
the final candidate remain outstanding.
