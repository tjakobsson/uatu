# Bundle dependency updates

## Why

Four Renovate PRs are open, each bumping a single dependency (or refreshing the
lockfile). Merging them one by one means four CI runs, four rebases as each
merge invalidates the others, and four changelog entries for what is really one
piece of maintenance. Landing them together as a single chore branch gets the
tree current in one pass.

## What Changes

- Update `shiki` 4.3.1 → 4.4.1
  (supersedes [PR #149](https://github.com/tjakobsson/uatu/pull/149))
- Update `@pierre/diffs` 1.2.12 → 1.3.0
  (supersedes [PR #148](https://github.com/tjakobsson/uatu/pull/148))
- Update `@pierre/trees` 1.0.0-beta.5 → 1.0.0-beta.6
  (supersedes [PR #142](https://github.com/tjakobsson/uatu/pull/142))
- Lockfile maintenance — refresh transitive dependencies in `bun.lock`
  (supersedes [PR #145](https://github.com/tjakobsson/uatu/pull/145))
- Close the four superseded Renovate PRs once the bundled chore PR merges

No product behavior changes are intended. [PR #144](https://github.com/tjakobsson/uatu/pull/144)
(release-please) is not a dependency update and is out of scope.

## Capabilities

### New Capabilities

None — this is a maintenance chore with no new spec-level behavior.

### Modified Capabilities

None — no requirements change. Rendering (shiki), diff view (@pierre/diffs),
and the sidebar tree (@pierre/trees) must behave exactly as they do today; the
existing unit and E2E suites are the acceptance gate.

## Impact

- `package.json` and `bun.lock` only; no `src/` changes expected unless an
  updated dependency surfaces a breaking API change (none advertised — all
  bumps are minor/patch/beta-increment).
- Surfaces exercised by the updated packages: code-block highlighting
  (`src/render/`, shiki), the preview diff view (`src/preview/`,
  @pierre/diffs), and the sidebar tree view (`src/sidebar/`, @pierre/trees).
- License audit (`bun run check:licenses`) must stay green after the bumps.
- Delivered as a single PR from branch `chore/bundle-dependency-updates`;
  the four Renovate PRs are closed as superseded after it merges.
