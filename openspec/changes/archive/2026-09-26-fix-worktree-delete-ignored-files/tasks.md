## 1. Shared contract

- [x] 1.1 In `src/shared/worktree-contract.ts`, add the following types and fields:
  - `WorktreeLocalDataCategory` (`{ count; sample }`) and `WorktreeLocalData` (`{ tracked?; untracked?; ignored?; fingerprint }`);
  - optional `localData` on the `ok: true` variant of `WorktreeDeletionPreflight`;
  - optional `localDataFingerprint` on `WorktreeDeleteRequest`.

  Rewrite the comments that say "the destructive button IS the authorization" and "there is no force path past it". The new comments say that a clean tree needs only the button, that local data additionally needs the fingerprint acknowledgement, and that no client-supplied force exists. Verify with `bun run typecheck`.
- [x] 1.2 Extend `parseWorktreeDeleteRequest` to accept `localDataFingerprint`, which must match `^[0-9a-f]{64}$`.

  Extend `parseWorktreeDeletionPreflight` to accept `localData` only when `ok: true`. It requires at least one category key and a 64-hex fingerprint. For each category, the count is a positive integer, and the sample has at most 5 entries and no more than the count. Each sample entry is non-empty and does not start with `/`.

  Verify with new cases in `src/shared/worktree-contract.test.ts` covering:
  - valid shapes with one or all three categories;
  - an empty `localData`, a zero count, a malformed fingerprint, an absolute sample path and an oversized sample;
  - `localData` on `ok: false`;
  - unknown category keys.

## 2. Removal safety

- [x] 2.1 In `src/hub/worktree-delete.ts`, extend the porcelain summary to collect `(XY, path)` entries per category (tracked, untracked, ignored) alongside the counts, keeping the rename/copy source skip. Build the local-data description:
  - per-category count, sorted entries and a sample of the first 5;
  - the fingerprint from design D1: SHA-256 hex over the domain tag, the checkout id and the path-sorted `XY` NUL `path` NUL entries.

  Change `inspectRemovalSafety` to return a blocked result or a clear result with an optional description, so local data no longer blocks there. Rewrite the header comment's "what blocks, and why" list to match.

  Verify with `src/hub/worktree-delete.test.ts`:
  - fingerprint determinism and independence from entry order;
  - a changed status code (` M` → `M `) or an added entry changes the fingerprint;
  - different checkout ids give different fingerprints;
  - a directory entry is counted once;
  - samples are bounded and sorted.
- [x] 2.2 Add the submodule and nested-repository probe from design D5 to `inspectRemovalSafety`, in the D5 order:
  - add `modules` to the `rev-parse --git-path` batch, apart from the operation markers, and block with `nested-dependency` when it exists, failing closed on an unreadable path;
  - for each `??` or `!!` entry ending in `/`, block with `nested-dependency` when `<checkout>/<entry>.git` exists;
  - on every inspection, run `git ls-files -z --stage` under its own larger bound (design D5 step 4), and block with `nested-dependency` when any mode `160000` entry has `<checkout>/<path>/.git`, or when any ancestor directory of an index path or status entry holds a repository — a `<dir>/.git`, or a bare repository or administrative directory (design D5 step 3) — checking directory entries and gitlinks the same way, in sorted order;
  - refuse as `identity-uncertain` ("could not be inspected") when the ls-files probe fails or exceeds its bound, or when any status or index path contains U+FFFD.

  Verify with `src/hub/worktree-delete.test.ts` and real-Git cases for:
  - an initialized submodule;
  - an uninitialized gitlink, which does not block;
  - an untracked nested repository;
  - a repository at the root of an ignored directory;
  - an embedded gitlink without `.gitmodules`;
  - a repository nested inside a tracked directory, for a clean tree and for one with local data;
  - a clean or ignored-only tree, where the `ls-files` probe runs with the larger bound and does not block;
  - synthetic status and ls-files output containing U+FFFD.
  - a nested bare repository, untracked (listed file by file), with only packed refs, and ignored as a directory entry; a Git administrative directory; a lone file named `HEAD`; a refusal naming the same path whatever the output order.
