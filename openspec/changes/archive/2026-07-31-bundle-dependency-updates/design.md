# Design — bundle-dependency-updates

## Context

Renovate keeps uatu's dependencies current with one PR per package. Right now
four such PRs are open ([#149](https://github.com/tjakobsson/uatu/pull/149)
shiki, [#148](https://github.com/tjakobsson/uatu/pull/148) @pierre/diffs,
[#142](https://github.com/tjakobsson/uatu/pull/142) @pierre/trees,
[#145](https://github.com/tjakobsson/uatu/pull/145) lockfile maintenance).
Each merge invalidates the others' lockfiles, forcing rebases and repeat CI.
The repo convention is everything-via-PR on a branch (no direct pushes to
main), Conventional Commit subjects, and full validation before merge.

## Goals / Non-Goals

**Goals:**

- One branch, one PR, one CI pass that lands all four pending updates.
- Prove no behavior regression in the surfaces the packages power:
  highlighting (shiki), diff view (@pierre/diffs), sidebar tree
  (@pierre/trees).
- Leave the Renovate PRs closed with a pointer to the superseding PR.

**Non-Goals:**

- No major-version upgrades or dependency additions/removals.
- No change to Renovate configuration (grouping future updates into batches
  automatically is a separate decision, not made here).
- The release-please PR ([#144](https://github.com/tjakobsson/uatu/pull/144))
  is untouched.

## Decisions

- **Apply updates locally rather than merging Renovate branches together.**
  Run the bumps with `bun` on `chore/bundle-dependency-updates` (update
  `package.json` pins, then install to refresh `bun.lock`). Octopus-merging
  the four Renovate branches would conflict on `bun.lock` four ways;
  regenerating the lockfile once locally is deterministic and conflict-free.
- **Exact versions from the Renovate PRs, not `latest`.** shiki 4.4.1,
  @pierre/diffs 1.3.0, @pierre/trees 1.0.0-beta.6 — so the chore PR
  provably supersedes the open PRs instead of drifting past them.
- **Lockfile maintenance last.** A plain `bun update` (respecting
  `package.json` ranges) after the pinned bumps refreshes transitive deps,
  covering what [#145](https://github.com/tjakobsson/uatu/pull/145) does.
- **Single commit, `chore(deps):` subject.** Release-please then records one
  changelog entry for the whole batch.
- **Close, don't merge, the Renovate PRs.** After the bundle merges, Renovate
  detects the branches are superseded; close them with a comment linking the
  bundle PR so the trail is explicit.

## Risks / Trade-offs

- [shiki 4.3 → 4.4 could change highlight markup] → run the unit suite and
  the rendering E2E specs; visually spot-check a code-heavy document via
  `bun run dev`.
- [@pierre/trees is a beta line; beta-5 → beta-6 may break tree behavior]
  → `document-tree.e2e.ts` and `sidebar.e2e.ts` cover tree rendering,
  selection, and follow-mode's programmatic-update guard.
- [Transitive refresh pulls in a license change] → `bun run check:licenses`
  is part of the validation gate.
- [Batching hides which bump caused a regression] → single-commit batch is
  bisectable against main; if a regression appears later, re-apply bumps
  individually to isolate.

## Migration Plan

No runtime migration — ship the PR; revert the single commit to roll back.
