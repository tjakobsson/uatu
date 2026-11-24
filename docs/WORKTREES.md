# Git worktree workspaces

A worktree gives a branch its own checkout and Uatu workspace. Use it to keep
another branch open while preserving your current files, terminal sessions and
conversations. The checkouts share Git objects, refs and repository configuration.
They are not security isolation.

## Create from the workspace picker

1. Open the workspace picker above the file tree, or in the touch Files tab.
2. Select the fork icon beside the main workspace that owns the repository.
3. Choose **New branch / worktree**, **Existing branch**, or **Register
   worktree…**.
4. Create the checkout. It starts stopped, and your current workspace stays open.
5. Select **Open** in the creation confirmation — it appears at the top of the
   window — to start and visit it.

The Hub dashboard has the same parent fork actions. Its Active groups section
keeps repositories with a running checkout together. Stopped children are under
an expandable row; completely stopped repositories are under Inactive groups.
Stopping the main checkout stops only that checkout. A child can run while main
is stopped.

### Registering a worktree Uatu did not create

**Register worktree…**, the fork menu's third item, lists only the checkouts
Git knows about that Uatu has not registered: one an agent or a plain
`git worktree add` created, and any Uatu-created checkout whose registration
did not complete. Each row shows its branch, whether it is an external
worktree or of uncertain ownership, and its path, with **Register workspace**
or **Retry registration**. When Git lists nothing unregistered it says so.
It is the same view from the picker and the dashboard.

Checkouts Uatu has already registered are managed where you already see
them — the workspace picker's rows and the Hub dashboard's rows — including
Open, Start, Delete worktree, Remove from Uatu and the inline retry a missing
or replaced path offers.

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

### Check out a pull request

In a Hub workspace whose session lists GitHub pull requests, open the
switcher, choose a pull request under **Pull requests**, then **Check out as a
worktree…** and **Create worktree**. You stay where you are. The new checkout
is listed under Checkouts as `Creating…`, and the pull request's row reads
`Checking out…`. Closing the switcher does not cancel it. When it is ready, a
notice says `<branch> is ready.` and offers **Go to**, which starts the
checkout and opens it. A pull request that already has a checkout offers **Go
to its worktree** first. If creation fails, the row stays as `Couldn't create ·
Retry`, and the pull request's own step shows why.

| Pull request | Branch and upstream |
| --- | --- |
| From a branch of the same repository | Its head branch, such as `feature/login`, tracking `origin/feature/login`, after an explicit fetch. An existing local branch of that name is checked out as it is. You can push to it as usual. |
| From a fork | `pr/<number>`, such as `pr/57`, at `refs/pull/57/head` fetched from the repository's GitHub remote. That ref is its upstream, so `git pull` brings in new commits. Pushes do not go back to the fork: treat it as read-only. |

The folder follows the usual rule, for example `atlas.worktrees/pr-57`. The Hub
asks GitHub nothing. It fetches only that pull request's ref, with the parent's
credential policy, and never prompts. It never forces or resets a branch:

- An existing `pr/57` that already tracks pull request #57 on that remote is
  checked out as it is. If it is not at the pull request's head, the notice
  says so; pull in its terminal to update it.
- Any other existing `pr/57` is refused with `A branch named pr/57 already
  exists and does not track pull request #57 on origin.` Delete or rename
  the local branch `pr/57`, or set its upstream to `refs/pull/57/head` on
  `origin` (`git config branch.pr/57.remote origin` and
  `git config branch.pr/57.merge refs/pull/57/head`), then try again.
- A pull request the remote does not publish is refused with `Pull request
  #57 was not found on origin: it has no refs/pull/57/head.` Check the
  number, and that the remote is the pull request's GitHub repository.

Without the Hub's worktree service, the demo's mocked GitHub data shows a
labelled simulation instead. Outside a Hub, a pull request can only be viewed
here. The API is `POST /api/hub/worktrees/create` with
`{ mode: "pull-request", pullRequest: { number, remote } }` (Hub API
revision 16).

### Names, destinations and history

The child name is its exact local branch, including slashes, up to 64
characters — the same ceiling the Hub's workspace registry applies to every
display name. A longer name is refused before Git runs anything: **Create**
stays disabled with the reason shown under the Name field. Uatu chooses its
destination beside the main checkout:

```text
/src/atlas
/src/atlas.worktrees/feature-login     branch feature/login
```

Only the folder name is sanitized. A collision with another sanitized name gets
a deterministic branch-derived suffix; an occupied destination is never
overwritten. There is no destination field or separate child name. Uatu does
not rename branches.

Rows Uatu created show `from main` or another recorded creation source. This is
historical information, not the current upstream or parent's current branch. A
Uatu-created branch with no recorded history shows `origin unknown`. A checkout
Uatu did not create is labelled `External worktree`, or `Ownership uncertain`
when its identity cannot be established — ownership is stated rather than an
origin guessed. The main checkout row separately shows its current branch,
Detached HEAD, or Branch unknown.

