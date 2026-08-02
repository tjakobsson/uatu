# add-edge-provenance-bundles

## Why

The nightly `edge` prerelease attests its desktop archives with
`actions/attest-build-provenance`, but the resulting Sigstore bundles stay in
GitHub's attestation store — they are never attached as release assets. Versioned
releases ship `<archive>.sigstore.json` bundles next to the four `uatu-*`
archives (since the OpenSSF baseline change,
[#150](https://github.com/tjakobsson/uatu/pull/150)) — but the same gap exists
in two places: the edge prerelease attaches no bundles at all, and the stable
`desktop-macos` job attests `UatuCode-Desktop-*.zip` without attaching their
bundles either (verified on v0.4.0). In both cases a user — or OpenSSF
Scorecard's Signed-Releases check, which only reads release assets — cannot
verify provenance without `gh`. This closes both gaps so every attested archive
on every release channel ships its bundle as a sibling asset.

## What Changes

- The `desktop-edge.yml` publish job downloads the Sigstore provenance bundle
  for each `UatuCode-Desktop-*.zip` from the attestation store and uploads it to
  the `edge` release as `<archive-name>.sigstore.json`, mirroring the
  `release.yml` pattern.
- The "already fully published" skip check learns about the new assets, so a run
  that uploaded archives but failed before attaching bundles is retried rather
  than skipped.
- The `release.yml` `desktop-macos` job (signed path only) likewise downloads
  the bundles for `UatuCode-Desktop-*.zip` and includes them in its release
  upload, so stable releases ship bundles for all six archives, not just the
  four `uatu-*` ones.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `desktop-distribution`: two requirements gain provenance-bundle assets — the
  edge rolling-prerelease contract, and the signed-path release contract
  ("Signing and notarization are gated on credential availability"). In both,
  each published desktop archive must be accompanied by its Sigstore bundle as
  a sibling release asset. (`release-distribution` is untouched: its integrity
  requirement already covers the four `uatu-*` archives.)

## Impact

- `.github/workflows/desktop-edge.yml` — publish job (bundle download + upload
  + skip-check asset list).
- `.github/workflows/release.yml` — `desktop-macos` job's signed path (bundle
  download + upload). No change to the tap or the casks; formula and cask
  generation key off `SHA256SUMS`, `VERSION`, and archive names, all untouched.
- The `edge` release and each future stable release gain two small
  `.sigstore.json` assets for the desktop archives.
- No product code (`src/`) is affected.
