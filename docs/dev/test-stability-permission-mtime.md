# Permission-test timestamp precision

## Cause

The initial planning-only commit `7cb9097146191d57f1e01d76c836b5dd891a2152`
failed the unreadable-document E2E setup on all three CI attempts:
[workflow 41570952785, functional leg 1](https://github.com/tjakobsson/uatu/actions/runs/41570952785/job/125703572990).

The test advances the file mtime by one second and waits for that update to be
indexed and applied in the browser before counting document reads. It compared
the indexed timestamp exactly with the requested JavaScript `Date` value.

Selected numeric evidence from the private failed-attempt trace:

| State | Timestamp, milliseconds |
| --- | --- |
| Original file | 1793675887437.1624 |
| Intended setup value | 1793675888438 |
| Indexed setup value | 1793675888437.999 |

The index advanced from document revision 4 to 23 and snapshot revision 22 to 24.
The update was present, but a 0.001 ms filesystem rounding difference made exact
equality impossible. Increasing the polling timeout would not fix this predicate.
Raw traces are retained privately, not committed: they may contain authentication
material. Only the numeric evidence needed for this diagnosis is reproduced here.

## Change and regression

`view-and-layout.e2e.ts` compares the indexed mtime at the intended `Date`'s
millisecond precision. The previous timestamp remains a full second older and
cannot satisfy the receipt check. The existing browser-generation gate remains.

A second case writes a timestamp one microsecond below the intended millisecond
to exercise the same rounding boundary through the actual filesystem, watcher,
browser and permission assertions. The original test title is preserved.

Both cases still assert the permission notice, absence of retry feedback, exactly
one read across the retry-delay observation window, permission restoration in
`finally`, and successful reselection. Product behavior, timeouts and retry policy
are unchanged.

## Verification

Local environment: macOS, task-local official Bun 1.4.4, existing pinned Playwright
browsers and unchanged locked dependencies.

```sh
# Before the comparison fix: 2 failed / 0 passed at the CI setup predicate.
bun run test:e2e tests/e2e/view-and-layout.e2e.ts --project=e2e \
  --grep 'sub-millisecond mtime' --repeat-each=2 --workers=2 \
  --retries=0 --trace=off --reporter=line,json

# After the fix: 6 passed / 0 failed.
bun run test:e2e tests/e2e/view-and-layout.e2e.ts --project=e2e \
  --grep 'A document the server cannot read' --repeat-each=3 --workers=4 \
  --retries=0 --trace=off --reporter=line,json

# After the shared-case refactor: 28 passed / 0 failed, 20.78 seconds.
bun run test:e2e tests/e2e/view-and-layout.e2e.ts --project=e2e \
  --repeat-each=2 --workers=4 --retries=0 --trace=off --reporter=line,json
```

Independent Sol review found no blocking or actionable findings. Whitespace
checks passed. The repository's main typecheck passed, but it does not cover the
E2E files; the browser runs above execute the changed cases.

This is a locally verified test-setup fix, not yet a GitHub CI stability claim.
Repeated first-attempt passes and passing required CI on the final candidate are
still required. The original nine investigations and other newly discovered
failures remain separate.
