# Attachment preservation: capture a published baseline

## Cause and scope

[Run 41611072260](https://github.com/tjakobsson/uatu/actions/runs/41611072260/job/125832880446)
retried `manual background API is parent-wide, keeps the draft, and inspection
survives worker failure`. Its initial attachment snapshot was empty; the later
preservation assertion observed `preserved.png×` instead.

The test captured its baseline immediately after upload response headers reported
201. Application code still needed to consume the JSON result and publish the
attachment to the composer. The test could compare a not-yet-published baseline
with a correctly preserved attachment. Ten unchanged local attempts passed; that
natural CI mismatch was not reproduced locally.

A controlled experiment at the actual upload setup established the missing
precondition: the real upload returned 201 and its real JSON parsed while delivery
to the application was held. The attachment strip remained empty. Releasing the
parsed result published `preserved.png` before any background operation.

## Test-only change and regression

Wait for the exact rendered attachment name before snapshotting the strip.
Preserve the original test identity and its full post-action equality assertion,
draft, configuration, delivery, parent-wide background call count, worker-failure
inspection and reload checks. No product or authentication behavior changes.

The new regression delegates real fetch and JSON parsing, holding only delivery
of the conversation-specific upload result. It observes the shared helper after
the actual 201 receipt and immediately before baseline capture. While publication
is held, the pre-snapshot observer must remain false. Release and fetch restoration
occur in `finally`; named publication and zero background calls are checked before
the action. The real background operation must then preserve the complete baseline
and draft, with exactly one background call.

Removing only the DOM-ready assertion, while retaining both observers, produced
three explicit premature-snapshot assertion failures. Source snapshots and their
mutation diff were verified before execution. Restoring the exact fixed source
passed both cases ten times each. This is controlled setup-regression evidence,
not a claim that the natural local baseline run failed.

## Verification

macOS, approved task-local Bun 1.4.4, existing dependencies and cached browser.
Prepend the approved runtime directory to `PATH`; verify `bun --version` is
`1.4.4`. Default budgets were unchanged, with four workers and zero retries.

```sh
# Original unchanged case: 10 passed, 22.0 seconds.
bun run test:e2e tests/e2e/chat-opencode-background.e2e.ts --project=e2e \
  --grep 'manual background API is parent-wide, keeps the draft, and inspection survives worker failure' \
  --repeat-each=10 --workers=4 --retries=0 --reporter=line

# Only the DOM-ready assertion removed: 3 meaningful assertion failures.
bun run test:e2e tests/e2e/chat-opencode-background.e2e.ts --project=e2e \
  --grep 'manual background preservation baseline waits for attachment publication after upload' \
  --repeat-each=3 --workers=4 --retries=0 --reporter=line

# Exact fixed source restored: 20 passed, 35.2 seconds.
bun run test:e2e tests/e2e/chat-opencode-background.e2e.ts --project=e2e \
  --grep 'manual background (API is parent-wide, keeps the draft, and inspection survives worker failure|preservation baseline waits for attachment publication after upload)' \
  --repeat-each=10 --workers=4 --retries=0 --reporter=line
```

Fresh independent Sol review found no actionable findings. Whitespace and cleanup
checks passed. Private mutation snapshots, logs and raw failure artifacts remain
debugging evidence, not publication attachments. Linux CI and repeated
first-attempt acceptance remain outstanding; no product-backgrounding fix or
issue closure is claimed.
