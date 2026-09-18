# Git worktree workspaces

A worktree gives a branch its own checkout and Uatu workspace. Use it to keep
another branch open while preserving your current files, terminal sessions and
conversations. The checkouts share Git objects, refs and repository configuration.
They are not security isolation.

## Create from the workspace picker

1. Open the workspace picker above the file tree, or in the touch Files tab.
2. Select the fork icon beside the main workspace that owns the repository.
3. Choose **New branch / worktree** or **Existing branch**.
4. Create the checkout. It starts stopped, and your current workspace stays open.
5. Select **Open** in the creation confirmation to start and visit it.

The Hub dashboard has the same parent fork actions. Its Active groups section
keeps repositories with a running checkout together. Stopped children are under
an expandable row; completely stopped repositories are under Inactive groups.
Stopping the main checkout stops only that checkout. A child can run while main
is stopped.

### Branch choices

| Choice | Result |
| --- | --- |
| New branch / worktree | A new local branch from the exact branch selected in Create from. |
| Existing local branch | A checkout of that local branch, without resetting it. |
| Existing remote branch | A new local tracking branch, such as `feature/login` from `origin/feature/login`. |

Create from initially selects local `main`. If it is absent, the only remote
branch named `main` is selected. Multiple remote mains, or no main, require a
choice. The current checkout's branch is never a fallback. A base already checked
out elsewhere is valid for a *new* branch. A target branch already checked out
offers its existing checkout instead of a forced duplicate.

Both branch fields accept typing to filter local and remote refs. Select an
option to commit the exact choice; editing it clears the selection. **Fetch
remote branches** is explicit and uses the parent's selected credential policy.
Opening the dialog does not fetch. Fetch preserves the name, query and valid
selection. If a ref disappears, choose again. Authentication or network failure
leaves cached refs available, without claiming they are fresh.

### Names, destinations and history

The child name is its exact local branch, including slashes. Uatu chooses its
destination beside the main checkout:

```text
/src/atlas
/src/atlas.worktrees/feature-login     branch feature/login
```

Only the folder name is sanitized. A collision with another sanitized name gets
a deterministic branch-derived suffix; an occupied destination is never
overwritten. There is no destination field or separate child name. Uatu does
not rename branches.

Rows show `from main` or another recorded creation source. This is historical
information, not the current upstream or parent's current branch. Existing-local
and external branches with no recorded history show `origin unknown`. The main
row separately shows its current branch, Detached HEAD, or Branch unknown.

## Parent policy and checkout context

Use the parent's **Configure** action to manage shared policy and credential
assignments. Children inherit that policy live, without child credential copies
or overrides. A credential change may require restarting a running checkout to
replace its process environment; the Hub reports this through its normal restart
indicator. Explicitly registering an external child uses the same parent policy.

Each checkout has its own workspace URL, watched files, preview, search, Git
view, terminal cwd and conversations. The picker and browser Back/Forward restore
that workspace's own selections. Creating or discovering a worktree never moves
an existing conversation. Personal and device preferences are not copied from
the parent.

Only committed files from the selected branch enter a new checkout. Dirty source
files, ignored `.env` files and installed dependencies are not copied. Uatu does
not install dependencies or run project setup for you. Ordinary Git hooks and
filters can execute during Git operations; project configuration can execute
when you later start tools in the checkout.

## External trees and missing paths

Uatu reads Git's worktree inventory on open, relevant observed activity, manual
refresh and a bounded periodic schedule. Its own committed operations notify open
pages immediately through the existing live stream. External changes may take a
refresh to appear.

A worktree created by Git, Claude Code or OpenCode is external. Explicitly register
it under its parent before opening it as a Uatu workspace. Registration preserves
its path and does not grant Uatu deletion ownership. In an Existing branch flow,
an already-checked-out branch offers that checkout's Open or registration action.

A removed or replaced registered path remains in the inventory as unavailable.
Uatu refuses to start it rather than recreate the directory, silently forget it,
or move your conversation to another checkout. Resolve the path or remove the
stopped registration when you no longer need it.

## Delete versus remove from Uatu

**Delete worktree** is a secondary action for a verified Uatu-created linked
checkout. The confirmation identifies the parent and branch. **Stop and delete**
also authorizes stopping that checkout's Uatu terminal and agent sessions.
After stopping, Uatu rechecks identity and local data before non-force removal.
The Git branch is always kept.

