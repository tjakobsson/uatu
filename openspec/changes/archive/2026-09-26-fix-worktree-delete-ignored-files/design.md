## Context

See `proposal.md` for the motivation and `specs/git-worktree-workspaces/spec.md` for the required behavior. The facts below constrain how this change can be built.

- `inspectRemovalSafety` (`src/hub/worktree-delete.ts`) returns the first blocker it finds. It checks, in order:
  1. identity;
  2. lock;
  3. nested linked worktree;
  4. Git operation markers, resolved through one `rev-parse --path-format=absolute --git-path …` batch;
  5. local data, from one `git status --porcelain=v1 -z --untracked-files=all --ignored=matching --no-renames` probe.

  The probe's `summarizePorcelainStatus` counts `??` as untracked, `!!` as ignored and every other code as tracked. The inspection then checks tracked changes, untracked files and ignored files in that order, and reports each as `local-data`. With `--ignored=matching`, a wholly ignored directory is a single `!! dir/` entry, so counts are entries, not files.
- Removal is always `git worktree remove -- <path>`. `REMOVE_ARGUMENTS` never contains `--force`, and `buildWorktreeRemoveArguments` throws if it ever would.
- Verified with Git 2.55 (behavior is documented in `git-worktree(1)`):
  - **Non-force removal** refuses modified or untracked files ("contains modified or untracked files, use --force to delete it"). It also refuses a tree with a populated submodule, or with a per-worktree `modules` Git directory ("working trees containing submodules cannot be moved or removed"). It deletes ignored files silently.
  - **A single `--force`** skips both of those checks and deletes the checkout. For a linked worktree, that includes submodule repositories stored in its administrative directory at `<gitdir>/worktrees/<id>/modules` (`git rev-parse --git-path modules`).
  - **A lock** still refuses a single `--force` ("use 'remove -f -f' to override"). A gitlink that was never initialized has an empty directory and does not block.
  - **Nested repositories:** an untracked nested repository appears in the porcelain probe as one `?? dir/` entry, because Git does not descend into it. A repository inside an ignored directory is hidden behind that directory's `!! dir/` entry.
- The Git floor is 2.36 (`WORKTREE_GIT_MINIMUM_VERSION`), so `git ls-files --format` (2.38) is unavailable. Every Git probe goes through the bounded runner (4 MiB default output limit), and an exceeded bound fails closed. The runner decodes output leniently, so bytes that are not valid UTF-8 arrive as U+FFFD.
- Implementation found that `git worktree remove` deletes a repository nested inside a *tracked* directory even without force: Git still lists the tracked files there, the outer status stays clean, and neither Git check sees the nested `.git` (verified with Git 2.55).
- `WorktreeService.delete` runs the safety inspection up to three times: the fenced re-preflight (`preflightIn`), the re-preflight after sessions stop, and a final `inspectRemovalSafety` immediately before Git. It has one authorization flag today, `stop`. Preflight returns `requiresStop`, the dialog shows "Stop and delete" and sends `stop: true`, and the server refuses `requiresStop && !stop` under the fence. This change mirrors that pattern.
- Contract parsers in `src/shared/worktree-contract.ts` accept an exact set of keys, and the client validates responses with the same parsers. The OpenAPI schemas use `additionalProperties: false`.
- The Forget view in `src/shell/worktree-dialog.ts` already uses a required checkbox. The form renders `<label class="check"><input type="checkbox" name="confirm" required>…</label>`, the button stays enabled, and `submitForget` refuses an unchecked submit in place with "Confirm to continue. Nothing changed." without sending anything.
- The journal and reconciler never re-run removal after a restart. They only reconcile the outcome, so an authorization never needs to outlive one request.
- The archived design for `add-git-worktree-workspaces` (`openspec/changes/archive/2026-09-20-add-git-worktree-workspaces/design.md`, section 6 and Risks) recorded "block removal on local data … no force override in this scope". **This change deliberately reverses that decision** for local data that the user has explicitly acknowledged, and only for that data. The Hub may pass Git a single `--force` when acknowledged tracked or untracked data requires it. Clients still have no force flag, and no other blocker gains an override.

