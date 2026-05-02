## Context

The current browser UI has one collapsible left sidebar whose body is the document tree. The server sends `StatePayload` over `/api/state` and SSE with watched roots, follow defaults, selected-change hints, build metadata, and pin scope. Build metadata already exposes the build branch/commit, but that is about the running `uatu` binary/source tree, not necessarily the watched repository being reviewed.

This change adds review-oriented repository context to the watch session without changing the core preview behavior. The first version should remain deterministic and explainable: it estimates review burden from git facts, diff shape, and optional project-defined path rules, not from semantic or AI interpretation.

## Goals / Non-Goals

**Goals:**

- Preserve existing `uatu watch` behavior when no git repository or settings file exists.
- Make the sidebar a pane stack that can host `Change Overview`, `Files`, and `Git Log` panes.
- Detect the git repository context for watched roots and surface branch/commit/status changes while the session is running.
- Compute a transparent cognitive-load/review-burden score from measurable change signals and configurable path-based modifiers.
- Keep every score explanation auditable by showing the exact facts and configured areas that contributed.
- Use a small optional JSON settings file so projects can define risk/support/ignore path groups without adding a YAML dependency.

**Non-Goals:**

- AI-generated review summaries, semantic code understanding, or natural-language risk inference.
- Full peer-review checklist workflows or persisted reviewer sign-off state.
- GitHub/GitLab API integration or direct merge-request fetching.
- Replacing the full document tree with a diff-only file browser.

## Decisions

### Use a data-driven sidebar pane stack

Represent sidebar panes as stable pane IDs with persisted UI state in `localStorage`: visibility, collapsed/expanded state, and vertical size. The initial pane set is `change-overview`, `files`, and `git-log`. The existing tree moves into the `files` pane so current selection, follow, pin, and directory open/closed behavior remain local to the existing tree renderer.

The pane stack should fill the available expanded-sidebar height without making the whole sidebar body scroll. Pane resize operations are bounded within the current pane-stack height: dragging a divider reallocates height between adjacent visible panes, and persisted pane sizes are normalized back into the available height on render. Individual pane bodies may scroll when their content exceeds their allocated height. Spare height should prefer the `Files` pane so shorter contextual panes such as `Git Log` do not gain large empty regions.

Alternatives considered:
- Add new cards above and below the current tree. This is simpler but does not support user control over pane size/visibility and would make the tree cramped.
- Create separate routes or tabs. This hides information instead of letting reviewers correlate load, files, and commits side-by-side.

### Keep sidebar collapse separate from pane visibility

The existing whole-sidebar collapse remains a top-level layout control. Pane visibility/collapse controls operate only inside the expanded sidebar. A `Panels` menu should expose checkboxes for restoring hidden panes, while each pane header may provide a collapse control.

### Allow expanded-sidebar width resizing

The expanded sidebar width is independently resizable with a horizontal drag handle between sidebar and preview. The width persists in `localStorage` and is clamped to useful minimum and maximum values. Whole-sidebar collapse still switches to the narrow rail and does not erase the expanded width preference.

Alternatives considered:
- Reuse the whole-sidebar collapse as pane hiding. That creates a recovery problem when users hide a pane and cannot find where to re-enable it.
- Only allow pane collapse, not hide. That keeps recovery simple but prevents users from reducing visual noise.

### Refresh git/review snapshots server-side with safe fallbacks

The server should detect git repositories from watched roots using git commands such as `git -C <root> rev-parse --show-toplevel`. Roots outside git repositories produce an explicit non-git state rather than an error. When multiple watched roots map to multiple repositories, the state groups review data by repository.

Git metadata and review-load snapshots should refresh on startup, after watched-file refreshes, and during the existing periodic reconcile loop so branch changes, staging changes, and checkout changes can be noticed even when no watched document changes. Git command failures should degrade to unavailable metadata while keeping document preview usable.

Alternatives considered:
- Watch `.git` internals directly. This can be fragile across normal worktrees, packed refs, linked worktrees, and platform-specific filesystem behavior.
- Compute git data in the browser. The browser has no filesystem/git access and would require extra server APIs anyway.

### Resolve review base deterministically and display it

The review load needs a base for branch-style changes. Resolve it in this order:

1. `review.baseRef` from `.uatu.json`, if configured and valid.
2. The remote default branch from `refs/remotes/origin/HEAD`, if available.
3. `origin/main`, `origin/master`, `main`, then `master`, whichever exists first.
4. Fall back to `HEAD` and mark the snapshot as dirty-worktree-only.

The UI must display the selected base or fallback mode so reviewers understand what the meter represents. The diff should include committed changes from `merge-base(base, HEAD)..HEAD` plus staged/unstaged working-tree changes. If a base cannot be resolved, the score still works from staged/unstaged changes against `HEAD`.

Alternatives considered:
- Use the branch upstream (`@{upstream}`) by default. That often points to the feature branch on origin, not the merge-request target, so it can undercount review burden.
- Require a base flag on `uatu watch`. That is precise but too much friction for the default local preview workflow.

### Score review burden from mechanical cost plus configured modifiers

The cognitive meter should be labeled as review burden, not code quality. The score has three classes of inputs:

- Mechanical cost: changed files, hunks, touched lines, directory spread, languages/file kinds, renames, and dependency/config files.
- Risk modifiers: project-configured path areas that add score when matched.
- Support modifiers: project-configured path areas that subtract score when matched, typically tests or docs.

Unconfigured paths are risk-neutral but still count toward mechanical cost. Ignore/generated areas can remove matching files from score calculations while still reporting that they were excluded. Every category should have caps so large changes do not produce meaningless runaway scores.

