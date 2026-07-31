# Tasks — bundle-dependency-updates

## 1. Apply the version updates

- [x] 1.1 On `chore/bundle-dependency-updates`, update `package.json`: `shiki` → 4.4.1, `@pierre/diffs` → 1.3.0, `@pierre/trees` → 1.0.0-beta.6
- [x] 1.2 Run `bun install` to apply the pinned bumps, then `bun update` to refresh transitive dependencies in `bun.lock` (covers lock-file maintenance)
- [x] 1.3 Confirm the diff touches only `package.json` and `bun.lock`

## 2. Validate

- [x] 2.1 `bun test` (unit suite) passes
- [x] 2.2 `bun run check:licenses` passes after the transitive refresh
- [x] 2.3 `bun run build` produces `dist/uatu`
- [x] 2.4 `bun test:e2e` passes, with attention to rendering, document-tree, and sidebar specs (shiki / @pierre/trees / @pierre/diffs surfaces)
- [x] 2.5 Spot-check a code-heavy document and the diff view via `bun run dev`

## 3. Commit

- [x] 3.1 Single commit `chore(deps): update shiki, @pierre/diffs, @pierre/trees and refresh lockfile` including the OpenSpec change artifacts

After the branch is pushed, open a PR titled after the change (per repo
conventions everything lands via PR). Once it merges, close the superseded
Renovate PRs — [#149](https://github.com/tjakobsson/uatu/pull/149),
[#148](https://github.com/tjakobsson/uatu/pull/148),
[#145](https://github.com/tjakobsson/uatu/pull/145),
[#142](https://github.com/tjakobsson/uatu/pull/142) — each with a comment
linking the superseding PR.
