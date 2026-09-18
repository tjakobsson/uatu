---
name: uatu-worktrees
description: Use when the user explicitly asks for a persistent Uatu workspace on another branch of this repository — creating, listing, opening or deleting a Uatu worktree workspace. Not for your own parallel work, and not for ordinary git worktree or subagent isolation.
---

# Uatu worktree workspaces

`uatu worktree` asks the Uatu Hub that serves this workspace to manage Git
worktrees of this repository as Uatu workspaces of their own. Each one gets
its own files, terminal and conversations, at its own URL.

## Use this only when the user asks for it

Use it when the user asks, in so many words, for a **persistent Uatu
workspace** on another branch — "give me a worktree for feature/login and
open it", "what worktrees does this repo have", "delete the worktree for the
old branch".

Do not use it for anything else. In particular:

- **Not for your own parallel work.** Your own worktree and subagent
  isolation is separate and stays exactly as it is configured. Do not replace
  it, wrap it, disable it or route it through this command, and do not change
  any hook, agent, permission or setting to make it go through here.
- **Not as a cleanup tool.** Never use an experimental or lifecycle
  removal/reset API of your own to tidy up a Uatu workspace or its checkout.
  Deletion happens through `uatu worktree remove`, after the Hub's own safety
  checks, or it does not happen.
- **Not a way to move a conversation.** A conversation belongs to the
  checkout it started in. Creating, opening or deleting a worktree never
  moves, copies or resumes one somewhere else. If the user wants to work on
  another checkout, open it and start a conversation there.

## How to run it

Run it from the terminal of the Uatu workspace you are in. It needs no
configuration, no host and no credential.

```
uatu worktree list --json
uatu worktree create --new-branch <name> --from <ref> --json
uatu worktree create --branch <local-branch> --json
uatu worktree create --remote-branch <remote>/<branch> --json
uatu worktree open <branch> [--start] --json
uatu worktree remove <branch> --confirm-delete [--stop] --json
```

Pass `--json` and read the structured result: it carries the outcome, the
phase the operation reached, and on failure a `code`, a plain-language
`message` and a `retry` naming the single next step. Report that message to
the user rather than inventing a recovery of your own. `uatu worktree --help`
is the complete surface.

Exit codes: `0` success, `1` the operation was refused, `2` invalid usage,
`3` no usable Hub context.

## Things the command will not do, and neither should you

- **It never picks a location.** The Hub puts a new worktree beside the main
  checkout. There is no destination option; do not ask for one.
- **It never forces.** A branch already checked out, an occupied
  destination, a ref that is not there, uncommitted or ignored files, a Git
  lock, activity Uatu does not own — each is a refusal with a reason. There is
  no force flag. If the reason is not something you can act on, tell the user
  what it said.
- **It never deletes a branch.** `remove` deletes a worktree's files after
  every safety check and keeps the branch, always.
- **Deletion is the user's decision.** `remove` requires
  `--confirm-delete`, and `--stop` on top of it if the workspace is running.
  Ask the user first, name the branch you are about to delete, and run it only
  once they have said yes. Never run it to clean up after yourself.
- **It runs no Git of its own.** If there is no Hub context — you are not in
  a Uatu workspace terminal, or the workspace needs restarting — it says so
  and exits non-zero. That is the answer. Do not fall back to `git worktree`
  to do it anyway; a checkout made that way is not a Uatu workspace and Uatu
  will correctly treat it as somebody else's.

## After creating one

A new worktree starts stopped. Tell the user it exists and that they can open
it; use `uatu worktree open <branch> --start` only if they ask you to start
it. Do not switch your own working directory into it, and do not carry the
current conversation over.
