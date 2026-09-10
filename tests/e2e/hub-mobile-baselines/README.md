# Real Hub Visual Baselines

Pre-presentation-change captures for `refine-mobile-hub-navigation`, task 1.3
and only the real-Hub visual portion of 1.4. Product baseline commit:
`0ba1dad3e96dc7ac8a81f8f820a5e0d9488ffd69`.

Run the isolated browser tests without updating these retained images:

```sh
bun run test:e2e tests/e2e/hub-mobile-baseline.e2e.ts --workers=1
```

Explicitly capture a new baseline (review changes before retaining it):

```sh
UATU_CAPTURE_HUB_MOBILE_BASELINE=1 bun run test:e2e tests/e2e/hub-mobile-baseline.e2e.ts --workers=1
```

The fixture launches the production Hub CLI, hence the real `startHubServer`,
`LocalProcessBackend`, credential managers, and workspace CLI children. Each
test gets its own ephemeral loopback port, temporary HOME/XDG/state directories,
Git repositories, password login, and browser context. No test modules or
design fixtures are imported. Temporary Hub configuration is runtime test data;
repository and user configuration are untouched. Shutdown uses the production
stdin-EOF path and checks its exit status.

Recorded verification (macOS, Chromium 153.0.8010.12): capture run with
`--workers=1 --max-failures=1` passed both tests in 28.5s; final ordinary run
with the command above passed both tests in 27.6s. All 16 images were captured
before any product UI edits. The new test files also passed a direct strict
TypeScript check (the repository tsconfig includes only `src/`):

```sh
bunx tsc --ignoreConfig --noEmit --strict --skipLibCheck --target ESNext --module ESNext --moduleResolution Bundler --types bun-types tests/e2e/hub-mobile-fixtures.ts tests/e2e/hub-mobile-baseline.e2e.ts
```

Prerequisites: Bun, Git, OpenSSH (ssh/keygen/agent/add), GnuPG (gpg/gpgconf), and
the repository's Playwright Chromium. The child uses a clean tool PATH rather
than inheriting projected Hub credentials; `UATU_HUB_MOBILE_TOOL_PATH` can specify
a different clean installation location. Missing real crypto tools fail rather
than silently substituting fake implementations or skipping coverage.

## Coverage

- Chromium at 1440x1000 fine pointer and 390x844 mobile/coarse pointer, DPR 1,
  system light scheme. Both use real routes and the same assertions.
- Anonymous API rejection, browser form login and session cookie, two distinct
  stable workspace ids with duplicate display names, running/stopped state,
  start/stop/restart, and no implicit Stop when navigating back to Hub.
- Identical relative document paths with different content in A/B, independent
  document ids, real per-workspace state APIs, and file-scoped index responses.
- Real SSH and OpenPGP generate/import/public-key/unlock/enable/disable/delete
  operations, SSH lock, dual-role SSH assignments, OpenPGP signing assignment,
  and host-specific token assignment through actual APIs.
- SSH Test proves agent usability; OpenPGP Test performs the application's real
  signing challenge. Tokens are deliberately invalid provider secrets: HTTPS
  Git/GitHub CLI/GitLab CLI capabilities and local storage/readiness are real,
  but no remote authentication is claimed. OpenPGP individual lock and token
  public-key/lock/unlock/generation are not supported operations.
- Screenshots: login, A-running/B-stopped dashboard, collapsed Settings, SSH
  details, Add workspace (`/clone`), A/B Preview, and stopped A.

## Limits

These are unmasked visual records, not pixel-golden assertions. Temporary paths,
generated public fingerprints, device issue timestamps and runtime versions are
intentionally genuine and vary across runs. Regular runs attach fresh images to
the Playwright report without replacing these retained baselines.

The captured 390px dashboard visibly compresses/truncates workspace identity
beside secondary actions. This is pre-existing presentation recorded for the
planned redesign, not a fixture styling override or a passing usability claim.

This does not complete all of task 1.4 or the D9 matrix: existing Hub/touch/
Preview/Chat/Terminal/API suites and the contribution-guide gates are separate.
No WebKit, dark scheme, 320px, landscape, tablet, 200% text, reduced preferences,
native wrapper, physical device, accessibility audit, external credential
authentication, clone-job lifecycle, or Chat/PTY interaction is asserted here.
Credential management actions are API-driven; screenshots do not establish
browser-form parity for every action. No new navigation UI is implemented.
