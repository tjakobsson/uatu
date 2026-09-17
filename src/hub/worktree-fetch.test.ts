import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildWorktreeFetchArguments,
  buildWorktreeFetchEnvironment,
  classifyWorktreeFetchFailure,
  createParentFetchPolicy,
  createWorktreeFetchRunner,
  fetchWorktreeRemotes,
  listWorktreeRemotes,
  parseWorktreeRemotes,
  WORKTREE_FETCH_REMOTE_LIMIT,
  type WorktreeFetchSelection,
} from "./worktree-fetch";
import { createGitRunner, listRefs, type GitRun } from "./worktree-git";
import { WorktreeOperationError } from "../shared/worktree-contract";
import type { CredentialAssignment } from "./credential-types";

// Real Git in temporary repositories only, with an explicitly built
// environment: developing Uatu inside a Hub-managed workspace projects
// Git/SSH wrappers, and a credential test must not discover them.
const temporaryDirectories: string[] = [];
let sharedHome: string | undefined;

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `uatu-worktree-fetch-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

async function cleanEnvironment(): Promise<Record<string, string>> {
  sharedHome ??= await temporaryDirectory("home");
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: sharedHome,
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
    cwd, env: await cleanEnvironment(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}

async function createRepository(label: string, folder = "repo"): Promise<string> {
  const parent = await temporaryDirectory(label);
  const repository = path.join(parent, folder);
  await mkdir(repository, { recursive: true });
  await git(repository, ["init", "--initial-branch=main"]);
  await writeFile(path.join(repository, "README.md"), "# Readme\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "initial"]);
  return repository;
}

const sshSelection: WorktreeFetchSelection = {
  kind: "selected",
  credentialId: "cred-ssh",
  process: { type: "ssh", host: "example.test", sshPath: "/opt/uatu/ssh", agentSocket: "/run/uatu/agent.sock", publicKeyPath: "/state/cred-ssh.key.pub" },
};
const httpsSelection: WorktreeFetchSelection = {
  kind: "selected",
  credentialId: "cred-token",
  process: { type: "https", host: "example.test", credentialId: "cred-token", stateRoot: "/state", uatuArgv: ["/opt/uatu/uatu"] },
};

function policyFor(assignments: CredentialAssignment[], resolve: ParametersOfResolve = async () => undefined) {
  return createParentFetchPolicy({ assignments: () => assignments, resolve });
}
type ParametersOfResolve = Parameters<typeof createParentFetchPolicy>[0]["resolve"];

const failure = (stderr: string): GitRun => ({ exitCode: 128, stdout: "", stderr, timedOut: false, outputExceeded: false });

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("parent credential policy", () => {
  const remote = { name: "origin", url: "https://example.test/atlas.git" };

  test("a parent selection for the remote's host is used", async () => {
    const policy = policyFor(
      [{ workspaceId: "atlas", credentialId: "cred-token", role: "authentication", host: "example.test" }],
      async (url, credentialId) => ({ credentialId, process: httpsSelection.process }),
    );
    expect(await policy.select("atlas", remote)).toEqual(httpsSelection);
  });

  test("no parent selection disables credentials rather than falling back", async () => {
    const policy = policyFor([], async () => {
      throw new Error("an unselected credential must never be resolved");
    });
    expect(await policy.select("atlas", remote)).toEqual({ kind: "none" });
  });

  test("another workspace's selection is not inherited sideways", async () => {
    const policy = policyFor(
      [{ workspaceId: "beacon", credentialId: "cred-token", role: "authentication", host: "example.test" }],
      async () => {
        throw new Error("another workspace's credential must never be resolved");
      },
    );
    expect(await policy.select("atlas", remote)).toEqual({ kind: "none" });
  });

  test("a selection for another host is not reused for this remote", async () => {
    const policy = policyFor(
      [{ workspaceId: "atlas", credentialId: "cred-token", role: "authentication", host: "other.test" }],
      async () => {
        throw new Error("a credential for another host must never be resolved");
      },
    );
    expect(await policy.select("atlas", remote)).toEqual({ kind: "none" });
  });

  test("a locked selected credential refuses instead of fetching unauthenticated", async () => {
    const policy = policyFor(
      [{ workspaceId: "atlas", credentialId: "cred-ssh", role: "authentication", host: "example.test" }],
      async () => {
        throw new Error("selected SSH credential is locked; unlock it before cloning: cred-ssh");
      },
    );
    const error = await policy.select("atlas", remote).catch(caught => caught);
    expect(error).toBeInstanceOf(WorktreeOperationError);
    expect((error as WorktreeOperationError).detail.code).toBe("fetch-authentication");
    expect((error as WorktreeOperationError).detail.retry).toBe("retry-fetch");
    expect((error as WorktreeOperationError).detail.message).toContain("locked");
  });

  test("a disabled selected credential refuses the same way", async () => {
    const policy = policyFor(
      [{ workspaceId: "atlas", credentialId: "cred-token", role: "authentication", host: "example.test" }],
      async () => {
        throw new Error("credential is disabled: cred-token");
      },
    );
    const error = await policy.select("atlas", remote).catch(caught => caught);
    expect((error as WorktreeOperationError).detail.code).toBe("fetch-authentication");
  });

  test("a signing assignment is not an authentication selection", async () => {
    const policy = policyFor(
      [{ workspaceId: "atlas", credentialId: "cred-sign", role: "signing" }],
      async () => {
        throw new Error("a signing credential must never authenticate a fetch");
      },
    );
    expect(await policy.select("atlas", remote)).toEqual({ kind: "none" });
  });
});

describe("no ambient or unselected credential can take part", () => {
  const ambient = {
    HOME: "/Users/reviewer",
    SSH_AUTH_SOCK: "/tmp/ambient-agent.sock",
    GITHUB_TOKEN: "ghp_ambientsecretvalue1234",
    GIT_ASKPASS: "/usr/bin/ambient-askpass",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "store",
    GIT_CONFIG_COUNT: "1",
    NETRC: "/Users/reviewer/.netrc",
    PATH: "/usr/bin",
  };

  test("an unselected fetch drops every ambient credential source", () => {
    const env = buildWorktreeFetchEnvironment(ambient);
    expect(env.HOME).toBe("/dev/null");
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.NETRC).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_SSH_COMMAND).toContain("IdentityAgent=none");
    expect(env.GIT_SSH_COMMAND).toContain("IdentityFile=none");
    expect(env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("a selected SSH credential replaces the ambient agent rather than joining it", () => {
    const env = buildWorktreeFetchEnvironment(ambient, sshSelection);
    expect(env.SSH_AUTH_SOCK).toBe("/run/uatu/agent.sock");
    expect(env.GIT_SSH_COMMAND).toContain("'/opt/uatu/ssh'");
    expect(env.GIT_SSH_COMMAND).toContain(`-o 'IdentityAgent="/run/uatu/agent.sock"'`);
    expect(env.GIT_SSH_COMMAND).toContain(`-o 'IdentityFile="/state/cred-ssh.key.pub"'`);
    expect(env.GIT_SSH_COMMAND).toContain("IdentitiesOnly=yes");
    expect(env.HOME).toBe("/dev/null");
  });

  test("arguments clear the helper list and add only the selected helper", () => {
    const plain = buildWorktreeFetchArguments("/srv/atlas", { name: "origin", url: "https://example.test/a.git" });
    expect(plain).toEqual([
      "-c", "core.askPass=", "-c", "credential.helper=", "-c", "safe.directory=/srv/atlas",
      "fetch", "--prune", "--", "origin",
    ]);
    const selected = buildWorktreeFetchArguments("/srv/atlas", { name: "origin", url: "https://example.test/a.git" }, httpsSelection);
    expect(selected.filter(argument => argument.startsWith("credential.https://")).length).toBe(1);
    expect(selected.join(" ")).toContain("UATU_CREDENTIAL_ID='cred-token'");
    expect(selected.join(" ")).not.toContain("--force");
    // The empty helper clear still precedes the selected helper.
    expect(selected.indexOf("credential.helper=")).toBeLessThan(selected.findIndex(argument => argument.startsWith("credential.https://")));
  });

  test("an option-like remote name never reaches an argument list", () => {
    expect(() => buildWorktreeFetchArguments("/srv/atlas", { name: "--upload-pack=evil", url: "https://example.test/a.git" })).toThrow();
  });
});

describe("remote enumeration", () => {
  test("parses NUL-separated config records and puts origin first", () => {
    const output = "remote.upstream.url\nhttps://example.test/up.git\0remote.origin.url\nhttps://example.test/a.git\0";
    expect(parseWorktreeRemotes(output)).toEqual([
      { name: "origin", url: "https://example.test/a.git" },
      { name: "upstream", url: "https://example.test/up.git" },
    ]);
  });

  test("a repository with no remote fetches nothing and reports success", async () => {
    const repository = await createRepository("no-remote");
    const run = createGitRunner({ env: await cleanEnvironment() });
    expect(await listWorktreeRemotes(run, repository)).toEqual([]);
    const outcome = await fetchWorktreeRemotes({
      run,
      repositoryPath: repository,
      parentWorkspaceId: "atlas",
      policy: policyFor([]),
      runWith: async () => {
        throw new Error("no remote means no fetch");
      },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.remotes).toEqual([]);
  });

  test("the number of remotes one Fetch touches is bounded", async () => {
    const many = Array.from({ length: 9 }, (_, index) => `remote.r${index}.url\nhttps://example.test/${index}.git`).join("\0");
    const run = async () => ({ exitCode: 0, stdout: many, stderr: "", timedOut: false, outputExceeded: false });
    expect((await listWorktreeRemotes(run, "/srv/atlas")).length).toBe(WORKTREE_FETCH_REMOTE_LIMIT);
  });
});

