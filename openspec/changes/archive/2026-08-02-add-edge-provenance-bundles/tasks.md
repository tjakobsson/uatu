# Tasks — add-edge-provenance-bundles

Work happens on a fresh branch off `main` and lands via a pull request per
repository convention (no direct pushes to `main`). Suggested branch name:
`ci/edge-provenance-bundles`; PR title in conventional-commit form, e.g.
`ci(release): attach Sigstore provenance bundles to desktop archives`.

## 1. Workflow change (.github/workflows/desktop-edge.yml)

- [x] 1.1 Add a "Download provenance bundles for the archives" step after the
      attest step, mirroring `release.yml`: for each
      `dist/release/UatuCode-Desktop-*.zip`, `gh attestation download` into a
      temp dir and move the result to
      `dist/release/<archive-name>.sigstore.json` (needs `GH_TOKEN`)
- [x] 1.2 Extend the publish step's `gh release upload edge --clobber` asset
      list with `dist/release/UatuCode-Desktop-*.zip.sigstore.json`
- [x] 1.3 Extend the skip-check's required-asset list ("already fully
      published" probe) with the two bundle asset names so a half-published
      release is rebuilt, and update the step's comment to state that
      "all assets" includes the provenance bundles

## 2. Workflow change (.github/workflows/release.yml, desktop-macos job)

- [x] 2.1 Add the same "Download provenance bundles" step after the job's
      attest step, gated on `steps.gate.outputs.signing == 'true'` like its
      neighbors, producing `dist/release/UatuCode-Desktop-<arch>.zip.sigstore.json`
- [x] 2.2 Extend the "Upload app archives and updated checksums" step's
      `gh release upload --clobber` asset list with
      `dist/release/UatuCode-Desktop-*.zip.sigstore.json`

## 3. Verification

- [x] 3.1 Lint both workflows (`actionlint` if available, otherwise a YAML
      parse) and re-read the diff against the design's decisions

The rest of the verification can only happen after the PR merges (workflows
run from `main` / the tagged commit), so it is not tracked as tasks here:

- Trigger `workflow_dispatch` on Desktop Edge and confirm the run publishes
  `UatuCode-Desktop-{arm64,x64}.zip.sigstore.json` on the `edge` release even
  though `main` may not have moved (expected one-time rebuild per the design).
- Verify a published bundle:
  `gh attestation verify UatuCode-Desktop-arm64.zip --repo tjakobsson/uatu`,
  and check the downloaded `.sigstore.json` matches the archive digest.
- Confirm the next scheduled run after an unchanged `main` exits early again
  (skip-check recognizes the now-complete asset set).
- On the next tagged release, confirm the assets include
  `UatuCode-Desktop-{arm64,x64}.zip.sigstore.json` alongside the four
  `uatu-*` bundles (the stable path cannot be exercised earlier — a rerun of
  an existing tag replays the old workflow definition).
