// Task 6.4: what can be verified about Claude Code / OpenCode coexistence
// WITHOUT invoking a model.
//
// The claim this change makes is narrow and testable: a worktree Uatu creates
// is an ORDINARY linked Git checkout, so any tool that accepts a working
// directory accepts it, and Uatu takes nothing over on the provider's side —
// it writes no provider configuration, no hooks and no ownership marker into
// the tree or the repository.
//
// Model-backed directory/resume, native worktree and subagent checks live in
// tests/worktree-agent-smoke.ts and require a separate, user-authorized run.
// These unit tests establish only checkout compatibility and non-interference.
// A version probe alone is never evidence of runtime compatibility.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorkspaceRegistry } from "./registry";
import { WorktreeJournal, WorktreeProvenanceStore } from "./worktree-journal";
import { WorktreeService } from "./worktree-service";
import type { WorktreeRegistrar } from "./worktree-journal";

let root = "";
let home = "";
let repository = "";
let service: WorktreeService;
let registry: WorkspaceRegistry;
const parentWorkspaceId = "parent";

function cleanEnvironment(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Uatu Test",
    GIT_AUTHOR_EMAIL: "uatu@example.test",
    GIT_COMMITTER_NAME: "Uatu Test",
    GIT_COMMITTER_EMAIL: "uatu@example.test",
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd, env: cleanEnvironment(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}

// Presence and version only: `--version` prints locally and contacts no
// model. Absence is a recorded fact, not a failure — CI hosts have neither.
async function probeBinary(command: string): Promise<{ available: boolean; version?: string }> {
  try {
    const child = Bun.spawn([command, "--version"], {
      env: cleanEnvironment(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (exitCode !== 0) return { available: false };
    return { available: true, version: stdout.trim().split("\n")[0] };
  } catch {
    return { available: false };
  }
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "uatu-worktree-providers-")));
  home = path.join(root, "home");
  await mkdir(home);
  repository = path.join(root, "atlas");
  await mkdir(repository);
  await git(repository, ["init", "--initial-branch=main"]);
  await writeFile(path.join(repository, "README.md"), "# atlas\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "initial"]);

  const state = path.join(root, "state");
  await mkdir(state);
  registry = new WorkspaceRegistry(path.join(state, "registry.json"));
  await registry.load();
  await registry.register(repository, "local", "Atlas");
  const entry = registry.list()[0]!;

  // A registrar that records the relationship without an onboarding
  // coordinator: this test is about the TREE Git produces, not about Hub
  // registration, which section 4 covers.
  const registrar: WorktreeRegistrar = {
    async register(input) {
      const added = await registry.register(input.path, "local", input.displayName);
      return { workspaceId: added.id, started: false };
    },
  };

  service = new WorktreeService({
    registry: {
      byId: id => (id === parentWorkspaceId ? { ...entry, id: parentWorkspaceId } : registry.byId(id)),
      byPath: candidate => registry.byPath(candidate),
      list: () => registry.list(),
    },
    sessions: { isRunning: () => false },
    journal: new WorktreeJournal(path.join(state, "pending-worktree-operation.json")),
    provenance: new WorktreeProvenanceStore(path.join(state, "worktree-provenance.json")),
    registrar,
    git: { env: cleanEnvironment() },
  });
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("provider coexistence (6.4)", () => {
  test("a Uatu-created worktree is an ordinary linked checkout any tool can use as a working directory", async () => {
    const result = await service.create("reviewer", {
      sourceWorkspaceId: parentWorkspaceId,
      mode: "new-branch",
      branch: "feature/agent",
      base: { kind: "local", ref: "main" },
    });
    expect(result.ok).toBe(true);
    const checkout = result.ok ? result.checkout! : undefined;
    const folder = checkout!.path;

    // Ordinary to Git itself: this is the whole compatibility claim. An agent
    // launched with cwd here sees a normal repository.
    expect((await git(folder, ["rev-parse", "--is-inside-work-tree"])).trim()).toBe("true");
    expect(await realpath((await git(folder, ["rev-parse", "--show-toplevel"])).trim())).toBe(await realpath(folder));
    expect((await git(folder, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature/agent");
    // Linked, sharing the parent's object store rather than being a clone.
    expect((await git(folder, ["rev-parse", "--git-common-dir"])).trim()).not.toBe(".git");
    expect((await git(repository, ["worktree", "list"]))).toContain(folder);
  });

  test("Uatu writes no provider configuration, hooks or ownership marker into the tree or the repository", async () => {
    const result = await service.create("reviewer", {
      sourceWorkspaceId: parentWorkspaceId,
      mode: "new-branch",
      branch: "feature/untouched",
      base: { kind: "local", ref: "main" },
    });
    expect(result.ok).toBe(true);
    const folder = result.ok ? result.checkout!.path : "";

    // Nothing provider-shaped is created by Uatu. Claude's WorktreeCreate
    // hook and OpenCode's worktree APIs keep their own behavior precisely
    // because Uatu never installs itself into either.
    const entries = (await readdir(folder)).sort();
    expect(entries).toEqual([".git", "README.md"]);
    for (const marker of [".claude", ".opencode", "opencode.json", "CLAUDE.md", ".uatu-worktree", ".uatu.json"]) {
      expect(entries).not.toContain(marker);
    }
    // And nothing was added to the parent checkout either.
    expect((await readdir(repository)).sort()).toEqual([".git", "README.md"]);
    // The committed tree is untouched: a fresh worktree carries no Uatu file.
    expect((await git(folder, ["status", "--porcelain"])).trim()).toBe("");
  });

  test("records which provider binaries were present, and claims nothing about absent ones", async () => {
    const providers = {
      claude: await probeBinary("claude"),
      opencode: await probeBinary("opencode"),
    };
    // The report is the point: this test documents the environment it ran in
    // rather than gating on tools a CI host will not have.
    for (const [name, probe] of Object.entries(providers)) {
      expect(typeof probe.available).toBe("boolean");
      if (probe.available) expect(probe.version && probe.version.length > 0).toBe(true);
      else console.info(`worktree coexistence: ${name} not available; its runtime behavior is untested, not assumed compatible`);
    }
    // Both providers are accounted for either way, so a silently missing
    // probe cannot pass as a verified one.
    expect(Object.keys(providers).sort()).toEqual(["claude", "opencode"]);
  });
});