The `Change Overview` pane should not list raw mechanical statistics such as changed files, touched lines, diff hunks, or directory spread directly in the sidebar. Those facts are useful, but they make the compact pane read like a stats dump and the numeric score still lacks context. Instead, the score meter itself is a click target. Clicking it disables Follow, clears file selection, creates a browser-history entry, and renders a score explanation in the main preview area. That preview should show the score, current low/medium/high thresholds, whether the score is below or above those thresholds, the mechanical statistics, configured risk/support/ignore drivers, and warnings. The score total and low/medium/high threshold cards should use the same background colors as their corresponding burden states. It should not include a separate `Changed Files` section; file browsing belongs in the `Files` pane. The score explanation remains the active preview state across reloads and file-change refreshes until the user navigates elsewhere. Mechanical statistics should have hover/focus help markers for terms such as changed files, touched lines, diff hunks, and directory spread, using a lightweight tooltip rather than requiring a click. The explanation must state that the score is an additive review-burden index, not a percentage and not a code-quality score.

Alternatives considered:
- Pure path scoring. This misses unconfigured large changes, which are still hard to review.
- Pure mechanical scoring. This cannot express project-specific risk such as auth, migrations, billing, or deployment files.
- AI-only scoring. This is not available yet and would make explanations less deterministic.
- Keep all mechanical score drivers visible in `Change Overview`. This is transparent but too dense for the sidebar and does not answer how to compare a score such as `109` against the configured thresholds.

### Use `.uatu.json` for optional review configuration

Add an optional `.uatu.json` file at the repository root. The first supported shape is:

```json
{
  "review": {
    "baseRef": "origin/main",
    "thresholds": { "medium": 35, "high": 70 },
    "riskAreas": [
      { "label": "Auth", "paths": ["src/auth/**", "**/session/**"], "score": 25, "perFile": 2, "max": 35 }
    ],
    "supportAreas": [
      { "label": "Tests", "paths": ["**/*.test.ts", "tests/**"], "score": -10, "perFile": -1, "maxDiscount": 15 }
    ],
    "ignoreAreas": [
      { "label": "Generated", "paths": ["dist/**", "**/*.generated.ts"] }
    ]
  }
}
```

Invalid config should not stop the watch session. The UI should surface a configuration warning and the server should fall back to defaults for invalid sections.

Alternatives considered:
- YAML configuration. This is friendlier to edit but adds a parser dependency.
- Extend `.uatuignore`. That file already has a clear indexing/exposure purpose; mixing review scoring into it would be confusing.

### Keep git log bounded and separate from scoring

The `Git Log` pane should show a bounded recent commit list for the detected repository context. The log is navigational/contextual and must not contribute to review-load scoring. The first version should prefer concise local git data over remote hosting integration.

The server can collect a bounded superset of recent commits, while the browser exposes a history-length selector for how many rows to show. The `Git Log` pane body owns its own scrolling so long histories do not stretch the sidebar. Commit rows are click targets: clicking a commit disables Follow and renders the full commit message in the main preview area. This avoids hover-only disclosure and keeps commit details readable in the same main surface used for document previews.

Alternatives considered:
- Include full commit history. This adds noise and can become expensive.
- Hide commit logs until hosted MR integration exists. Local commits are already useful when reviewing a branch.
- Show full commit messages in hover popovers. This is harder to read, less accessible, and conflicts with the preview area as the main detail surface.

### Use lighter scrollbars for pane overflow

Pane bodies, file trees, git logs, and preview code blocks should keep scrollbars available but visually quiet. Use thinner scrollbars with lighter thumb colors and transparent tracks where the platform allows styling. The goal is to preserve clear overflow affordances without making every pane boundary feel heavier than the content.

Alternatives considered:
- Hide scrollbars until interaction. This can make overflow harder to discover and behaves inconsistently across platforms.
- Keep default scrollbars. This is functional but visually heavy in a pane stack where several regions may scroll independently.

## Risks / Trade-offs

- Git commands may be slow in very large repositories -> use bounded commands, cache snapshots, refresh on existing debounce/reconcile cadence, and keep the preview usable if git data times out or fails.
- Base-ref detection can be wrong for unusual workflows -> always display the resolved base/fallback and allow `.uatu.json` to override it.
- Cognitive-load scores can be misread as quality judgments -> label the meter as review burden and make the score explanation compare the raw score against visible thresholds.
- Path-based risk config can become stale -> show matched files/areas explicitly so teams can notice when rules no longer reflect reality.
- Multiple repositories in one watch session increase UI complexity -> group review panes by repository and show a non-git/unsupported state per root rather than merging unrelated git state.
- Pane persistence can trap users in a hidden layout -> provide a `Panels` menu that can always restore hidden panes and keep whole-sidebar expand separate.
- Persisted pane sizes can exceed a later viewport height -> normalize pane heights into the current pane-stack height before rendering and while resizing.

## Migration Plan

- Ship with no required settings file; existing users see default panes and current file-tree behavior inside the `Files` pane.
- Reuse the existing sidebar collapse preference for whole-sidebar state and introduce separate localStorage keys for pane state.
- Introduce separate localStorage keys for pane state, Git Log history length, and expanded-sidebar width.
- If `.uatu.json` is absent or invalid, use built-in thresholds and neutral path scoring.
- Rollback is safe by removing the new pane/git/review code paths; document scanning and preview routes remain the core behavior.

## Open Questions

- Should the first implementation include a changed-files pane, or should changed files remain summarized in `Change Overview` while the existing `Files` pane stays full-tree only?
- Should review configuration eventually live in `.uatu.json` only, or should `package.json` support a `uatu` key for JavaScript projects?