- [x] 2.3 Add the pure helper `checkLocalDataAcknowledgement(localData, fingerprint?)`. It passes when there is no local data, whatever was sent. When data exists and no fingerprint was sent, it returns `local-data` / `retry-delete` with the message for the first present category (tracked, untracked, ignored). Each message keeps today's advice and adds "or confirm deleting them with the worktree". When the fingerprint differs, it returns "The worktree's files changed while deletion was prepared. Review the deletion again." All messages end with "Nothing was removed." Verify with unit tests for each branch and each category's message.
- [x] 2.4 Replace `REMOVE_ARGUMENTS` and the never-force guard with `buildWorktreeRemoveArguments(checkoutPath, { force })`. It emits `worktree remove -- <path>` or `worktree remove --force -- <path>`, and throws `internal` unless the arguments contain exactly `force ? 1 : 0` of `-f` / `--force`. Thread `{ force }` through `runWorktreeRemove`, and add the pure `removalRequiresForce(localData)`, which is true only for tracked or untracked entries. Verify with `src/hub/worktree-delete.test.ts`:
  - the non-force shape is unchanged;
  - the force shape has exactly one `--force`, placed before `--`;
  - no input yields two force arguments;
  - `removalRequiresForce` is false for none or ignored-only data and true for tracked or untracked data;
  - separator and absolute-path guards still hold.

## 3. Service

- [x] 3.1 In `src/hub/worktree-service.ts`, have `preflightIn` return `ok: true` with `localData` when inspection is clear and data exists. Have `deleteWhileFenced` apply `checkLocalDataAcknowledgement` with `request.localDataFingerprint` at three points:
  - the fenced re-preflight (phase `preflight`);
  - the post-stop recheck (`rechecking`);
  - the final pre-Git inspection (`removing`), which keeps the "The worktree changed while deletion was prepared." prefix but does not double it on the mismatch message.

  Compute `force` only from the final, fingerprint-matched description via `removalRequiresForce`, and pass it to `runWorktreeRemove`. Nothing from the request may reach it directly. Update the in-code comments that say non-force protects tracked and untracked data. Verify with `bun run typecheck` and the integration tasks in section 7.

## 4. Published API

- [x] 4.1 In `src/hub/worktree-api.ts`, have `remove` pass `localDataFingerprint` through to `parseWorktreeDeleteRequest` when it is present, alongside `stop`, and update the "no force path" comment. Verify with a `src/hub/worktree-api.integration.test.ts` case where a malformed fingerprint yields an `ok: false` `invalid-input` answer with HTTP 200 and nothing removed.
- [x] 4.2 In `api/openapi.yaml`, add `localDataFingerprint` to `DeleteWorktreeRequest` and `localData` to `WorktreeDeletionPreflight`, with new `WorktreeLocalData` / `WorktreeLocalDataCategory` component schemas closed by `additionalProperties: false`. Update the preflight-delete and delete path descriptions, and the `confirm` and `error` descriptions that say "no force anywhere" or "no force path past it". The new wording states that no client-facing force exists, that the acknowledgement never overrides other blockers, and that the Hub may pass Git a single force only for acknowledged tracked or untracked data. Add an `ok: true` preflight example carrying `localData` with several categories. Verify with `bun run api:validate` and `bun run test:api`.
- [x] 4.3 Publish the change as Hub revision 10 (workspace stays 21), because upstream published Hub revision 9 while this change was open (design, Migration Plan):
  - add a "Hub 10 / Workspace 21 - Unreleased" entry to `api/CHANGELOG.md`, `Compatibility: breaking (Hub)`, describing `localData` and the `localDataFingerprint` acknowledgement with the honest force statement, and leave the earlier entries exactly as upstream publishes them;
  - add migration guidance: strict clients regenerate against revision 10, and a client that omits the fingerprint is refused as before;
  - raise the revision in `api/contract.json`, the OpenAPI `info.version` / `x-uatu-revisions` / examples and `HUB_API_REVISION`.

  Confirm that `api/operations.yaml` and `api/streaming.yaml` need no change. Verify with the CI compatibility check (`scripts/api-contract/compatibility.ts` against the merge base), `bun run api:validate` and `bun run test:api`.