## Goals / Non-Goals

**Goals:**
- The acknowledgement binds to the exact set of local-data status entries the user was shown, across tracked changes, untracked files and ignored entries. The server re-verifies it at every recheck, including the final one before Git.
- The request stays stateless: nothing is stored between preflight and delete, and nothing new is journaled.
- Clients that never send the acknowledgement keep today's behavior: local data blocks.
- `--force` appears only in one narrow, separately tested case. Every other blocker still refuses, including the new submodule and nested-repository blocker.

**Non-Goals:**
- No client-facing force flag, no double force, and no override for locks, nested worktrees, submodules, nested repositories, operation markers, external activity, identity uncertainty or ownership.
- No backup, trash, automatic stash or copy of local data before removal.
- No per-file or per-category selection. The user acknowledges the whole reported set or cancels.
- No branch deletion. Commits on the branch and the repository's stashes are unaffected.
- Closing the pre-existing race with external writers after the final probe is out of scope. Its forced variant is described under Risks.
- Detecting repositories nested deep inside an ignored directory entry is out of scope. See Risks.

## Decisions

### D1. Bind the acknowledgement with a fingerprint of all local-data status entries

The server computes the fingerprint from the existing porcelain probe as lowercase hex SHA-256. The UTF-8 hash input is:

- a domain tag, `uatu-worktree-local-data-v1`, then NUL;
- the checkout id, then NUL;
- for every tracked, untracked or ignored entry, sorted by path using plain code-unit comparison, `<XY status code>` NUL `<path>` NUL.

`--no-renames` guarantees that each path appears at most once. Including the checkout id keeps a fingerprint from one tree from ever matching another. Including the status code means that any change after review changes the fingerprint and is refused. Examples include staging a reviewed file, deleting a tracked file, and a new untracked or top-level ignored entry.

Preflight publishes the fingerprint with the per-category description. The delete request echoes it back, and each recheck recomputes it from a fresh probe and compares.

- *Alternative: a bare boolean such as `discardLocalData: true`.* Rejected. It would authorize deleting whatever exists at removal time, including a `.env` or uncommitted work created after the user looked. That breaks "the acknowledgement covers exactly what was shown".
- *Alternative: a server-issued token stored between preflight and delete.* Rejected. It adds state, expiry and multi-tab cases, and the token would still need to be tied to the tree's contents. A deterministic fingerprint can be recomputed at every recheck and needs no storage.
- *Alternative: send the full path list back.* This has the same semantics, but the payload is unbounded and the server would have to trust a client-supplied list.
- *Alternative: hash file contents.* Rejected. It is unbounded I/O over `node_modules/` or large untracked files at three rechecks. The status-level trade-off is accepted under Risks.
- *Alternative: `--ignored=traditional` to enumerate files inside ignored directories.* Rejected. It can produce tens of thousands of entries, hits the output bound and fails closed.

### D2. Wire shape

```ts
type WorktreeLocalDataCategory = { count: number; sample: string[] };
type WorktreeLocalData = {
  tracked?: WorktreeLocalDataCategory;   // staged or unstaged changes to tracked files
  untracked?: WorktreeLocalDataCategory; // `??` entries
  ignored?: WorktreeLocalDataCategory;   // `!!` entries (a directory counts once)
  fingerprint: string;                   // 64 lowercase hex
};
```

- `WorktreeDeletionPreflight` `ok: true` gains optional `localData: WorktreeLocalData`. It is present only when at least one category exists, and it is never allowed on `ok: false`. A category key is present only when its count is at least 1.
- `sample` holds up to five of that category's entries, sorted. The limit is one shared constant, `WORKTREE_LOCAL_DATA_SAMPLE_LIMIT` in `src/shared/worktree-contract.ts`, used by the Hub's description and by the closed parser through its injected vocabulary; a test ties it to the OpenAPI `maxItems` too. *(Review change: the Hub and the parser first carried separate literals.)* Paths are checkout-relative, keep Git's trailing `/` for directories, and are never absolute.
- `WorktreeDeleteRequest` gains optional `localDataFingerprint: string`.
- The closed parsers accept the new keys. `localDataFingerprint` must match `^[0-9a-f]{64}$`. A malformed value is `invalid-input` through the API's existing parse-refusal path. `localData` must have at least one category key and a 64-hex fingerprint. Each category's count must be a positive integer, and its sample must have at most five entries and no more than the count. Each sample entry must be a non-empty string that does not start with `/`.
- `worktree-api.ts` `remove` passes `localDataFingerprint` through when it is present, exactly as it does for `stop`.
- OpenAPI adds the `WorktreeLocalData` and `WorktreeLocalDataCategory` component schemas, both with `additionalProperties: false`.
- *Alternative: keep the earlier `ignored` / `ignoredFingerprint` names and add siblings.* Rejected. One fingerprint must cover all categories so that the acknowledgement is atomic, and the unreleased contract can still be renamed freely.

