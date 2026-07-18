# Design — add-desktop-edge-channel

## Context

The release pipeline (`.github/workflows/release.yml`) already contains
everything hard about shipping the desktop app: darwin cross-compilation,
per-arch Xcode builds with `UATU_BINARY`/`MARKETING_VERSION` injection,
Developer ID signing + notarization + stapling gated on secret
availability, SHA256SUMS, and tap automation via `generate-cask.ts`. The
edge channel re-triggers that machinery from `main` instead of a tag and
publishes to a rolling prerelease instead of a versioned one.

## Goals / Non-Goals

**Goals:**
- A fresh, installable, signed `main` build every day `main` changes.
- Opt-in distribution via `brew install --cask tjakobsson/tap/uatu-desktop@edge`,
  with `brew upgrade` moving users forward automatically.
- Same-day local dogfooding without CI (install script).
- Zero impact on the stable release train and its cask.

**Non-Goals:**
- No `@edge` CLI formula; no Linux/Windows edge artifacts.
- No Sparkle/in-app auto-update.
- No unsigned edge distribution — if signing secrets are missing, the run
  fails loudly (unlike releases, there is no artifact fallback: nobody
  should dogfood a quarantined app, and a silent green skip would let a
  bad secret rotation stop the channel unnoticed).

## Decisions

### D1: Nightly cron with a moved-since-last-build guard, not per-push

The app embeds the CLI, so effectively every merge would rebuild; each run
costs a macos-26 job plus two notarization round-trips (2–5 min each).
Nightly bounds the cost, and a first step compares `main`'s HEAD against
the sha recorded on the current `edge` release (in its body or a tag
lookup) and exits early when unchanged. `workflow_dispatch` covers
"I want it now".

### D2: Rolling `edge` prerelease with a moving tag

One fixed release tagged `edge`, `prerelease: true`. Each run force-moves
the tag to the built commit and replaces assets with `--clobber`
(`UatuCode-Desktop-{arm64,x64}.zip` + `SHA256SUMS`, same naming as
releases). Rationale: a single stable URL for the cask, no accumulation of
nightly releases to garbage-collect, and the tag always answers "which
commit is edge?". Alternative considered — dated releases (`edge-20260718`)
— rejected: unbounded clutter and the cask would need URL rewrites anyway.

### D3: Version scheme `<base>-edge.<utc-timestamp>.<shortsha>`

`base` is the version in `package.json` (what the next release will be
based on). A second-precision UTC timestamp makes the version monotonic —
including multiple builds on one day, where a date alone would leave
ordering to the unordered short sha — so Homebrew upgrade logic always
moves forward; the sha ties the build to its commit. Stamped into
`MARKETING_VERSION` and the cask `version`. Edge sorts as a prerelease of
`base`, so moving from edge to the next stable release also upgrades
cleanly.

### D4: Cask `uatu-desktop@edge` from the same generator

`generate-cask.ts` gains `--name` and `--tag` (defaulting to current
behavior) so one generator emits both casks; the edge workflow's tap step
mirrors the release one but writes `Casks/uatu-desktop@edge.rb` pointing
at the `edge` tag's assets. Stable and edge casks conflict on install
(same app bundle); the cask declares `conflicts_with cask:` accordingly.
The tap job runs on every successful nightly — the release carries a
`VERSION` asset alongside SHA256SUMS, so the job reconciles the cask from
published state alone and a transiently failed tap push self-heals the
next night without rebuilding.

### D5: Reuse by extraction, not duplication

The sign/notarize/staple shell steps are extracted into a composite action
(`.github/actions/sign-notarize-app`) used by both `release.yml` and
`desktop-edge.yml`, so the two channels cannot drift. The darwin-binary
step differs (edge builds `bun run build` from source rather than
downloading release assets) and stays inline per workflow.

### D6: Local install script

`scripts/install-desktop-local.sh` (macOS-only by nature — it drives
`xcodebuild`): `bun install && bun run build` → Release build with
`UATU_BINARY` and a `<base>-local.<shortsha>` version → `ditto` into
`/Applications`, replacing any existing copy after confirming it isn't
running. Ad-hoc signed — fine for the machine that built it.

## Risks / Trade-offs

- [Rolling tags are mildly unidiomatic on GitHub; `gh release download edge`
  caching or provenance confusion] → assets carry SHA256SUMS and the
  release body records commit + date; attestation step included like
  releases.
- [Edge users hit a broken main] → that is the point of dogfooding, but
  the README section for the edge cask states the stability expectation
  and how to fall back (`brew install --cask uatu-desktop`).
- [Notarization outage would fail the nightly] → run is idempotent; next
  night (or a manual dispatch) recovers. No retry logic needed.
- [Composite-action extraction touches the release workflow] → verified by
  the next real release; the extraction is a pure move of existing shell.

## Migration Plan

Purely additive: new workflow, new cask, new script. Rollback = delete
the workflow and the `@edge` cask; stable channel never depended on any
of it.

## Open Questions

- None blocking. Whether the edge release body should embed a mini
  changelog (commits since last edge) is a nice-to-have decided at
  implementation time.
