# Current-file privacy sanitization

Private review addresses and machine-specific exposure commands are removed from
public documentation. New managed review starts are local-only by default; an
optional public origin is supplied explicitly through local runtime configuration.
Existing verified ownership records remain usable without restarting the server.
Tests use synthetic origins solely to exercise request-origin validation.

The following six reports use `<REPO_ROOT>` in place of a personal checkout prefix:

- `folder-picker/browser-results.json` — 8 substitutions
- `preview-refinement/browser-results.json` — 24 substitutions
- `preview-refinement/boundary-results.json` — 8 substitutions
- `navigation-recovery/browser-results.json` — 24 substitutions
- `navigation-recovery/boundary-results.json` — 7 substitutions
- `navigation-recovery/production-results.json` — 5 substitutions

There are **76 substitutions** total. All other parsed report data, including
complete stats, timestamps, durations, failures and attachments, is unchanged.
Each edited JSON file also has a terminal newline. These are sanitized historical
reports, not byte-identical original captures or new verification runs. Existing
historical fingerprints do not certify the edited report bytes.

`tests/mobile-hub-review/privacy.test.ts` checks the retained reports and public
access documentation. Raw reporter output can reintroduce absolute paths and must
be normalized before publication; the test fails if those paths return.

This record describes current-file edits only. It does **not** certify that Git
history, old PR revisions, caches or remote refs have been sanitized. History
rewriting and any force-push require separate user confirmation. The approved
artifact-cleanup commit remains a separate normal deletion step; its historical
artifacts must not be stripped from earlier commits during privacy work.

Current-file verification: **444 tests / 5453 assertions** passed across the
focused product/reviewer/preview/boot and preservation-baseline suites. Both
TypeScript checks and whitespace checks passed. A separate audit found none of
the identified private host, tailnet suffix or checkout-prefix markers in current
project files, and confirmed the reports changed only as described above. The
existing owned reviewer passed read-only identity verification without restart.
