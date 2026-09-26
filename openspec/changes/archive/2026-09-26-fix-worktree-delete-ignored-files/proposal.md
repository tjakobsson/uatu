## Why

Deleting a Uatu-created worktree that contains ignored files (build output, `node_modules/`, a local `.env`) is refused today with "Move or delete them, then retry". A user who already understands those files will be lost has to clean them up by hand first (GitHub #443). Uncommitted changes and untracked files are refused the same way, so a throwaway experiment cannot be deleted from Uatu without first discarding its changes in a terminal. The warning is valuable and must stay. At the user's request, this change fixes #443 and applies the same acknowledgement to uncommitted and untracked data. The user can then review exactly what will be lost and delete the worktree together with that data in one explicit, cancellable step.

## What Changes

- Tracked changes, untracked files and ignored files no longer block deletion preflight on their own. Tracked changes are staged or unstaged modifications, additions, deletions and similar entries. Together, the three categories are *acknowledgeable local data*. When they are present and nothing else blocks, preflight answers `ok: true` with `localData`. For each category that is present, it reports the entry count and a short sorted sample of checkout-relative paths. It also includes one opaque `fingerprint` of the complete set of status entries across all three categories.
- The delete request accepts an optional `localDataFingerprint`. Deletion proceeds past local data only when that fingerprint matches the data found at every server recheck: the fenced re-preflight, the post-stop re-preflight and the final check right before Git runs. When local data exists and the fingerprint is missing, the request is refused as `local-data`, exactly as today, with the message for the first category present. When the fingerprint differs, the request is refused as `local-data` with "changed while deletion was prepared, review again". A malformed fingerprint is refused as `invalid-input`. In each case, checkout and registration are kept. A tree with no local data is deleted as before, whether or not a fingerprint was sent.
- **Removal mode:** ignored-only data still uses non-force `git worktree remove`, because Git already removes ignored files without force. When the acknowledged data includes tracked or untracked entries, Git refuses non-force removal. The Hub then passes exactly one `--force`, and never two. A single `--force` does not override a Git lock. A narrow, separately tested argument builder emits at most one `--force`.
- **Blockers:** the acknowledgement is not a force option, and no force flag is exposed to clients. The following still block unconditionally, before any removal and at every recheck, even with a matching fingerprint: Git locks, nested linked worktrees, Git operation markers, external activity, uncertain identity and ownership. Uatu also adds its own check for initialized submodules and nested Git repositories inside the checkout, because a single `--force` would delete them.
- **Branches and stashes:** the branch is always kept, so committed work is safe. Stashes live in the shared repository and are unaffected. Only working-tree data is discarded.
- **Dialog:** the delete dialog keeps the existing consequence line and adds a warning for each present category, with its count, sample and "and N more" when truncated. It says that these files will be permanently deleted with the worktree and cannot be recovered. A **required checkbox** ("Permanently delete these files with the worktree") follows the existing Forget dialog's pattern. Submitting unchecked shows "Confirm to continue. Nothing changed." in place and sends nothing. The destructive button keeps its labels, **Delete** or **Stop and delete**. The client sends the fingerprint only when the box is ticked. Cancel leaves the worktree unchanged. A clean tree still needs no checkbox.
- **Published documentation:** the worktree API (`preflight-delete` and `delete`), the OpenAPI contract, a new Hub revision 10 changelog entry, `docs/WORKTREES.md` and `ARCHITECTURE.md` describe the acknowledgement and the single-force removal. This change deliberately reverses the archived "no force override in this scope" decision for acknowledged local data only.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `git-worktree-workspaces`: **Manual deletion is guarded and distinct from forgetting** changes as follows:
  - Tracked, untracked and ignored local data is disclosed by category.
  - A required checkbox acknowledges the data, rather than the data always blocking.
  - Removal runs with a single Hub-side `--force` when acknowledged tracked or untracked data requires it.
  - A new submodule and nested-repository blocker is added.

  **Worktree operations are published as one authenticated JSON family** changes so preflight reports `localData` and the delete operation accepts the `localDataFingerprint` acknowledgement. Its "no force option" wording is replaced with an honest statement: no client-facing force flag exists, and the fingerprint never overrides the other blockers.

## Impact

- **Code:** `src/hub/worktree-delete.ts` (categorized local-data description and fingerprint from the existing porcelain probe, a submodule and nested-repository probe, `buildWorktreeRemoveArguments` with an at-most-one `--force` option, and local data no longer an unconditional blocker), `src/hub/worktree-service.ts` (preflight description, the acknowledgement check at every recheck, and choosing force or non-force from the final matching data), `src/hub/worktree-api.ts` (passes the new field through), `src/shared/worktree-contract.ts` (request/preflight types and their closed parsers), `src/shell/worktree-dialog.ts` (per-category warning, required checkbox, and submitting the fingerprint).
- **API:** `api/openapi.yaml` gains an additive optional `localDataFingerprint` on `DeleteWorktreeRequest` and `localData` on the `ok: true` shape of `WorktreeDeletionPreflight`. Its path, `confirm` and `error` descriptions that say "no force" are updated. They are published as Hub revision 10 (workspace revision stays 21), with their own "Hub 10 / Workspace 21" entry in `api/CHANGELOG.md` and the revision raised in `api/contract.json`, the OpenAPI `info.version` / `x-uatu-revisions` and `HUB_API_REVISION`. While this change was open, upstream published Hub revision 9 (#425), so the base already serves a closed preflight answer without `localData`; adding it is breaking for strict clients and needs a revision of its own rather than an amendment of an earlier entry. `api/operations.yaml` and `api/streaming.yaml` need no change.
- **Docs:** `docs/WORKTREES.md` ("Delete versus remove from Uatu") and the worktree section of `ARCHITECTURE.md`.
- **Tests:** unit tests for the fingerprint, the argument builder and the submodule probe; integration, API and dialog tests for deletion; contract parser tests; and a new local-data E2E case in `tests/e2e/worktree-ui.e2e.ts`.
- **Unchanged:** the journal and restart reconciler, branch handling, and non-force removal for clean and ignored-only trees.
- **Release:** the worktree feature is not in the latest stable tag (`v0.7.0`), so the fix PR carries a Release Please override that classifies it as stabilization of an unreleased feature.