Deletion refuses tracked changes, untracked files, ignored files, Git locks,
nested dependencies, uncertain ownership and unresolved activity. Move or preserve
valuable local data before trying again. There is no force option, and Uatu
cannot stop unknown external applications for you. A failed stop or removal
keeps the checkout and its registration.

**Remove from Uatu** or **Remove from Hub** forgets a stopped workspace's
registration and associated Hub personal state. It keeps the checkout, files,
branch and creation provenance. This is also how to forget an external checkout.
Stopping the workspace is a separate prerequisite.

Folder rename is refused if it would break a linked checkout, main checkout,
shared Git directory or an ancestor dependency, including unregistered trees.
Stopping does not make such a move safe. Renaming the main workspace's display
name remains available.

## Recover a partial operation

- If checkout creation succeeds but registration fails, keep the checkout and
  branch. Use **Retry registration** in the originating flow. It verifies and
  registers the same checkout rather than creating another one.
- If start fails, the configured child remains stopped. Retry Open or Start.
- After a Hub interruption, recovery reconciles the operation journal with Git.
  An uncertain path stays intact. Resolve the reported conflict before retrying.
- If Git removal completes but metadata cleanup fails, retry cleanup. Recovery
  records completed removal and must not delete a new occupant at the old path.

## CLI and agent skills

Run these commands from an embedded terminal in a Hub workspace, with `uatu`
available on PATH:

```sh
uatu worktree list --json
uatu worktree create --new-branch feature/login --from main --json
uatu worktree create --branch release --json
uatu worktree create --remote-branch origin/feature/search --json
uatu worktree open feature/login --start --json
uatu worktree remove feature/login --confirm-delete --stop --json
```

The last command explicitly authorizes deletion and stopping Uatu activity.
Every deletion blocker still applies. Omit `--stop` for a stopped checkout.
`open` without `--start` reports the existing registration; it does not launch a
browser or register an external checkout. Register external trees in the browser
first. Creation accepts `--start` but otherwise defaults to stopped.

For a source installation, replace `uatu` with
`bun run /absolute/path/to/uatu/src/cli.ts`. No globally installed executable is
assumed by the skill packaging. Use `uatu worktree --help` for the full syntax.

JSON list output has `{ "ok": true, "command": "list", "inventory": ... }`.
Mutations return `{ "ok": ..., "command": ..., "result": ... }`. Inspect
`result.phase`, `result.error`, `result.retainedCheckout` and `result.startError`
when present. A successful registration with `startError` remains stopped.
Exit codes are 0 for success, 1 for refusal, 2 for invalid usage and 3 for unusable
Hub context. Transport and context failures may write only stderr, even with
`--json`.

The Hub writes an owner-readable capability file in the session runtime
directory. `UATU_HUB_CONTEXT` contains its path, not a token. The capability
authorizes only worktree operations in that repository family and is revoked
when the issuing session stops. Missing or expired context requires restarting
the workspace from the Hub. There is no offline Git fallback. Automatic
capabilities currently require a single-user Hub; a multi-user Hub cannot
attribute a shared terminal to one user and issues none. Its browser operations
remain available through authenticated Hub sessions.

Install the optional [Claude Code or OpenCode skill](agent-skills/README.md) by
copying or linking its directory into your chosen project or user configuration.
Uatu never installs it automatically. The skills apply to explicit persistent
workspace requests. Native worktree hooks and subagent lifecycles stay under the
agent's control; native removal/reset APIs must not clean up Uatu-owned trees.
Native transcript import depends on the provider's directory and storage format
and is not guaranteed across versions.

## Requirements and rollback

Git 2.36 or newer is required. Bare repositories, main checkouts created with
`--separate-git-dir`, and submodule creation sources are unsupported. Inventory
uses known repositories, not a scan of arbitrary host directories.

To stop using the feature, stop affected sessions and remove any optional skill
links. Keep the ordinary Git checkouts and branches. Before downgrading the Hub,
finish or recover pending operations and back up its state directory. Preserve
the worktree journal and provenance records; do not discard a pending journal
to make an older version start. Use a compatible version to resolve it first.
Rollback never requires deleting checkouts or branches.
