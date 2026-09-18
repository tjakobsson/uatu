// Task 6.3. Two properties, both checked against the actual files that ship:
//
//   1. The skill text guides use only for an explicit persistent Uatu
//      workspace request, tells the agent to read the CLI's structured JSON,
//      and forbids the four things it must never do — replacing native
//      worktree/subagent behavior, using a provider's experimental
//      removal/reset APIs as cleanup, migrating conversations, and running
//      Git as a fallback. It carries no credential and no hostname.
//   2. Installing it the way the README documents adds exactly one entry to
//      a user's or a project's configuration directory and leaves everything
//      already there byte-for-byte unchanged — which is what "opt-in, and
//      Uatu writes nothing into your configuration" has to mean in practice.
//
// The second is a FIXTURE test: it builds a populated `.claude`/`.opencode`
// tree in a temporary directory, runs the documented installation against it,
// and compares a full snapshot before and after.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SKILLS_ROOT = path.dirname(Bun.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SKILLS_ROOT, "..", "..");

const SKILLS = [
  { agent: "claude", file: path.join(SKILLS_ROOT, "claude", "uatu-worktrees", "SKILL.md") },
  { agent: "opencode", file: path.join(SKILLS_ROOT, "opencode", "uatu-worktrees", "SKILL.md") },
] as const;

// Prose wraps; the guidance is what matters, not where the line breaks are.
function flat(contents: string): string {
  return contents.replace(/\s+/g, " ");
}

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function snapshot(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        entries[`${relative}/`] = "<dir>";
        await walk(absolute);
      } else if (entry.isSymbolicLink()) {
        entries[relative] = "<symlink>";
      } else {
        entries[relative] = await readFile(absolute, "utf8");
      }
    }
  };
  await walk(root);
  return entries;
}

// A configuration directory that already holds the things a user would mind
// losing: settings, hooks, permissions, agents, commands, and a skill of
// their own — including one that shares our topic but not our name.
async function populatedConfiguration(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "uatu-agent-skills-"));
  temporary.push(root);
  const files: Array<[string, string]> = [
    [".claude/settings.json", '{\n  "permissions": { "allow": ["Bash(git status)"] }\n}\n'],
    [".claude/settings.local.json", '{\n  "env": { "EXISTING": "1" }\n}\n'],
    [".claude/hooks/pre-tool-use.sh", "#!/bin/sh\nexit 0\n"],
    [".claude/agents/reviewer.md", "---\nname: reviewer\n---\n\nReview carefully.\n"],
    [".claude/commands/deploy.md", "Deploy the thing.\n"],
    [".claude/skills/my-worktrees/SKILL.md", "---\nname: my-worktrees\n---\n\nMy own worktree habits.\n"],
    [".opencode/opencode.json", '{\n  "model": "anthropic/claude-sonnet-4-5"\n}\n'],
    [".opencode/agent/planner.md", "---\nmode: subagent\n---\n\nPlan.\n"],
    [".opencode/command/ship.md", "Ship it.\n"],
    [".opencode/skill/my-worktrees/SKILL.md", "---\nname: my-worktrees\n---\n\nMy own worktree habits.\n"],
  ];
  for (const [relative, contents] of files) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
  return root;
}

describe("uatu agent skills are opt-in and preserve existing configuration", () => {
  test("installing adds one entry and changes nothing that was already there", async () => {
    const root = await populatedConfiguration();
    const before = await snapshot(root);

    // Exactly what the README documents: one symlink per agent, into a
    // skills directory. No file is opened, merged or rewritten.
    await symlink(path.join(SKILLS_ROOT, "claude", "uatu-worktrees"), path.join(root, ".claude/skills/uatu-worktrees"));
    await mkdir(path.join(root, ".opencode/skill"), { recursive: true });
    await symlink(path.join(SKILLS_ROOT, "opencode", "uatu-worktrees"), path.join(root, ".opencode/skill/uatu-worktrees"));

    const after = await snapshot(root);
    const added = Object.keys(after).filter(key => !(key in before));
    expect(added.sort()).toEqual([".claude/skills/uatu-worktrees", ".opencode/skill/uatu-worktrees"]);
    // Everything that existed is byte-for-byte identical, including the
    // user's own similarly named skill.
    for (const [key, value] of Object.entries(before)) expect(after[key]).toEqual(value);
    expect(Object.keys(before)).not.toContain(".claude/skills/uatu-worktrees");
  });

  test("uninstalling leaves the configuration exactly as it was", async () => {
    const root = await populatedConfiguration();
    const before = await snapshot(root);
    await symlink(path.join(SKILLS_ROOT, "claude", "uatu-worktrees"), path.join(root, ".claude/skills/uatu-worktrees"));
    await rm(path.join(root, ".claude/skills/uatu-worktrees"));
    expect(await snapshot(root)).toEqual(before);
  });

  test("nothing in this repository writes into a user's or project's agent configuration", async () => {
    // The product's own source must not reach into these directories. The
    // chat surface names provider directories in prose and in its own
    // per-conversation session handling; what must not exist is a write.
    const forbidden = /(mkdir|writeFile|appendFile|copyFile|symlink|rename|rm|unlink)[^\n]*\.(claude|opencode)\b/;
    const roots = [path.join(REPO_ROOT, "src"), SKILLS_ROOT];
    const offenders: string[] = [];
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        if (forbidden.test(await readFile(absolute, "utf8"))) offenders.push(path.relative(REPO_ROOT, absolute));
      }
    };
    for (const directory of roots) await walk(directory);
    expect(offenders).toEqual([]);
  });

  test("the README documents installation and removal without Uatu writing anything", async () => {
    const readme = await readFile(path.join(SKILLS_ROOT, "README.md"), "utf8");
    expect(readme).toContain("opt-in");
    expect(readme).toMatch(/ln -s/);
    expect(readme).toMatch(/## Removing/);
    expect(readme).toMatch(/Uatu never installs them|never writes into your agent configuration/);
    // No machine, account or secret is named anywhere in this folder.
    expect(readme).not.toMatch(/\/Users\/|\/home\/[a-z]/);
  });
});

