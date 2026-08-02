# Design — add-edge-provenance-bundles

## Context

`release.yml` already ships provenance as release assets: after
`actions/attest-build-provenance` pushes attestations to GitHub's store, a
"Download provenance bundles" step pulls each archive's Sigstore bundle back
out with `gh attestation download` and uploads it as `<archive>.sigstore.json`
(added in [#150](https://github.com/tjakobsson/uatu/pull/150)). Two jobs run
the same attest step but stop there:

- the nightly `desktop-edge.yml` publish job — the `edge` release carries only
  the zips, `SHA256SUMS`, and `VERSION`;
- the `desktop-macos` job in `release.yml` (signed path) — v0.4.0 ships
  bundles for the four `uatu-*` archives but none for
  `UatuCode-Desktop-*.zip`.

Consequences: those archives cannot be provenance-verified without `gh`, and
OpenSSF Scorecard's Signed-Releases check (which reads only release assets)
counts the edge prerelease as unsigned in its five-release window.

## Goals / Non-Goals

**Goals:**

- Every attested desktop archive ships its `<archive>.sigstore.json` bundle as
  a sibling release asset, on both channels: the edge prerelease and the
  signed path of stable releases.
- An edge run that half-published (archives up, bundles missing) is completed
  by the next run instead of being skipped as "already fully published".

**Non-Goals:**

- No changes to the tap automation or either cask — formula and cask
  generation key off `SHA256SUMS`, `VERSION`, and the archive names, none of
  which change.
- No backfilling of provenance onto past version releases (v0.1.0–v0.3.0);
  those age out of Scorecard's window naturally now that v0.4.0 ships bundles.
- No renaming of bundles to `.intoto.jsonl` (the Scorecard 10/10 spelling);
  edge keeps the accurate `.sigstore.json` name used by stable releases. If
  that trade is ever taken, it should be taken for both channels in one change.

## Decisions

- **Reuse the release job's download pattern verbatim in both jobs** (loop
  over `dist/release/UatuCode-Desktop-*.zip`, `gh attestation download` into a
  temp dir, rename to `<name>.sigstore.json`) rather than inventing
  job-specific variants. Download is digest-addressed, so the bundle always
  matches the freshly built archive even on reruns. Alternative —
  constructing the bundle from the attest step's outputs — was rejected
  because the round-trip through the store is what proves the attestation
  actually landed.
- **Upload bundles in the same `gh release upload --clobber` call as the
  archives** in both jobs. Keeps each publish step atomic-ish and
  self-healing: every successful publish replaces the full asset set from one
  build.
- **In `release.yml`, gate the new step on `signing == 'true'`** like the
  attest and upload steps around it: the unsigned path attaches nothing to the
  release, so there is nothing to attest or bundle.
- **Extend the skip-check's required-asset list** (the `assets=` probe in the
  "check whether already published" step) with the two bundle names. The
  existing semantics — "published means the tag points at HEAD AND all assets
  are on the release" — already express the right idea; the bundle names just
  join the list. A half-published release triggers a full rebuild; that is the
  workflow's existing recovery model (signing is not reproducible, so
  re-attaching old bundles to rebuilt archives is never an option).

## Risks / Trade-offs

- [Bundle download races the attestation store] → `release.yml`'s release job
  runs the same sequence today without issue; the attest step completes before
  the download step starts, and `--limit 1` with digest addressing pins the
  match. If the store were ever slow to index, the run fails loudly; the
  nightly self-heals on the next run, and the release workflow supports full
  reruns by design (assets are replaced).
- [The stable-path change cannot be exercised until the next tag] → a rerun of
  an existing release replays the workflow definition at the tagged commit, so
  v0.4.0 cannot pick up the new step. Verification of the `desktop-macos`
  addition waits for the next release; the edge path verifies immediately via
  `workflow_dispatch`.
- [First run after merge publishes bundles for an unchanged `main`] → the
  skip-check now sees missing bundle assets and rebuilds even though `main`
  did not move. That is desired exactly once (it upgrades the live edge
  release), and is the same behavior as any interrupted publish.

## Open Questions

None.