### D3. Inspection describes local data; one helper decides

`inspectRemovalSafety` returns either `{ blocked: WorktreeOperationError }` or `{ clear: true; localData?: LocalDataDescription }`. A blocked result is the first blocker in the order from D5. A local-data description carries the per-category counts, sorted entries and samples, and the fingerprint.

`summarizePorcelainStatus`, or a sibling function, collects the `(XY, path)` entries per category alongside the counts. It keeps the rename/copy source-field skip for safety, even though `--no-renames` is set.

A pure helper, `checkLocalDataAcknowledgement(localData, fingerprint?)`, returns either nothing or a `local-data` error:

- **No local data.** The helper passes, whether or not a fingerprint was sent.
- **Local data without a fingerprint.** The error carries the message for the first category present, in today's order (tracked, untracked, ignored). Each message keeps today's advice and adds the acknowledgement path. For example: "It has uncommitted changes (3 files). Commit, stash or discard them, or confirm deleting them with the worktree. Nothing was removed." The untracked and ignored messages follow the same pattern.
- **Mismatch.** The error message is "The worktree's files changed while deletion was prepared. Review the deletion again. Nothing was removed." Its retry is `refresh`, not `retry-delete`: resending the same request can never succeed, only a new preflight can. The missing-acknowledgement refusal keeps `retry-delete`, since cleaning up the data and retrying is still valid. The ignored message counts items rather than files ("It has ignored files or folders (2 items), …"), because one entry may be a whole folder.

`preflightIn` returns `ok: true` with `localData` when inspection is clear and data exists. `deleteWhileFenced` applies the rule at all three checks, with phases `preflight`, `rechecking` and `removing`, through ONE wrapper, `localDataRefusal(localData, fingerprint, phase, prefix?)` in `worktree-delete.ts`, so the three places cannot drift apart; each passes only its phase, and the final check its prefix. *(Review change: the three checks first applied the rule inline.)* The final check keeps its existing "The worktree changed while deletion was prepared." prefix for blockers and for the no-fingerprint message, and the post-stop recheck uses the same prefix for its no-fingerprint message, but neither adds it to the mismatch message, which already says so. Both run only after the fenced check passed, so any refusal there is data that appeared meanwhile. The fenced check itself uses no prefix: without a fingerprint it cannot tell data that appeared since the caller's preflight from a caller that never acknowledged it. *(Review change: the post-stop recheck first had no prefix.)* Because D5's blockers run before the data description, a tree with a lock or a submodule reports that blocker, and preflight never offers an acknowledgement for it.

- *Alternative: pass the acknowledgement into `inspectRemovalSafety`.* Rejected. It mixes the read-only probe with authorization policy, and preflight would still need the description.

### D4. Removal mode: non-force by default, exactly one `--force` only for acknowledged tracked or untracked data

