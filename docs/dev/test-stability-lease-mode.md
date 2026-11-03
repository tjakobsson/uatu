# Lease rejection fixture: explicit unsafe permissions

## Failure and cause

A full local unit run at `6005f000` plus pending diagnostics failed
`Hub state-root lease > rejects unsafe, legacy, and corrupt lease paths without
repairing them`: the unsafe-mode case expected rejection but resolved instead.

The fixture requested `0644` through `writeFile` without accounting for umask.
Under `umask 077`, that creates an owner-only `0600` file. The lease implementation
correctly accepts that file; it is not the unsafe input the test intended.

Running the original case under `umask 077` reproduced the exact assertion failure
three times. A temporary assertion before acquisition confirmed mode `0600`
instead of `0644`. The full-run umask was not captured, so its source remains
unproven; this evidence establishes the fixture's ambient-umask dependency, not
which operation caused the original full-run state.

## Test-only change

Explicitly `chmod` the unsafe fixture to `0644` and assert that precondition before
acquisition. Preserve the original rejection assertion and the post-rejection
mode check, which verifies that the product did not repair the unsafe file.

The original test identity and all five cases remain: unsafe mode, symlink, legacy
directory, hard link, and corrupt database. Production lease behavior, security
settings, deadlines and retry policy are unchanged.

## Verification

macOS, approved task-local Bun 1.4.4, existing locked dependencies. Before these
commands, prepend the approved runtime directory to `PATH` and verify that
`bun --version` reports `1.4.4`; the global runtime was not changed.

```sh
# Original code: exact failure on all three executions.
(umask 077; bun test src/hub/state-dir.test.ts \
  -t 'rejects unsafe, legacy, and corrupt lease paths without repairing them')

# Fixed code: five passes under each mask, ten total.
(umask 022; bun test src/hub/state-dir.test.ts \
  -t 'rejects unsafe, legacy, and corrupt lease paths without repairing them')
(umask 077; bun test src/hub/state-dir.test.ts \
  -t 'rejects unsafe, legacy, and corrupt lease paths without repairing them')

# Fixed complete file: three passes under each mask, 150 test passes total.
(umask 022; bun test --parallel=4 src/hub/state-dir.test.ts)
(umask 077; bun test --parallel=4 src/hub/state-dir.test.ts)
```

All commands completed naturally. Whitespace checks passed. Independent Sol review
found no code issues; its runtime-selection documentation clarification is included
above. Repeated first-attempt GitHub CI acceptance remains pending; no production
defect or issue resolution is claimed.