describe("fetch outcomes and freshness", () => {
  test("a successful fetch updates cached refs, prunes disappeared ones and stamps freshness", async () => {
    const repository = await createRepository("fresh");
    const origin = await createRepository("fresh-origin", "origin");
    await git(origin, ["checkout", "-b", "feature/search"]);
    await git(origin, ["commit", "--allow-empty", "-m", "search"]);
    await git(origin, ["checkout", "main"]);
    await git(repository, ["remote", "add", "origin", origin]);

    const outcome = await fetchWorktreeRemotes({
      run: createGitRunner({ env: await cleanEnvironment() }),
      repositoryPath: repository,
      parentWorkspaceId: "atlas",
      policy: policyFor([]),
      env: await cleanEnvironment(),
      runWith: createWorktreeFetchRunner(),
      now: () => 1_700_000_000_000,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.fetchedAt).toBe(1_700_000_000_000);
    expect(outcome.remotes).toEqual(["origin"]);
    const refs = await listRefs(repository, { env: await cleanEnvironment() });
    expect(refs.kind).toBe("refs");
    if (refs.kind !== "refs") return;
    expect([...refs.remote].sort()).toEqual(["origin/feature/search", "origin/main"]);

    // A branch that disappears upstream is pruned rather than left
    // selectable, and the listing is re-stamped.
    await git(origin, ["branch", "-D", "feature/search"]);
    const second = await fetchWorktreeRemotes({
      run: createGitRunner({ env: await cleanEnvironment() }),
      repositoryPath: repository,
      parentWorkspaceId: "atlas",
      policy: policyFor([]),
      env: await cleanEnvironment(),
      runWith: createWorktreeFetchRunner(),
      now: () => 1_700_000_060_000,
    });
    expect(second.ok).toBe(true);
    const after = await listRefs(repository, { env: await cleanEnvironment() });
    if (after.kind !== "refs") return;
    expect([...after.remote]).toEqual(["origin/main"]);
  });

  test("a locked parent credential fails before any fetch process starts", async () => {
    let started = 0;
    const outcome = await fetchWorktreeRemotes({
      run: async () => ({ exitCode: 0, stdout: "remote.origin.url\nhttps://example.test/a.git\0", stderr: "", timedOut: false, outputExceeded: false }),
      repositoryPath: "/srv/atlas",
      parentWorkspaceId: "atlas",
      policy: policyFor(
        [{ workspaceId: "atlas", credentialId: "cred-ssh", role: "authentication", host: "example.test" }],
        async () => {
          throw new Error("selected SSH credential is locked; unlock it before cloning: cred-ssh");
        },
      ),
      runWith: async () => {
        started += 1;
        throw new Error("a locked credential must not start a fetch");
      },
    });
    expect(started).toBe(0);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("fetch-authentication");
  });

  test("an authentication failure is reported as one, with cached refs unchanged", async () => {
    const outcome = await fetchWorktreeRemotes({
      run: async () => ({ exitCode: 0, stdout: "remote.origin.url\nhttps://example.test/a.git\0", stderr: "", timedOut: false, outputExceeded: false }),
      repositoryPath: "/srv/atlas",
      parentWorkspaceId: "atlas",
      policy: policyFor([]),
      runWith: async () => failure("remote: Invalid username or token\nfatal: Authentication failed for 'https://example.test/a.git/'"),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("fetch-authentication");
    expect(outcome.error.retry).toBe("retry-fetch");
    expect(outcome.error.message).toContain("cached branches are unchanged");
  });

  test("a network failure is reported as one", async () => {
    const outcome = await fetchWorktreeRemotes({
      run: async () => ({ exitCode: 0, stdout: "remote.origin.url\nhttps://example.test/a.git\0", stderr: "", timedOut: false, outputExceeded: false }),
      repositoryPath: "/srv/atlas",
      parentWorkspaceId: "atlas",
      policy: policyFor([]),
      runWith: async () => failure("fatal: unable to access 'https://example.test/a.git/': Could not resolve host: example.test"),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("fetch-network");
  });

  test("a timeout is bounded and reported without claiming freshness", async () => {
    const outcome = await fetchWorktreeRemotes({
      run: async () => ({ exitCode: 0, stdout: "remote.origin.url\nhttps://example.test/a.git\0", stderr: "", timedOut: false, outputExceeded: false }),
      repositoryPath: "/srv/atlas",
      parentWorkspaceId: "atlas",
      policy: policyFor([]),
      runWith: async () => ({ exitCode: -1, stdout: "", stderr: "", timedOut: true }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("fetch-network");
    expect(outcome.error.message).toContain("timed out");
  });

  test("a second remote's failure reports which remotes were already fetched", async () => {
    let call = 0;
    const outcome = await fetchWorktreeRemotes({
      run: async () => ({ exitCode: 0, stdout: "remote.origin.url\nhttps://example.test/a.git\0remote.upstream.url\nhttps://example.test/b.git\0", stderr: "", timedOut: false, outputExceeded: false }),
      repositoryPath: "/srv/atlas",
      parentWorkspaceId: "atlas",
      policy: policyFor([]),
      runWith: async () => (call++ === 0
        ? { exitCode: 0, stdout: "", stderr: "", timedOut: false }
        : failure("fatal: Could not resolve host: example.test")),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.remotes).toEqual(["origin"]);
    expect(outcome.error.code).toBe("fetch-network");
  });
});

describe("sanitized output", () => {
  test("secrets and absolute host paths never reach the reported message", () => {
    const error = classifyWorktreeFetchFailure(
      "fatal: unable to access 'https://user:ghp_realsecretvalue0001@example.test/a.git/': The requested URL returned error: 403 while reading /Users/reviewer/.netrc",
      { name: "origin", url: "https://example.test/a.git" },
    );
    expect(error.code).toBe("fetch-authentication");
    expect(error.message).not.toContain("ghp_realsecretvalue0001");
    expect(error.message).not.toContain("/Users/reviewer");
  });

  test("an unrecognized failure keeps Git's words but not its secrets or paths", () => {
    const error = classifyWorktreeFetchFailure(
      "fatal: something unusual happened in /srv/private/atlas with token=abcdef123456",
      { name: "origin", url: "https://example.test/a.git" },
    );
    expect(error.code).toBe("fetch-network");
    expect(error.message).toContain("something unusual happened");
    expect(error.message).not.toContain("/srv/private/atlas");
    expect(error.message).not.toContain("abcdef123456");
  });
});