- `buildWorktreeRemoveArguments(checkoutPath, { force }: { force: boolean })` emits `["worktree", "remove", "--", path]` or `["worktree", "remove", "--force", "--", path]`. It then asserts that the arguments contain exactly `force ? 1 : 0` occurrences of `-f` or `--force`, and throws `internal` otherwise. No code path can produce `-f -f`, `--force --force` or `-ff`.
- `runWorktreeRemove(run, mainPath, checkoutPath, { force })` threads the flag through. The service never reads `force` from the request. It derives it with a pure helper, `removalRequiresForce(localData)`, from the **final** inspection's description, after the fingerprint matched at that final check. The helper is true when that description has `tracked` or `untracked` entries.
- Clean and ignored-only trees keep non-force removal. For them, Git's own clean and submodule checks stay in force as a second guard.
- With force, Git skips its own clean and submodule checks. Uatu's final inspection is then the only guard, which is why D5 adds a Uatu-side submodule probe. The lock check is unaffected, because Git still refuses a locked tree under a single force, and Uatu blocks locks first anyway.
- `classifyWorktreeRemoveFailure` is unchanged. A forced removal refused for a lock still maps to `git-lock`.
- **Removal timeout.** `git worktree remove` runs with its own bound, `WORKTREE_REMOVE_TIMEOUT_MS` = 10 minutes, through the runner's per-call `timeoutMs`; every probe keeps the 10-second default unless D5 says otherwise. Deleting a large ignored `node_modules/` can take far longer than a probe: a forced removal of a 200k-file checkout took about 23 s here, which the old 10-second bound would have killed part-way. If even ten minutes expire, Git is killed and the outcome follows the existing, unchanged verification: if the checkout's identity is still readable, nothing more happens, the journal is cleared, the registration stays, and the user sees "Removing the worktree timed out, so some of its files may already be deleted. Refresh the inventory and review the deletion again." (`timeout`, retry `refresh`); the next preflight describes whatever data is left. If the identity file is gone but the folder remains, the journal is retained and recovery reports the checkout as uncertain; if the whole folder is gone, recovery finishes the Hub cleanup. No new recovery path is needed. *(Review change.)*
- **Force counting.** `countForceArguments` counts `--force` once and each `f` in a short-option cluster (`-ff` is two), before the `--` separator; the builder's guard and the tests use it.
- The "never force" guard and tests are replaced by "at most one `--force`, only with a matching acknowledgement that covers tracked or untracked data".
- *Alternative: always force when any acknowledgement matched.* Rejected. Ignored-only data does not need force, and keeping Git's own checks where possible is strictly safer.
- *Alternative: have Uatu delete the tracked and untracked files itself, then run non-force removal.* Rejected. It is a second, bespoke deletion path with partial-failure states that are much harder to recover than one Git operation.

### D5. Submodule and nested-repository probe

The blocker order is identity, lock, nested linked worktree, operation markers, **submodule repository directory**, status probe (failing closed), **nested repositories in directory entries**, **the index probe** (populated gitlinks, then repositories inside tracked directories; on every inspection), and finally the local-data description. Undecodable paths are refused as soon as the status or index output containing them is read. All new blockers are `nested-dependency` with `retry-delete`, and messages such as "This worktree contains a submodule or another Git repository (`mods/sub`). Remove or move it outside Uatu first. Nothing was removed." The per-worktree `modules` store names no single path, so that check says "This worktree contains an initialized submodule. Remove or move it outside Uatu first. Nothing was removed."

