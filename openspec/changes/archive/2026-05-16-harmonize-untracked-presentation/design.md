## Context

`review-load` is the single source of truth for "what counts as a change" in a watched repository. Two UI surfaces consume its output:

1. **The document tree** (`@pierre/trees` via `src/tree-view.ts`), via `setGitStatus(entries)`. The library supports a fixed set of statuses including `untracked`.
2. **The `Change Overview` pane and its score-explanation preview** (`src/app.ts:renderChangeOverview` + the score-explanation route), which present the burden score and its drivers.

Both surfaces consume the same `ChangedFileSummary[]` list, so the *set* of files is already coherent. The *category labelling* is not. In `src/review-load.ts:collectUntrackedFiles` every untracked file is written out with `status: "A"`, which means:

- `app.ts:mapChangedFileStatus` never sees a `"?"` or `"U"` first character and its dedicated untracked branch is dead code; every untracked file maps to `"added"` before reaching the tree.
- The tree renders an "added" annotation for untracked files even though `@pierre/trees`'s `GitStatus` enum includes `'untracked'` and `document-tree`'s requirement "Surface git status as row annotations on tree entries" already mandates `added, modified, deleted, and untracked` as distinct categories. So the current implementation violates an existing spec without any external observer noticing.
- The Change Overview pane reflects untracked only through the binary `Status: dirty` line (`meta.dirty` is computed from `git status --porcelain=v1`, which counts `??` rows). There is no categorical signal at all.

The `sidebar-shell` capability constrains how this can be fixed in the pane itself: it explicitly forbids the Change Overview pane from listing raw mechanical statistics such as changed-file count, touched-line count, diff-hunk count, or directory spread directly. Per that requirement those numbers live only inside the score-explanation preview. An untracked *count* in the pane is therefore off the table; a categorical *indicator* (presence/absence) is consistent with the existing `dirty` flag treatment.

## Goals / Non-Goals

**Goals:**

- One internal definition of "change category" reaches every UI surface. An untracked file is labelled "untracked" in the tree, in the score-explanation preview's drivers, and (categorically) in the Change Overview pane.
- The fix is mechanical and low-risk: it tightens the value range of an existing field rather than reshaping data structures.
- The Change Overview pane keeps obeying `sidebar-shell`'s "no raw mechanical counts in the sidebar" rule. The breakdown number lives only in the score-explanation preview.
- Lay groundwork for the follow-up "filter tree to changed files only" change so that filter can declare "shows everything in `reviewLoad.changedFiles`" without inheriting any disguising.

**Non-Goals:**

- Changing how untracked files contribute to the review-burden score (they continue counting at current weight).
- Adding a tree-level filter UI to hide non-changed files. That's a separate change.
- Adjusting `.uatuignore`/`.gitignore`/`tree.exclude` interaction with untracked files.
- Suggesting that an untracked file be added to `.uatu.json tree.exclude` (a nice future affordance, but explicitly out of scope here to keep this change tight).
- Surfacing untracked-specific row affordances (right-click menus, "stage this", etc.) — the tree remains read-only.

## Decisions

### D1. Emit `"?"` for untracked, not `"U"` or a renamed field

**Decision**: `collectUntrackedFiles` writes `status: "?"`.

**Why**: `mapChangedFileStatus` already maps both `"?"` and `"U"` to `"untracked"`. `"?"` matches `git status --porcelain` conventions, which is the closest precedent in this codebase. Keeping the field as a one- or two-character status code (rather than introducing a new `kind: 'untracked'` field) avoids reshaping `ChangedFileSummary` and avoids breaking any downstream consumer that case-matches on `status[0]`.

**Alternatives considered**:

- *Introduce a new `kind` field*: clean, but a wider blast radius for what is fundamentally a one-character fix. Rejected.
- *Emit `"U"`*: equally workable, but git itself uses `?` for untracked-in-porcelain and reserves `U` for unmerged. Matching git's convention is a tiebreaker.

