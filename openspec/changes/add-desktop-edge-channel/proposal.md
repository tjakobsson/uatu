# Desktop edge channel — dogfood bleeding-edge main

## Why

The only way to run UatuCode Desktop today is a tagged release (or a local
Xcode build). Changes merged to `main` — like the split browser — sit
unused until the next release train, so bugs that only show up in daily
use are found late. The maintainer wants to dogfood `main` continuously,
and other users should be able to opt in to the same bleeding-edge build
without cloning the repo.

## What Changes

- A new **edge workflow** builds UatuCode Desktop from `main` on a nightly
  schedule (plus manual `workflow_dispatch`), skipping when `main` hasn't
  moved since the last edge build.
- Builds are **signed, notarized, and stapled** with the existing
  Developer ID pipeline; when signing secrets are absent the workflow
  skips publishing entirely (no unsigned edge builds ever ship).
- Artifacts land on a **rolling `edge` prerelease** (fixed tag, assets
  replaced each run, marked prerelease so it never shadows real releases).
- Version stamped as `<base>-edge.<YYYYMMDD>.<shortsha>` so Homebrew sees
  a monotonically increasing version and `brew upgrade` always moves
  forward.
- The tap gains an opt-in **`uatu-desktop@edge` cask**;
  `brew install --cask tjakobsson/tap/uatu-desktop@edge` follows the
  channel. The stable `uatu-desktop` cask is untouched.
- A **local install script** (`scripts/install-desktop-local.sh`) builds
  Release from the working tree and installs into `/Applications` for
  same-day dogfooding without CI.

Out of scope: an `@edge` CLI formula (the app embeds the CLI, and
`bun run build` covers local CLI use), and in-app auto-update (Sparkle) —
`brew upgrade` is the update path.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `desktop-distribution`: new requirements for the nightly edge build
  (trigger, skip-when-unchanged, signing gate), the rolling `edge`
  prerelease contract (tag, versioning, asset layout), the
  `uatu-desktop@edge` cask, and the local install script.

## Impact

- New workflow `.github/workflows/desktop-edge.yml` (reuses the
  `desktop-macos` job's build/sign/notarize steps from `release.yml`).
- `scripts/generate-cask.ts` parameterized for cask name/tag (or a small
  sibling generator) to emit `Casks/uatu-desktop@edge.rb`.
- New `scripts/install-desktop-local.sh`.
- Uses existing secrets (`MACOS_CERT_*`, `NOTARY_*`, `HOMEBREW_TAP_TOKEN`);
  no new credentials.
- CI cost: one macos-26 job + two notarizations per night with changes;
  zero on quiet days.
