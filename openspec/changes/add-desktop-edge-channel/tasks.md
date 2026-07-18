# Tasks — add-desktop-edge-channel

## 1. Extract shared signing pipeline

- [x] 1.1 Move the import-certificate and sign/notarize/staple shell from
      `release.yml` into a composite action
      `.github/actions/sign-notarize-app` (inputs: app paths, secrets via
      env) and switch `release.yml` to use it
- [x] 1.2 Verify `release.yml` still passes actionlint / a dry parse and
      that no step semantics changed (pure extraction)

## 2. Edge workflow

- [x] 2.1 Add `.github/workflows/desktop-edge.yml`: nightly cron +
      `workflow_dispatch`, macos-26, with an early-exit step comparing
      `main` HEAD to the commit recorded on the `edge` release
- [x] 2.2 Build darwin binaries from source (`bun run build` per arch),
      build both app archs with `MARKETING_VERSION`
      `<base>-edge.<utc-timestamp>.<shortsha>`, sign via the composite action;
      gate on secret availability (fail the run when absent)
- [x] 2.3 Publish: move the `edge` tag to the built commit, upsert the
      prerelease with `--clobber`ed assets + SHA256SUMS, record commit and
      date in the release body

## 3. Tap cask

- [x] 3.1 Parameterize `scripts/generate-cask.ts` with `--name` and
      `--tag` (defaults preserve current output), emitting
      `conflicts_with cask:` between stable and edge; extend its tests
- [x] 3.2 Add the tap-update job to `desktop-edge.yml` writing
      `Casks/uatu-desktop@edge.rb` via `HOMEBREW_TAP_TOKEN`
- [x] 3.3 Document the edge channel in the README (install command,
      stability expectation, how to switch back to stable)

## 4. Local install script

- [x] 4.1 Add `scripts/install-desktop-local.sh`: `bun run build` →
      Release xcodebuild with `UATU_BINARY` and `<base>-local.<shortsha>`
      → refuse if the app is running → `ditto` into `/Applications`
- [x] 4.2 Run it end-to-end and verify the installed app serves a folder

## 5. Verify

- [x] 5.1 Trigger `desktop-edge.yml` via `workflow_dispatch`; verify
      signed, stapled archives on the `edge` prerelease and a correct
      `uatu-desktop@edge` cask in the tap
- [x] 5.2 `brew install --cask tjakobsson/tap/uatu-desktop@edge` on a
      dev machine; verify launch (done on the test Mac, 2026-07-18)
- [ ] 5.4 After the first nightly following the next merge to main,
      run `brew upgrade` on the edge-installed machine and verify it
      moves to the new edge version (deferred: needs a newer edge build
      to exist; version monotonicity is already test-asserted in
      scripts/release-config.test.ts)
- [x] 5.3 Re-run the workflow with `main` unchanged; verify the early
      exit path