### D1a. Use `git diff --name-status` to label tracked changes correctly

**Decision**: `collectDiffFiles` runs `git diff --name-status -M ...rangeArgs` in parallel with the existing `--numstat` and `--unified=0` (hunks) probes, then stamps each `ChangedFileSummary`'s `status` from the name-status output rather than heuristically guessing `"M"` from the numstat row.

**Why**: `git diff --numstat` has no way to tell additions from modifications — both render as two integers and a path. Today `parseNumstatLine` returns `"M"` for everything that doesn't look like a rename, which means a staged-but-uncommitted *new* file is labelled `"M"` and ends up routed to the `"modified"` annotation in the tree. That's a quiet correctness bug independent of untracked. `--name-status` produces one letter per row (`A`/`M`/`D`/`R<sim>`/`C<sim>`/`T`) keyed by the same `-M` rename-detection settings, so joining the two outputs by path gives the correct letter without re-implementing rename detection. The third git invocation is cheap (it's the same diff already being computed twice).

Discovered during implementation: my first test for "staged-added emits `A`" failed because `parseNumstatLine` returns `M`. Without this decision the untracked fix would land but a staged-new file would still be mis-categorised — the very mismatch this change exists to remove, just one row over.

**Alternatives considered**:

- *Use `--raw -M`*: one invocation, includes both status and counts in a single output. Workable, but the raw format is harder to parse than name-status (line-mode markers, optional similarity scores, score-delta columns) and would require a larger rewrite of `parseNumstatLine`. Rejected.
- *Leave staged-added emitting `"M"` and only fix untracked*: keeps the change small but means "added" remains a status the codebase can produce only for committed history, which is asymmetric with how the tree's annotation set thinks. Rejected after the failing test surfaced the mismatch.

### D2. Categorical indicator in Change Overview, count in the score-explanation preview

**Decision**: `Change Overview` gains a small categorical badge (or inline note) that reads, e.g., "Includes untracked files" when `changedFiles` contains at least one untracked entry. No number in the pane. The score-explanation preview, which already lists factual change-shape drivers, additionally breaks out the untracked subcount as one of those drivers.

**Why**: `sidebar-shell`'s "Render review-load summary in the Change Overview pane" requirement forbids raw mechanical counts in the sidebar. A categorical presence flag is the same shape as the existing `Status: dirty` line — a status, not a statistic. Reviewers who want the number click through to the score explanation, matching the existing "click the score for details" flow.

**Alternatives considered**:

- *Show "N untracked" in the pane*: explicit, but violates the sidebar-shell requirement above and would be a spec change to that capability beyond what's needed. Rejected.
- *Show nothing in the pane and only break it out in the score explanation*: cheaper but loses ambient visibility. Untracked files frequently *should be reviewed and committed* or *should be ignored* — a categorical pane signal is worth the small visual cost. Rejected in favor of the badge.

### D3. No `document-tree` spec change

**Decision**: `document-tree` already mandates `untracked` as one of the supported annotation statuses ("at minimum: added, modified, deleted, and untracked"). The current state is an implementation gap, not a spec gap. We add a verification scenario in the proposal's tasks but no delta-spec for `document-tree`.

**Why**: introducing a delta-spec that says "the spec must say X" when the spec already says X just adds noise to the archive. The fix is to make the implementation conform.

### D4. Untracked weight in burden score stays as-is

**Decision**: untracked files continue contributing to the burden score at the same per-file weight as tracked changed files (because they remain in the merged `changedFiles` list with `additions = file line count`, `deletions = 0`, `hunks = additions > 0 ? 1 : 0`).

**Why**: undercounting untracked masks files that absolutely *should* be in the review. A 500-line `new-module.ts` that hasn't been added to git yet is arguably *more* attention-worthy than a 5-line tweak to a committed file, not less. Reviewers can use the new categorical signal to *find* untracked files; the burden score continues to reflect total reading load.

### D6. Tree annotations source from `changedFiles + ignoredFiles`; score sources from `changedFiles` only

**Decision**: `app.ts:collectGitStatusEntries` iterates the union of `repo.reviewLoad.changedFiles` and `repo.reviewLoad.ignoredFiles`. The `hasUntracked` predicate in `renderChangeOverview` likewise considers both arrays. The score-explanation preview's "Untracked files" sub-driver continues to use `changedFiles` only.

**Why**: `.uatu.json review.ignoreAreas` exists to keep the *burden score* clean — generated files, agent configs, OpenSpec scaffolding, etc. should not inflate the number a reviewer compares against thresholds. But the file tree's row annotations and the Change Overview's categorical indicator answer a different question: *what is the git state of this workspace?* That answer must not depend on score policy.

The bug surfaces in this codebase concretely: `.uatu.json` includes `{ "label": "OpenSpec Tasks and Specs", "paths": ["openspec/**/tasks.md", "openspec/**/spec.md"] }`. When OpenSpec scaffolds a change, six new untracked files appear under `openspec/changes/<name>/`. Three of them (`proposal.md`, `design.md`, `.openspec.yaml`) get the untracked annotation; the other three (`tasks.md` and two `spec.md` files) silently lose their annotation because review-load routed them into `ignoredFiles`. Reviewers cannot distinguish "I've staged this" from "it's still untracked" for the files that *most* need that signal during an OpenSpec workflow.

The split — annotations from both lists, score from one — preserves the user's stated policy ("don't inflate my score with task files") while correcting the unintended side-effect ("hide them from the tree").

**Alternatives considered**:

- *Add a new `allChangedFiles` field on `ReviewLoadResult`*: cleaner contract (consumers explicitly choose the unfiltered set). But it duplicates data and forces every consumer to pick the right field; missing the pick is the same shape of bug we're fixing. Rejected as bigger blast radius than the actual fix needs.
- *Stop populating `ignoredFiles` entirely (route ignored entries back into `changedFiles` with a flag)*: would change a number of unrelated surfaces (drivers, configured areas, ignored-summary). Rejected as out-of-scope churn.
- *Keep the conflation and tell users to drop `ignoreAreas`*: would force users to choose between a clean score and an honest tree. Rejected — these are independent concerns and should be controllable independently.

### D7. Gitignored files surface through a separate field, intersected server-side

**Decision**: Add `ReviewLoadResult.gitIgnoredFiles: string[]` populated by a third git probe (`git ls-files --others --ignored --exclude-standard`) intersected server-side against the tree's known paths. Map `"!"` → `"ignored"` in `mapChangedFileStatus`. `collectGitStatusEntries` emits annotation entries for `gitIgnoredFiles` separately from the existing changed/ignored loops.

**Why**: Without this, files matched by git's standard ignore rules — most notably the user's global `core.excludesFile` (e.g. `**/.claude/settings.local.json`) — appear in uatu's tree with no annotation, visually identical to a clean tracked file. Reviewers cannot distinguish "nothing happening here" from "git is intentionally not following this." `@pierre/trees`' status enum already includes `'ignored'`; the library has the conventional rendering ready. The data layer is what was missing.

The probe is intersected server-side because `git ls-files --others --ignored --exclude-standard` in this repo returns ~20,000 entries (the vast majority under `node_modules` / `.opencode/node_modules`). All but a handful are filtered out of uatu's tree by `tree.exclude` defaults, so emitting them to the client is pure waste — they'd be annotated against a path set that doesn't contain them and silently dropped. The intersection trims the payload to only paths the tree will actually use; in this repo's case, that drops 20k entries to a handful.

The intersection requires realpath-resolving both the repo root and each watched root because `git rev-parse --show-toplevel` returns the canonical (symlink-resolved) path while the caller's `RootGroup.path` may be the original input. On macOS specifically `/tmp` → `/private/tmp` would otherwise produce relative-path ladders like `"../../tmp/foo/file"` that match nothing. The cost is one `fs.realpath` call per watched root per refresh — negligible.

`gitIgnoredFiles` is a string array rather than `ChangedFileSummary[]` because gitignored entries have no useful additions/deletions/hunks metadata — they're not "changes," they're "noticed-but-not-tracked." The leaner shape also keeps consumers from accidentally counting them as changes.

**Alternatives considered**:

- *Roll gitignored entries into `changedFiles` with status `"!"`*: would mean every existing consumer that iterates `changedFiles` (the score, the burden meter, the indicators) needs to know to skip `"!"` entries. Bug-prone. Rejected.
- *Ship the full ignored set to the client and intersect there*: works correctly but inflates the wire payload by ~2 MB per state broadcast in this repo alone. Rejected.
- *Skip the intersection and accept the wire cost*: as above. Rejected.
- *Use `git check-ignore --stdin` to ask per-tree-path instead of listing all ignored files and intersecting*: more precise, but requires piping all tree paths into git's stdin per refresh — more invocations / more I/O than the single ls-files call. Rejected for now; can revisit if the ignored set ever becomes the bottleneck.

### D5. Tests pin the contract at the data boundary

**Decision**: the primary regression test lives in `src/review-load.test.ts` and asserts `collectUntrackedFiles`-derived entries have `status: "?"`. The tree's distinct-annotation behavior gets one e2e or DOM-level assertion (rather than ten) because the mapping in `app.ts:mapChangedFileStatus` is already deterministic — once review-load emits `"?"`, the tree mapping is exercised by existing follow-on tests.

**Why**: keep the test additions proportional to the change. The contract sits at one function; one assertion at that function plus a thin end-to-end smoke check is enough.

## Risks / Trade-offs

- **[Risk] A consumer relies on `"A"` covering both added and untracked.** → Mitigation: grep confirms `mapChangedFileStatus` (the one canonical consumer in this repo) already routes `"?"` → `"untracked"`. We sweep for other `status[0]` switches as part of the implementation and update or assert each. If a consumer exists that *intentionally* wants "added or untracked together", it can match `["A", "?"].includes(status[0])` explicitly.
- **[Risk] Visual noise: every uatu development session has untracked files (logs, scratch).** → Mitigation: the categorical badge is one line of pane content that only renders when `changedFiles` actually contains an untracked entry. It does not appear on a clean tree.
- **[Trade-off] The badge surfaces a category but not the file.** A user who reads "Includes untracked files" still has to look at the tree to find which row. → Accepted: with distinct annotations now landing in the tree, scanning is exactly the affordance that complements the pane signal. Adding a clickable file list to the pane would re-litigate the "no second tree" decision from `document-tree`.
- **[Risk] Score-explanation preview already constrained by `change-review-load`'s "explainable drivers" requirement.** Adding an untracked sub-driver must not change the *score*, only its presentation. → Mitigation: the score is computed from `changedFiles` regardless of untracked categorization; adding a sub-driver row is presentation-only.
- **[Trade-off] We are walking back a small piece of "annotations alone are sufficient"** by adding a pane-level untracked indicator. → Accepted because the pane indicator answers a *different* question ("does this change include untracked work?") than the per-row annotation ("which file is untracked?"). The two complement each other rather than overlap.

## Migration Plan

No migration. Internal data shape stays compatible (`status` is still `string`, just with a new permitted value). No persisted state references untracked statuses. The change ships in a single deploy.

## Open Questions

- Should the untracked categorical badge in Change Overview link to the score-explanation preview (to give one-click access to the count) or stay purely informational? Leaning informational to avoid adding a third clickable element to a small pane, but happy to flip if it tests poorly.
- The "Includes untracked files" copy is a placeholder. Final wording can be settled during implementation review.