1. **Per-worktree `modules` directory.** Add `modules` to the existing `rev-parse --git-path` batch, kept separate from the operation markers. If the resolved path exists, the inspection blocks. It uses the same fail-closed `exists` helper, so an unreadable path counts as present. Git applies this exact test before non-force removal, so running it at every inspection changes nothing except that the explanation arrives earlier.
2. **Nested repositories in directory entries.** For every `??` or `!!` porcelain entry that ends in `/`, the inspection blocks if `<checkout>/<entry>.git` exists, whether as a file or a directory. The check costs one `lstat` per directory entry. Under `--untracked-files=all`, a trailing-slash untracked entry at any depth is a nested repository, so the untracked check is complete. For ignored directories, only a repository at the entry's root is detected.
3. **The index: populated gitlinks and repositories inside tracked directories.** On every inspection, including clean and ignored-only trees, the inspection runs `git ls-files -z --stage` in the checkout. For every mode `160000` entry, it blocks if `<checkout>/<path>/.git` exists. This mirrors Git's `validate_no_submodules`, which a single force skips, and also catches embedded repositories added with `git add` that have no `.gitmodules` mapping. It then collects the unique ancestor directories of every index path and of every status entry, and blocks if `<checkout>/<dir>/.git` exists for any of them, checked with the fail-closed `exists` in small concurrent batches. This catches a repository nested inside a tracked directory, which Git deletes with or without force (see Context). A probe that exceeds its bound or fails is refused as `identity-uncertain` with the message "The worktree's files could not be inspected, so it was not removed." *(Implementation change: the plan first ran this probe only on the force path and relied on Git's own non-force check. That check does not cover repositories inside tracked directories, so the probe runs on every inspection; this also resolves the former open question.)*
   *Bare repositories and administrative directories (review change).* Git does not treat a bare repository as a nested one, so an untracked `backup.git` made with `git clone --bare` is listed file by file (`?? backup.git/HEAD`, …) and its history would pass as ordinary untracked data that a single force deletes. Every candidate — directory entries, gitlinks and every ancestor directory of an index path or status entry — is therefore tested the way Git's own `is_git_directory` does, closely enough to fail safe: a `.git` entry, or a `HEAD` that is not a directory together with `objects/` and `refs/` directories (a packed-refs-only layout still has `refs/`), or with a `commondir` or `gitdir` file. `HEAD` is looked up only when `.git` is absent and the rest only when `HEAD` exists, so an ordinary directory costs two `lstat` calls; any unreadable answer is refused as "could not be inspected". An ignored bare repository at the root of an `!! backup.git/` entry is caught the same way. A folder that happens to hold a file named `HEAD` plus `objects/` and `refs/` folders is refused too, which is the safe direction. The candidates are sorted before probing, so the path a refusal names never depends on porcelain output order (review note).
4. **Output bounds, timeouts, unreadable locations and undecodable paths.** The index listing grows with the repository (about 90 bytes per tracked file), so it alone gets a larger bound of 64 MiB, roughly 700k tracked files, through a per-call `outputLimit` option on the Git runner; every other probe keeps the 4 MiB default. Exceeding it still fails closed. Any status or index path containing U+FFFD is refused as `identity-uncertain` with the same message: such a path cannot be looked up on disk, so a nested repository under it would be missed, and two different undecodable names could share a fingerprint. *(Alternatives considered: `git ls-tree -r -d HEAD` lists directories compactly but misses staged-only paths and gitlinks; `ls-files --format` needs Git 2.38; a fatal decoder in the shared runner would change every other probe.)* The status and index listings, whose cost grows with the checkout, run with `INSPECTION_PROBE_TIMEOUT_MS` = 60 s instead of the 10-second default; they still fail closed beyond it. `lstat` answers are three-way: ENOENT or ENOTDIR means absent, success means present, and any other error means unreadable. An unreadable operation marker, `modules` store or candidate directory is refused as `identity-uncertain` ("could not be inspected"), never reported as a Git operation or a nested repository. *(Review change: an unreadable location was first counted as present, which named the wrong cause.)*
5. **Cost in large repositories.** Every recheck still runs the full inspection; nothing is cached between checks. Within one inspection, every candidate location is checked once: directory entries, then gitlinks, then every ancestor directory of an index path or status entry, sorted. `collectAncestorDirectories` is linear, walking up from each path only until it meets an ancestor already collected, and the `lstat` calls run with at most 32 in flight, stopping at the first hit once every earlier candidate has answered. Measured on this machine (Apple silicon, other load present) with a 200k-file, 22k-directory checkout: de-duplicating 200k synthetic paths takes about 11–21 ms; `git ls-files -z --stage` takes about 0.1 s for 17.7 MB of output; `git status` with `--untracked-files=all --ignored=matching` takes about 8 s and dominates; one whole inspection takes about 9.5–10.7 s, so a deletion's three inspections add about 30 s; the forced removal itself took about 23 s. The status time is Git's own tree scan, which the "exactly what was shown" guarantee requires at every check; it is accepted.