## 5. Client dialog

- [x] 5.1 In `src/shell/worktree-dialog.ts`, store the preflight's `localData` next to `requiresStop`, and reset it wherever `requiresStop` is reset. When it is present, render the design D7 warning:
  - the permanent-deletion sentence, plus the note that branch commits are kept;
  - one entry per present category, in the order tracked, untracked, ignored, each with its count, escaped sample list and "and N more" when truncated;
  - the required `acknowledge` checkbox, using the Forget markup, labelled "Permanently delete these files with the worktree.".

  The danger button keeps "Delete" / "Stop and delete". A clean tree renders no warning and no checkbox. Verify with `src/shell/worktree-dialog.test.ts` cases covering:
  - each single category and all three together;
  - stopped and running variants;
  - truncation text;
  - HTML escaping of a sample path;
  - no checkbox for a clean tree.
- [x] 5.2 In `submitDelete`, when `localData` is present and the checkbox is unchecked, show "Confirm to continue. Nothing changed." in place and send nothing, mirroring `submitForget`. When the box is ticked, send `localDataFingerprint`. Never send it for a clean tree. Show any other server refusal in place as today. For a `local-data` refusal, such as a changed fingerprint, re-run the preflight and show the updated warning with an unticked checkbox and the refusal as an alert, or the blocker that preflight now finds (design D7). Verify with dialog tests that assert:
  - an unchecked submit sends no request;
  - the posted body with and without `localData`;
  - a `local-data` refusal re-runs preflight and shows the updated warning, unticked, with the reason; a new blocker from that preflight shows the alert and Cancel only; any other refusal replaces the form with the alert and Cancel only.
- [x] 5.3 In `src/shell/worktree-dialog.test.ts`, update the "every preflight blocker replaces the consequences and offers only Cancel" table. Remove the tracked, untracked and ignored `local-data` preflight rows, because local data is no longer a preflight blocker. Keep a `local-data` delete-refusal case under 5.2, and add a `nested-dependency` submodule row. Verify with `bun test src/shell/worktree-dialog.test.ts`.

## 6. Documentation

- [x] 6.1 In the "Delete versus remove from Uatu" section of `docs/WORKTREES.md`, explain:
  - uncommitted changes, untracked files and ignored files are listed, and ticking "Permanently delete these files with the worktree" deletes them with the worktree;
  - changed data is refused and must be reviewed again;
  - the branch and its commits, and the repository's stashes, are kept;
  - locks, nested worktrees, submodules and nested repositories, Git operations in progress, external activity and uncertain ownership still block.

  Replace "There is no force option" with honest wording: there is no force option, and the acknowledgement lets Uatu pass Git a single force only for exactly the listed data. Mention the status-level coverage: further edits to a listed file are covered. Verify by reading the section against the spec scenarios.
- [x] 6.2 Update the worktree deletion description in `ARCHITECTURE.md` (around lines 298–316) to cover:
  - the local-data description and fingerprint;
  - the recheck at all three checks;
  - the submodule and nested-repository probe;
  - non-force removal by default, and the single-force case derived from the final matched data.

  Verify by reading the section against `design.md` D1–D5.

## 7. Tests

- [x] 7.1 In `src/hub/worktree-lifecycle.integration.test.ts`, change the tracked, untracked and ignored rows of the table-driven deletion preflight (5.3) so they assert `ok: true` with the matching `localData` category (count, sample and fingerprint). Lock, operation-marker and nested-worktree rows still block, and new rows cover an initialized submodule and an untracked nested repository as `nested-dependency`. Verify that the file passes under `bun test`.
- [x] 7.2 Add integration cases for acknowledged deletion. Each uses a real Git repository through the service.
  - An acknowledged delete of a tree with a modified tracked file, a staged file, an untracked file, an ignored `.env` and an ignored `node_modules/` removes the checkout with a single `--force`, as asserted through a recording runner. It also unregisters the checkout and keeps the branch at its commit.
  - An acknowledged ignored-only delete removes the checkout without `--force`.
  - A delete without a fingerprint is refused as `local-data`, with the checkout and registration kept.
  - An acknowledged running delete with `stop: true` succeeds after the post-stop recheck.

  Verify with `bun test src/hub/worktree-lifecycle.integration.test.ts`.