The workspace picker's selector reads `<repository> <branch>` for every
checkout — a worktree shows **atlas** probe/first-attempt exactly as its main
checkout shows **atlas** main.
The menu groups under a header per repository: the repository's name with its
fork control at the right edge, then its main checkout, then its worktrees, all
on the same left edge, with a divider between repositories.

## Parent policy and checkout context

Manage shared policy and credential assignments for a repository on the Hub's
**Settings** page. Children inherit that policy live, without child credential copies
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

A worktree created by Git, Claude Code or OpenCode is external. Open its
parent's **Register worktree…** list (see above) and explicitly register it
before opening it as a Uatu workspace. Registration preserves
its path and does not grant Uatu deletion ownership. In an Existing branch flow,
an already-checked-out branch offers that checkout's Open or registration action,
and selecting a remote ref there shows which local branch it will create before
you commit to it.

A removed or replaced registered path stays visible as unavailable in the picker
and the dashboard, with an inline retry that re-reads Git. Uatu refuses to start
it rather than recreate the directory, silently forget it, or move your
conversation to another checkout. Resolve the path, or use **Remove from Uatu**
on the stopped registration, when you no longer need it.

## Delete versus remove from Uatu

**Delete worktree** is a secondary action for a verified Uatu-created linked
checkout. The confirmation identifies the parent and branch. **Stop and delete**
also authorizes stopping that checkout's Uatu terminal and agent sessions.
After stopping, Uatu rechecks identity and local data before removal. The Git
branch and its commits are always kept, and so are the repository's stashes.

If the checkout has local data — uncommitted changes (staged or not), untracked
files or ignored files such as build output, `node_modules/` or a local `.env`
— the confirmation lists it: for each kind, how many entries there are and a
few of their paths. An entry ending in `/` is a whole folder, marked as such:
Git reports a fully ignored folder like `node_modules/` as one entry however
many files it holds, and it is deleted with everything inside it. These files
and folders are permanently deleted with the worktree and cannot be
recovered. To go ahead, tick **Permanently delete these files with the
worktree**; without the tick nothing is deleted. Cancel leaves everything as it
was. The tick covers exactly the entries listed, by path and Git status. If
they change before Uatu removes the checkout — a file is created, deleted,
staged or newly ignored, or the ignore rules change — deletion is refused and
the confirmation shows the data as it is now, with the box unticked, for you to
review again. Further edits to a file that is already listed, and new
files inside an ignored folder that is already listed, are covered by the tick.

Deletion still refuses Git locks, nested worktrees, submodules and nested Git
repositories inside the checkout, Git operations in progress, external
activity, and uncertain identity or ownership. Ticking the box never overrides
any of these. A nested repository here means an ordinary one (with a `.git`),
a bare one (such as a `backup.git` made with `git clone --bare`, which Git
itself would otherwise list as a pile of untracked files) or a Git
administrative folder. Uatu looks for them in untracked folders, in folders
that hold tracked files and at the top of each ignored folder. It does not
search inside ignored folders, so a repository deeper inside an ignored folder
such as `node_modules/` is deleted along with that folder. A checkout
with file names Uatu cannot read reliably (not valid UTF-8), or with a folder
Uatu is not allowed to read, is not deleted. There is no force option: the acknowledgement only lets Uatu pass
Git a single force to remove exactly the listed uncommitted and untracked data,
never the double force that overrides a lock. Uatu cannot stop unknown external
applications for you. A failed stop or removal keeps the checkout and its
registration. Removing a large checkout can take a while; if Git has not
finished after ten minutes it is stopped, some files may already be gone, and
the checkout stays registered so you can refresh and review the deletion
again.

**Remove from Uatu** forgets a workspace's registration and associated Hub
personal state, stopping its Uatu sessions first if it is running as part of
the same confirmed action. It keeps the checkout, files, branch and creation
provenance. This is also how to forget an external checkout.

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
  If creation stopped before Uatu durably recorded the checkout's identity,
  matching its intended path or branch is not enough to claim ownership. The
  checkout remains unclaimed rather than becoming eligible for Uatu deletion.
- An interrupted deletion with a surviving checkout but missing removal proof
  keeps its registration and provenance and requires reconciliation. Uatu does
  not report the files as removed or silently clean up that registration.
- If Git removal completes but metadata cleanup fails, retry cleanup. Recovery
  records completed removal and must not delete a new occupant at the old path.
- If checking out a pull request stopped after `pr/<number>` was made but
  before its checkout, the branch stays with its pull request upstream. The
  next **Check out as a worktree…** checks that branch out as it is.

## Requirements and rollback

Git 2.36 or newer is required. Bare repositories, main checkouts created with
`--separate-git-dir`, and submodule creation sources are unsupported. Inventory
uses known repositories, not a scan of arbitrary host directories.

To stop using the feature, stop affected sessions. Keep the ordinary Git
checkouts and branches. Before downgrading the Hub, finish or recover pending
operations and back up its state directory. Preserve the worktree journal and
provenance records; do not discard a pending journal to make an older version
start. Use a compatible version to resolve it first.
Rollback never requires deleting checkouts or branches.