- *Alternative: parse `.gitmodules`.* Rejected. It misses gitlinks without a mapping, and the file is user-editable working-tree content.
- *Alternative: `git submodule status`.* Rejected. It fails on unmapped gitlinks. It also reads initialization from the shared repository config, so it reports submodules that are initialized in the main checkout but not populated in this worktree. That gives false positives.
- *Alternative: `git ls-files --format='%(objectmode)…'`.* Rejected because it needs Git 2.38, above the 2.36 floor. It would reduce the output size only.
- *Alternative: walk the checkout for `.git` entries.* Rejected. The walk is unbounded inside `node_modules/` and similar trees.
- *Alternative: rely on Git's refusal.* Rejected. A single force skips it, which is exactly the case this probe covers.

### D6. Reuse `local-data` and `nested-dependency`; add no error code

Both local-data refusals are data that the user must review, and the dialog does not branch on the error code. Submodules and nested repositories are nested dependencies, which already exist for nested worktrees and Git's own submodule refusal. `WORKTREE_ERROR_CODES` is a closed set mirrored in OpenAPI, so new codes would widen an enum for no client benefit.

### D7. UI: per-category warning plus a required checkbox, mirroring Forget

When preflight carries `localData`, the delete view keeps the existing consequence line and adds a warning block. The block says that the listed files will be permanently deleted with the worktree and cannot be recovered, while commits on the branch are kept. Then, in a fixed order, it shows one entry per present category:

- "Uncommitted changes (N)";
- "Untracked files (N)";
- "Ignored files and folders (N), such as build output or local settings like `.env`".

Each entry lists its sample, with every path escaped through `h()`, and adds "and N more" when the count exceeds the sample. A sample path ending in `/` is a whole folder — one entry however much it holds — and is labelled "(folder, with everything in it)"; the warning reads "These files and folders will be permanently deleted with the worktree, including everything inside each listed folder, and cannot be recovered." *(Review change: counts of entries understated what a folder entry deletes.)*

A required checkbox follows the warning, reusing the Forget markup: `<label class="check"><input type="checkbox" name="acknowledge" required>Permanently delete these files with the worktree.</label>`. The danger button keeps **Delete** or **Stop and delete**, and it stays enabled, as in Forget. `submitDelete` refuses an unchecked submit in place with "Confirm to continue. Nothing changed." and sends no request. The delete form carries `novalidate`: otherwise a browser's own constraint validation for the `required` checkbox would stop the submit before `submitDelete` runs, and the in-place message would never appear. The attribute still marks the checkbox as required for assistive technology. When the box is ticked, it sends `localDataFingerprint` next to `stop`. The dialog stores `localData` next to `requiresStop` and resets it in the same places. A clean tree shows no checkbox and sends no fingerprint. A server refusal is rendered in place exactly as today, with the message in `role="alert"` and only Cancel offered — except a `local-data` refusal: the dialog then re-runs preflight and shows the updated warning with an unticked checkbox and the refusal as an alert, or, if that preflight now finds a blocker, the blocker with only Cancel. *(Review change: a stale fingerprint used to strand the user on a Cancel-only view.)*

- *Alternative: a distinct "Delete with ignored files" button and no checkbox.* This was the earlier plan, now rejected by the user. Uncommitted work is being discarded, so a separate, deliberate tick is warranted, and the Forget view already establishes that pattern.
- *Alternative: keep the button disabled until the box is checked.* Rejected for consistency. Forget keeps its button enabled and explains the refusal, and a disabled destructive button would need change listeners and an extra accessibility state.

### D8. No journal or reconciler change

The acknowledgement and the force decision are consumed within a single request, under the fence. Restart recovery never re-runs removal; it only reconciles the outcome of a removal that already ran, forced or not. Journaling the fingerprint would add schema surface with no reader.

## Risks / Trade-offs