describe("uatu agent skill text", () => {
  test.each(SKILLS.map(skill => skill.agent))("%s: frontmatter scopes it to explicit Uatu workspace requests", async agent => {
    const contents = await readFile(SKILLS.find(skill => skill.agent === agent)!.file, "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(contents);
    expect(frontmatter).not.toBeNull();
    const declared = flat(frontmatter![1]!);
    expect(declared).toContain("name: uatu-worktrees");
    expect(declared).toContain("description:");
    expect(declared).toContain("explicitly asks");
    expect(declared).toContain("Not for your own parallel work");
  });

  test.each(SKILLS.map(skill => skill.agent))("%s: points at the CLI's structured JSON, not at Git", async agent => {
    const raw = await readFile(SKILLS.find(skill => skill.agent === agent)!.file, "utf8");
    const contents = flat(raw);
    expect(contents).toContain("--json");
    expect(contents).toMatch(/structured result/);
    // The four fields a caller acts on.
    for (const field of ["phase", "code", "message", "retry"]) expect(contents).toContain(field);
    // It documents `uatu worktree`'s surface and never a git invocation.
    for (const command of ["uatu worktree list", "uatu worktree create", "uatu worktree open", "uatu worktree remove"]) {
      expect(contents).toContain(command);
    }
    // No command line in this file invokes Git, and the only Git command it
    // names at all is the one it tells the agent NOT to fall back to.
    expect(raw.split("\n").filter(line => /^\s*git\s/.test(line))).toEqual([]);
    expect([...raw.matchAll(/`git [^`]*`/g)].map(match => match[0])).toEqual(["`git worktree`"]);
  });

  test.each(SKILLS.map(skill => skill.agent))("%s: forbids replacing native isolation, experimental cleanup and migration", async agent => {
    const contents = flat(await readFile(SKILLS.find(skill => skill.agent === agent)!.file, "utf8"));
    // Native worktree/subagent behavior and the configuration behind it.
    expect(contents).toContain("subagent isolation is separate and stays exactly as it is configured");
    expect(contents).toContain("Do not replace it, wrap it, disable it or route it through this command");
    expect(contents).toContain("do not change any hook, agent, permission or setting to make it go through here");
    // Experimental / lifecycle removal APIs as cleanup.
    expect(contents).toContain("Never use an experimental or lifecycle removal/reset API of your own");
    // Conversation migration.
    expect(contents).toContain("never moves, copies or resumes one somewhere else");
    // No force, no branch deletion, no unconfirmed deletion, no Git fallback.
    expect(contents).toContain("There is no force flag");
    expect(contents).toContain("It never deletes a branch");
    expect(contents).toContain("--confirm-delete");
    expect(contents).toContain("Do not fall back to `git worktree`");
  });

  test.each(SKILLS.map(skill => skill.agent))("%s: carries no credential, hostname or machine path", async agent => {
    const raw = await readFile(SKILLS.find(skill => skill.agent === agent)!.file, "utf8");
    const contents = flat(raw);
    for (const pattern of [
      /https?:\/\//,                    // any URL, which would pin a host
      /\b\d{1,3}(?:\.\d{1,3}){3}\b/,    // any IP address
      /\.ts\.net\b|\bts\.net\b/,        // any tailnet name
      /\/Users\/|\/home\/[a-z]/,        // any real filesystem path
      /token|password|secret|api[_-]?key|Authorization/i,
    ]) {
      expect(contents).not.toMatch(pattern);
    }
    // It does say there is nothing to configure, which is why none of the
    // above needs to appear.
    expect(contents).toMatch(/no configuration, no host and no credential/);
  });

  test("both spellings carry the same guidance", async () => {
    const [claude, opencode] = await Promise.all(SKILLS.map(skill => readFile(skill.file, "utf8")));
    const body = (contents: string) => contents.split(/^---\n/m).slice(2).join("---\n");
    expect(body(opencode!)).toEqual(body(claude!));
  });
});
