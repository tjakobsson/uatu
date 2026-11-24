# GitHub pull requests

uatu shows the GitHub pull request of the branch you have checked out, and any
other open pull request of the repository, beside your files. You can read the
conversation, review Files changed, open a changed file in Rendered, Source or
Diff, comment on lines and finish a review. Merging stays on GitHub.

- **Pull request pane**: the branch's pull request, its checks, the first thing
  blocking a merge, **Review** or **Finish review (n)**, and a link to GitHub.
- **Pull request view** (`?pr=<n>`): **Conversation** and **Files changed**.
  **View file** on a file in Files changed opens the file view, where you can
  step through the changed files with ‹ and ›.
- **Workspace switcher → Pull requests**: the repository's open pull requests.
  **View here** shows one in this workspace. **Check out as a worktree…** gives it
  its own checkout (see [Check out a pull request](./WORKTREES.md#check-out-a-pull-request)).
  The list shows up to 100. When GitHub has more open pull requests, it ends with
  **n more on GitHub ↗**.

## Connect GitHub

uatu talks to GitHub only through the GitHub CLI, `gh` 2.0 or newer, using
`gh api`. It reads and writes with the credential `gh` uses in the workspace.
Repositories are recognized from their remotes: `gh repo set-default`'s choice
first, then `upstream`, then `origin`. Hosts are matched as follows:

- github.com and GitHub Enterprise Cloud with data residency (`*.ghe.com`) are
  recognized by name.
- A GitHub Enterprise Server host is recognized when it is the host of the
  workspace's Hub credential (`GH_HOST`), or when `gh auth status --hostname
  <host>` succeeds.
- Other hosts are not GitHub, and uatu runs no `gh` command for them.

**In a Hub** (the usual setup):

1. Open **Hub › Settings › Credentials**. Without a credential, the pull request
   view's **Open Hub Settings → Credentials** opens it.
2. Open **Add HTTPS or provider token**. Enter the **Provider host**:
   `github.com`, your `*.ghe.com` host, or your GitHub Enterprise Server host
   name. Add a token that can read the repository's pull requests. It also
   needs to write them if you will comment or review. Tick **GitHub CLI** under
   **Purpose**, and **HTTPS Git** too if the token should also fetch over HTTPS.
3. Under **Workspace assignments**, assign it to the workspace. Linked
   worktrees inherit the assignment from the workspace they were created from.
4. Restart the workspace if it shows **Restart required**.

The Hub gives the workspace's `gh` the token for that host. github.com and
`*.ghe.com` get it as `GH_TOKEN`. An Enterprise Server host gets it as
`GH_ENTERPRISE_TOKEN`, with `GH_HOST` naming the host.

**Outside a Hub** (a session started from source): sign in with `gh auth
login`, or `gh auth login --hostname <host>` for Enterprise Server, then restart
the session.

Until a credential works, the pull request view says **Connect GitHub to review
pull requests here** and names the same steps. The pane says **GitHub isn't
connected for this workspace**, and the switcher **GitHub isn't connected.**,
each with the way to connect.

### Turning it down or off

`UATU_GITHUB` is read once when a session starts. Set it on the Hub to apply
it to every workspace.

| Value | Effect |
|---|---|
| unset or `full` | Read pull requests, and send comments and reviews. |
| `read` | Read only. Composers keep your drafts, and sending says: "This session reads GitHub only (its GitHub setting is read), so nothing can be sent." |
| `off` (or an unknown value) | No pull request surfaces at all. |

### When GitHub doesn't answer

Nothing asks GitHub on a timer. uatu reads again when one of these happens:

- the branch or HEAD changes;
- you open a pull request view;
- you come back to the page, at most every 15 seconds;
- you send something;
- you press Refresh or Retry.

A rate limit stops requests to that host until it resets. Retry asks anyway.
While GitHub is unreachable or rate-limited, the last answer stays on screen
with the time it was read. Sending is paused, and your drafts are kept.

GitHub sometimes answers with part of a pull request left out. That happens
when a long timeline is cut, when there are more threads or files than uatu
reads, or when a token can't read the checks. Conversation and Files changed
then say what is missing, for example **2 more timeline entries on GitHub**,
and link to the pull request.

## Files and bases come from your clone

A pull request's files are read from Git, never from GitHub's contents API.
For the branch's own pull request they are usually already in your clone.
For another pull request, the file view first shows **Get #n's files**.
**Fetch #n's head** fetches the pull request's head into a private ref,
`refs/uatu/pull/<n>/head`, with the workspace's Git credentials. Your branch,
files and index are not changed. uatu keeps at most 20 of these refs per
repository and prunes merged and closed pull requests' refs first. Without
a Git credential that can fetch, the card says so and offers **Open on
GitHub ↗**.

For the branch's own pull request, the file view's facts line compares the
pull request head's file with yours. It says **Same as your checkout** with
**Open in workspace**, or how yours differs: `local edits`, or `checkout at
<commit>`. When the pull request gets new commits while a file is open, the
view says **#n has new commits since this file was read** and offers
**Reload**.

**Since base** in Change Overview measures from the pull request's base. The
README's [compare base](../README.md#configuration-uatujson) paragraph has the
full order.

## Comments and reviews

Line comments are written in **Files changed**, or in a file view's Diff.
Files changed shows GitHub's own diff of the pull request, so a comment there
always lands on the line GitHub shows. Rendered and Source show the file's
threads read-only:

- The bar above the file counts its threads and offers **Show in Diff**.
- Source marks each line that holds a thread.
- Rendered Markdown and AsciiDoc mark the block that holds the line with a
  💬 marker beside it, which opens the thread in Diff.

A document's own Diff (your checkout, not the pull request) takes comments only
when it is provably GitHub's diff of that file. Otherwise it says why, and
lists the file's threads, outdated ones marked, each opening in Files changed:

| Reason | What the Diff says |
|---|---|
| Comparing against the last commit | This Diff compares against your last commit. Compare against the base to comment on #n here. |
| The base isn't GitHub's exact base commit | #n's exact base commit isn't here, so this Diff may not match GitHub's. Fetch its refs to compare against it. |
| HEAD isn't the pull request's head | Your checkout is at … , not #n's head …, so line numbers may differ from GitHub's. |
| The file has local changes | This file has local changes, which would move its line numbers on GitHub. |
| The diff is too large for the full renderer | This diff is too large to comment on inline. |

### Your pending review

Line comments and replies go into **your pending review on GitHub**. It is
GitHub's own draft review, not one uatu keeps. It survives reloads, shows on
other devices, and appears on github.com. A review you started on github.com
continues here.

- A comment on the conversation posts at once. It is never part of the review,
  as on GitHub.
- **Finish review (n)** opens the review dialog. There you choose **Comment**,
  **Approve** or **Request changes**. Request changes needs a summary. So does
  Comment, unless the review holds line comments. Approve needs none.
- On your own pull request, Approve and Request changes are disabled: "You
  can't approve or request changes on your own pull request."
- **Discard** removes the pending review and its comments after you confirm.
- If your pending review was started on an older commit than the pull
  request's head, new line comments are refused until you finish or discard
  it: "Your pending review was started on an older commit. Submit or discard
  it first." Replies to existing threads still work.
- Unsent text is kept in the page per pull request and location, and
  restored after a reload. It goes once GitHub has taken it.

**Who posts.** Everything is sent as the GitHub account of the workspace's
credential. Every composer names it, for example "Goes into your pending
review as @octo-reviewer." In a shared Hub, everyone who uses a workspace
posts as that workspace's account, so assign each person their own
credential and workspace when that matters.

## Merging happens on GitHub

uatu shows whether GitHub would merge the pull request now, read-only. The pane
gives the checks and the first blocker. The end of Conversation, where GitHub
has its merge box, lists every blocker, the merge methods the repository
allows, and whether GitHub deletes the head branch. When you have pending
comments, it says "You have n pending comments — finish your review before
merging on GitHub."

The link to the pull request is **Merge on GitHub ↗** when it is ready, and
**View on GitHub ↗** otherwise. uatu has no merge button. GitHub's own page
handles merge queues, rulesets and stacked pull requests, which GitHub's
programmatic merge APIs don't all support.