- **[Status-level fingerprint]** The fingerprint covers status entries, not file contents. Further edits to an already-listed modified or untracked file, and new files inside an already-listed ignored directory, keep the same fingerprint. → Accepted. The user acknowledged discarding those paths, and the warning names directories as whole entries. New or removed entries, changed status codes and changed ignore rules all change the fingerprint and are refused.
- **[Residual external-writer race, wider under force]** The final probe cannot fence writers during Git's removal. Under non-force removal, Git's own clean check still refuses tracked or untracked changes made after the final probe. Under a single force, Git skips that check, so anything written between the final probe and Git's removal is deleted with the tree. → Accepted and documented. The final check runs immediately before Git, so the window stays as narrow as it is today. The race exists only after the user has explicitly acknowledged discarding local data.
- **[Irreversible data loss by design]** A ticked box discards uncommitted work. → Mitigations: a per-category disclosure with paths, an explicit required checkbox, recheck binding, and a branch that is always kept.
- **[Large index]** `git ls-files -z --stage` runs on every inspection, under its own 64 MiB bound and 60 s timeout. Beyond roughly 700k tracked files the inspection fails closed and the user must clean up by hand. → Accepted. See D5 step 5 for measured costs; the status scan, not the index work, dominates.
- **[Removal cut off]** A removal that exceeds its ten-minute bound leaves a partly deleted checkout. → Accepted and reported as such (D4); the registration stays and the next preflight describes what is left.
- **[Undecodable file names]** A checkout with any path that is not valid UTF-8, or that genuinely contains U+FFFD, cannot be deleted from Uatu. → Accepted; it fails closed with "could not be inspected".
- **[Nested repository deep inside an ignored directory]** A repository below the root of an `!! dir/` entry is not detected. With non-force removal, Git deletes it, as it deletes the rest of that ignored directory. → Accepted and documented. The user acknowledged the directory, and walking ignored trees is unbounded.
- **[Behavior change for a preflight consumer]** An existing API client that treats `ok: true` as "safe" and then sends `confirm: true` without a fingerprint is refused at delete time with `local-data`. → The refusal is safe, and the client sees the old blocker one step later. This is documented in the changelog.
- **[Stale PWA bundle against an upgraded Hub]** An old client's closed parser rejects the new `localData` key, so the dialog shows a parse error rather than a warning. → The build-identity freshness handshake reloads stale bundles, and the failure fails closed.
- **[Path disclosure]** Sample paths reveal file names. → The paths are checkout-relative only, they come from a tree the caller is already authorized to open, and each category's sample is bounded to five entries.
- **[Hashing nondeterminism]** A fingerprint that differs between two probes of the same tree would block every acknowledged delete. → Both probes use the same server-side code path, and the sort is deterministic. Integration tests assert that an acknowledged delete succeeds after a stop and recheck.

## Migration Plan

- The fields are optional, but `WorktreeDeletionPreflight` is closed, so `localData` is a breaking change for strict Hub clients. They are published as Hub revision 10 / workspace revision 21, with their own `api/CHANGELOG.md` entry and migration guidance, the revision raised in `api/contract.json`, the OpenAPI `info.version` (`10.21.0-experimental`) and `x-uatu-revisions`, and `HUB_API_REVISION`. *(Changed at rebase: the plan amended the unreleased Hub 8 / Workspace 20 entry in place. While this change was open, upstream published Hub revision 9 (#425), so the base already serves a closed preflight answer without `localData`; adding it is breaking for strict clients and needs a revision of its own rather than an amendment of an earlier entry. The Hub 8 entry is left exactly as upstream publishes it.)* Update the following in `api/openapi.yaml`:
  - the schemas;
  - the path descriptions;
  - the `confirm` and `error` descriptions, which currently say "no force anywhere" or "no force path past it";
  - examples, including an `ok: true` preflight with `localData`.

  The Hub 10 entry states the honest force wording from the spec; the earlier entries stay as published.
- No data migration is needed. Journals and registry files are unchanged.
- Rollback is a code revert. Clients then lose the acknowledgement, local data blocks again, and Git is never forced. Nothing persisted depends on the new fields.
- Release notes: the worktree feature is not in the latest stable tag (`v0.7.0`). The PR keeps a truthful `fix(worktrees): …` title and carries a `BEGIN_COMMIT_OVERRIDE` block with `chore(worktrees): stabilize the unreleased worktree feature before release`, so no user-visible fix entry is generated.

## Open Questions

- The sample size (five per category), the checkbox wording and whether to shorten very long sample paths are presentation constants. They can be tuned during implementation or review without changing the specs or the approach.
- *(Resolved during implementation.)* The index probe runs on every inspection, not only on the force path; see D5 step 3.
