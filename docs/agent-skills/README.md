# Uatu agent skills (opt-in)

Two small skill files that teach Claude Code and OpenCode when — and when
not — to use `uatu worktree`. They are **opt-in**: Uatu never installs them,
never writes into your agent configuration, and works exactly the same
without them.

```
docs/agent-skills/
├── claude/uatu-worktrees/SKILL.md     Claude Code spelling
└── opencode/uatu-worktrees/SKILL.md   OpenCode spelling
```

Both say the same thing in each tool's own frontmatter. The body is
deliberately thin: it names the one situation the command is for, points at
the command's own `--help` and its JSON output for everything else, and lists
what the agent must not do.

## What the skill is for

One situation: **you asked for a persistent Uatu workspace on another
branch.** For example "make me a worktree for `feature/login` and open it",
or "list the worktrees of this repository".

It is not for the worktrees an agent makes for its own parallel work. Claude
Code and OpenCode each have their own worktree and subagent isolation, and
the skill tells the agent to leave those alone.

## Installing

Copy or symlink the skill directory into your own configuration. A symlink
keeps it current when you update Uatu; a copy pins it.

Claude Code — for one project, or for yourself everywhere:

```sh
mkdir -p .claude/skills
ln -s "$PWD/docs/agent-skills/claude/uatu-worktrees" .claude/skills/uatu-worktrees

mkdir -p ~/.claude/skills
ln -s /path/to/uatu/docs/agent-skills/claude/uatu-worktrees ~/.claude/skills/uatu-worktrees
```

OpenCode — the same two scopes:

```sh
mkdir -p .opencode/skill
ln -s "$PWD/docs/agent-skills/opencode/uatu-worktrees" .opencode/skill/uatu-worktrees

mkdir -p ~/.config/opencode/skill
ln -s /path/to/uatu/docs/agent-skills/opencode/uatu-worktrees ~/.config/opencode/skill/uatu-worktrees
```

Adding one directory is the whole installation. Nothing else in
`.claude/`, `.opencode/`, `~/.claude/` or `~/.config/opencode/` is read,
rewritten or merged, so any settings, hooks, agents, commands, permissions or
other skills you already have are untouched — including a skill of your own
with a different name. If you ever want it gone, remove that one link or
directory.

> Agent tools move quickly, and the directory a given version reads skills
> from can change between releases. If the skill does not appear, check the
> skill path your installed version documents and link it there instead; the
> file itself is unchanged.

## Removing

```sh
rm .claude/skills/uatu-worktrees        # or ~/.claude/skills/uatu-worktrees
rm .opencode/skill/uatu-worktrees       # or ~/.config/opencode/skill/uatu-worktrees
```

## What is not in these files

No hostname, no URL, no path to your machine, no token and no password. The
command finds its Hub through the context the workspace's terminal already
carries, so there is nothing to configure and nothing secret to write down —
which is also why these files are safe to commit and to share.
