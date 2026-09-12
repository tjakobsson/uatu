# Current UI development and review package

Use this package to continue the unfinished UI update, not as an archive of every
capture run. **Simulation only; no real credentials. Visual approval is pending.**

## What to use

- The actual reviewer: `bun tests/mobile-hub-review/manage.ts start` (local-only
  by default). Do not start it over another owned instance. See
  [hosting instructions](../../../../tests/mobile-hub-review/hosting.md).
- `/review/design-system`: actual shared UI primitives and task interactions.
- `/review/evidence`: the fixed 20-image current gallery, this guide and the
  [verification/known-issues record](verification.md).
- `gallery/`: Chromium and WebKit examples at 390×844 CSS px, DPR 2, light scheme,
  reduced motion. These illustrate the current UI, **not approved pixel goldens**.
- [Canonical reference index](index.md) and
  [the original design references](../../../../design/hub-mobile/README.md): all
  49 original images remain unchanged. They remain the visual target.
- `baseline.json`, `baseline.ts` and `baseline.test.ts`: the immutable historical
  preservation/reference fixture and its tests, not a current run report.
- The change's [proposal](../proposal.md), [design](../design.md),
  [tasks](../tasks.md), [reference contract](../reference-contract.md) and
  [screen map](../screen-map.md).

The reusable reviewer, fixture corpus and behavioral tests remain under
`tests/mobile-hub-review/`. Workspace interiors and live-backend integration are
not redesigned or completed by this evidence cleanup.

## Generate fresh evidence without committing an archive

```sh
bunx --no-install playwright test --config tests/mobile-hub-review/compact-gallery.config.ts
bunx --no-install playwright test --config tests/mobile-hub-review/navigation-recovery.config.ts
bunx --no-install playwright test --config tests/mobile-hub-review/preview-boundary.config.ts
```

Normal screenshots and native JSON reports go to ignored local outputs, primarily
`tests/mobile-hub-review/results/artifacts/`. Raw reports may contain local paths;
they are not publication-safe merely because tests passed.

Only an explicit reviewed promotion updates the fixed gallery:

```sh
UATU_PROMOTE_COMPACT_GALLERY=1 bunx --no-install playwright test --config tests/mobile-hub-review/compact-gallery.config.ts
```

Review the images, update the current verification record and run hosting/privacy
checks before committing a promotion. The server publishes only explicitly named
gallery files and two current Markdown records; it does not expose output folders.

## Historical findings, not active capture dependencies

Existing Markdown findings are retained, with links to this current entry point.
Their dates, outcomes and open limitations are not silently replaced by newer
passes. Earlier generated artifacts and the three retired archive-report scripts
remain in Git at `373ef6350032f6a0f2a91c2037ebafb553bc002f` at their original paths.
For example, `git show <revision>:<repository-relative-path>` recovers an artifact.
The prior, narrower cleanup's older recovery point is documented in
[artifact-cleanup.md](artifact-cleanup.md).

This is a normal deletion commit, not a history rewrite. All 563 previous generated
PNG captures, 49 generated JSON reports and three HTML galleries leave the current
tree; the original reference/baseline fixtures and written findings remain. Three
scripts generating those obsolete multi-generation reports are retired. Product
and behavioral regression tests remain; future detailed matrices can be captured
locally without restoring an artifact archive to the branch tip.