- [x] 7.3 Add refusal cases in which a matching fingerprint still refuses. Cover a Git lock, an initialized submodule, an untracked nested repository and an operation marker. Each is refused with its blocker, nothing is removed, the registration is kept, and Git removal is never invoked. Also confirm that no recorded Git call ever carries two force arguments. Verify with `bun test src/hub/worktree-lifecycle.integration.test.ts`.
- [x] 7.4 Adapt the "ignored data appearing after the recheck (%s)" cases (ignored file, changed ignore rules), and add tracked-modification and new-untracked-file variants. Each variant covers two situations. In the first, deletion was prepared for a clean tree and the request sends no fingerprint. In the second, deletion was acknowledged for set A and the data becomes B before the final check. Both are refused with `local-data`, with nothing removed and the registration kept. Also add cases that pin the documented status-level trade-off: a file added inside an already-acknowledged ignored directory, and a further edit to an already-listed modified file, both proceed. Verify with `bun test src/hub/worktree-lifecycle.integration.test.ts`.
- [x] 7.5 In `src/hub/worktree-api.integration.test.ts`, add HTTP-level cases:
  - `preflight-delete` returns `localData` with categories;
  - `delete` with a matching `localDataFingerprint` succeeds;
  - `delete` with a stale fingerprint answers HTTP 200 with `ok: false` / `local-data`.

  Verify with `bun test src/hub/worktree-api.integration.test.ts`.
- [x] 7.6 In `tests/e2e/worktree-ui.e2e.ts`, add an E2E case for a Uatu-created worktree with a modified tracked file, an untracked file and a gitignored `.env`:
  - "Delete worktree" on the Hub dashboard shows the per-category warning, samples and the unchecked checkbox;
  - submitting unchecked shows "Confirm to continue. Nothing changed." and keeps the worktree;
  - Cancel keeps the worktree;
  - ticking the box and confirming deletes it and shows "Worktree deleted. Branch kept.".

  Capture evidence through `tests/e2e/evidence.ts`, never writing into `openspec/`. Verify with `bunx playwright test tests/e2e/worktree-ui.e2e.ts`.

## 8. Verification and release

- [x] 8.1 Run `bun run typecheck`, `bun test`, `bun run test:api` and `bun run api:validate`, and verify that all pass.
- [x] 8.2 Run the worktree E2E suites (`bunx playwright test tests/e2e/worktree-ui.e2e.ts tests/e2e/worktree-integration.e2e.ts tests/e2e/worktree-webkit.e2e.ts`) and verify that they pass.
- [x] 8.3 Run `bun run build` and verify that it produces `dist/uatu` without errors.
- [x] 8.4 At PR time, regenerate the dialog screenshots with `UATU_E2E_SCREENSHOTS_DIR=openspec/changes/fix-worktree-delete-ignored-files/screenshots bunx playwright test tests/e2e/worktree-ui.e2e.ts`. Verify that the per-category warning with the checkbox, and the unchecked-refusal state, appear in the folder.
- [x] 8.5 Prepare the PR with a truthful `fix(worktrees): …` title. Note that the worktree feature is absent from stable `v0.7.0`, and that the change deliberately reverses the archived "no force override" decision for acknowledged local data. Put a `BEGIN_COMMIT_OVERRIDE` / `chore(worktrees): stabilize the unreleased worktree feature before release` / `END_COMMIT_OVERRIDE` block in the body, and reference GitHub #443. Verify the body before publishing, and present it for user approval.
