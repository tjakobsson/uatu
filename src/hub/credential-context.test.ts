import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildLocalCredentialEnvironment,
  createStoredCloneCredentialResolver,
  createStoredCredentialContextResolver,
  parseCloneRemote,
  LOCAL_CREDENTIAL_ASSIGNMENT_WARNING,
  type ResolvedCredentialContext,
} from "./credential-context";
import { CredentialMetadataStore, CredentialTokenStore } from "./credential-store";
import { normalizeProviderHost, type OpenPgpCredentialRecord, type SshCredentialRecord, type TokenCredentialRecord } from "./credential-types";

const tempDirectories: string[] = [];
const createdAt = "2026-08-20T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-context-"));
  tempDirectories.push(root);
  const workspacePath = path.join(root, "workspace");
  const home = path.join(root, "home");
  await Promise.all([mkdir(workspacePath), mkdir(home)]);
  Bun.spawnSync(["git", "init"], { cwd: workspacePath, stdout: "ignore", stderr: "ignore" });
  await writeFile(path.join(home, ".gitconfig"), [
    "[user]",
    "  name = Ambient User",
    "[credential]",
    "  helper = !ambient-helper",
    "[gpg]",
    "  format = openpgp",
    "[commit]",
    "  gpgsign = true",
    "",
  ].join("\n"));
  return {
    root,
    home,
    workspace: { id: "project", path: workspacePath, backend: "local" as const },
  };
}

function gitConfig(cwd: string, env: Record<string, string>, key: string, all = false): string {
  const result = Bun.spawnSync(["git", "config", all ? "--get-all" : "--get", key], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.stdout.toString().trim();
}

async function gitCredentialFill(cwd: string, env: Record<string, string>): Promise<number> {
  const child = Bun.spawn(["git", "credential", "fill"], {
    cwd,
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.stdin.write("protocol=https\nhost=github.com\n\n");
  child.stdin.end();
  return child.exited;
}

describe("local workspace credential projection", () => {
  test("resolves only enabled assignments and changes the context revision when assignments change", async () => {
    const { root, workspace } = await fixture();
    const metadata = new CredentialMetadataStore(path.join(root, "credentials.json"));
    const tokens = new CredentialTokenStore(path.join(root, "tokens.json"));
    await Promise.all([metadata.load(), tokens.load()]);
    const credential = await metadata.create({
      name: "token",
      type: "token",
      capabilities: ["https-git"],
      enabled: true,
      metadata: { host: "github.com" },
    }, () => "token-1", () => new Date(createdAt)) as TokenCredentialRecord;
    await tokens.set(credential.id, "secret");
    const resolver = createStoredCredentialContextResolver({
      metadata,
      tokens,
      stateRoot: root,
      runtimeRoot: path.join(root, "runtime"),
      gnupgHome: path.join(root, "gnupg"),
      sshAgentSocket: () => undefined,
      sshCredentialUsable: async () => false,
      openPgpCredentialUsable: async () => false,
      tools: { ssh: null, git: null, gpg: null, sshKeygen: null, gh: null, glab: null },
    });

    const before = resolver.revision(workspace.id);
    expect((await resolver.resolve(workspace)).authentication).toEqual([]);
    await metadata.assign({
      workspaceId: workspace.id,
      credentialId: credential.id,
      role: "authentication",
      host: "github.com",
    });
    const resolved = await resolver.resolve(workspace);
    expect(resolved.authentication).toEqual([{ host: "github.com", credential, token: "secret" }]);
    expect(resolved.revision).not.toBe(before);
  });

  test("checks each assigned SSH and OpenPGP key before starting a workspace", async () => {
    const { root, workspace } = await fixture();
    const metadata = new CredentialMetadataStore(path.join(root, "credentials.json"));
    const tokens = new CredentialTokenStore(path.join(root, "tokens.json"));
    await Promise.all([metadata.load(), tokens.load()]);
    const firstSsh = await metadata.create({
      name: "loaded key",
      type: "ssh",
      capabilities: ["ssh-authentication"],
      enabled: true,
      metadata: { publicKey: "ssh-ed25519 AAAAFIRST uatu", fingerprint: "SHA256:first" },
    }, () => "ssh-first", () => new Date(createdAt));
    const secondSsh = await metadata.create({
      name: "locked key",
      type: "ssh",
      capabilities: ["ssh-authentication"],
      enabled: true,
      metadata: { publicKey: "ssh-ed25519 AAAASECOND uatu", fingerprint: "SHA256:second" },
    }, () => "ssh-second", () => new Date(createdAt));
    const openpgp = await metadata.create({
      name: "locked signing key",
      type: "openpgp",
      capabilities: ["openpgp-signing"],
      enabled: true,
      metadata: { publicKey: "public", fingerprint: "A".repeat(40) },
    }, () => "pgp-locked", () => new Date(createdAt));
    await metadata.assign({ workspaceId: workspace.id, credentialId: firstSsh.id, role: "authentication", host: "one.example.com" });
    await metadata.assign({ workspaceId: workspace.id, credentialId: secondSsh.id, role: "authentication", host: "two.example.com" });
    const checkedSsh: string[] = [];
    let openPgpUsable = false;
    const resolver = createStoredCredentialContextResolver({
      metadata,
      tokens,
      stateRoot: root,
      runtimeRoot: path.join(root, "runtime"),
      gnupgHome: path.join(root, "gnupg"),
      sshAgentSocket: () => "/managed/agent.sock",
      sshCredentialUsable: async credentialId => {
        checkedSsh.push(credentialId);
        return credentialId === firstSsh.id;
      },
      openPgpCredentialUsable: async () => openPgpUsable,
      tools: { ssh: "/managed/ssh", git: null, gpg: "/managed/gpg", sshKeygen: null, gh: null, glab: null },
    });

    await expect(resolver.resolve(workspace)).rejects.toThrow("assigned SSH credential is locked");
    expect(checkedSsh.sort()).toEqual([firstSsh.id, secondSsh.id].sort());

    await metadata.unassign(workspace.id, secondSsh.id);
    await metadata.assign({ workspaceId: workspace.id, credentialId: openpgp.id, role: "signing" });
    await expect(resolver.resolve(workspace)).rejects.toThrow("assigned OpenPGP credential is locked");
    openPgpUsable = true;
    expect((await resolver.resolve(workspace)).signing?.id).toBe(openpgp.id);
  });

  test("rejects provider CLI assignments while their CLI is unavailable", async () => {
    const { root, workspace } = await fixture();
    const metadata = new CredentialMetadataStore(path.join(root, "credentials.json"));
    const tokens = new CredentialTokenStore(path.join(root, "tokens.json"));
    await Promise.all([metadata.load(), tokens.load()]);
    const credential = await metadata.create({
      name: "GitHub CLI token",
      type: "token",
      capabilities: ["github-cli"],
      enabled: true,
      metadata: { host: "github.com" },
    }, () => "provider-token", () => new Date(createdAt));
    await tokens.set(credential.id, "provider-secret");
    await metadata.assign({ workspaceId: workspace.id, credentialId: credential.id, role: "authentication", host: "github.com" });
    const tools = { ssh: null, git: null, gpg: null, sshKeygen: null, gh: null as string | null, glab: null };
    const resolver = createStoredCredentialContextResolver({
      metadata,
      tokens,
      stateRoot: root,
      runtimeRoot: path.join(root, "runtime"),
      gnupgHome: path.join(root, "gnupg"),
      sshAgentSocket: () => undefined,
      sshCredentialUsable: async () => false,
      openPgpCredentialUsable: async () => false,
      tools,
    });

    // A provider-only token with no usable CLI must fail resolution instead
    // of starting the workspace with a declared-but-unusable assignment.
    await expect(resolver.resolve(workspace)).rejects.toThrow("assigned GitHub CLI credential requires a configured GitHub CLI");
    tools.gh = "/managed/gh";
    expect((await resolver.resolve(workspace)).authentication).toHaveLength(1);
  });

  test("selects assigned SSH, HTTPS, provider, and signing credentials without replacing unrelated Git config", async () => {
    const { root, home, workspace } = await fixture();
    const managedGh = path.join(root, "custom-provider-cli");
    await writeFile(managedGh, "#!/bin/sh\nprintf 'managed-gh\\n'\n", { mode: 0o700 });
    const ssh: SshCredentialRecord = {
      id: "ssh-1",
      name: "work key",
      type: "ssh",
      capabilities: ["ssh-authentication", "ssh-signing"],
      enabled: true,
      createdAt,
      metadata: { publicKey: "ssh-ed25519 AAAATEST uatu", fingerprint: "SHA256:test" },
    };
    const token: TokenCredentialRecord = {
      id: "token-1",
      name: "github token",
      type: "token",
      capabilities: ["https-git", "github-cli"],
      enabled: true,
      createdAt,
      metadata: { host: "github.com", username: "git" },
    };
    const context: ResolvedCredentialContext = {
      revision: "one",
      runtimeRoot: path.join(root, "runtime"),
      stateRoot: path.join(root, "state with quote '"),
      sshAgentSocket: path.join(root, "managed-agent.sock"),
      gnupgHome: path.join(root, "gnupg"),
      tools: { ssh: "/usr/bin/ssh", git: "/usr/bin/git", gpg: "/usr/bin/gpg", sshKeygen: "/usr/bin/ssh-keygen", gh: managedGh, glab: null },
      authentication: [
        { host: "git.example.com", credential: ssh },
        { host: "github.com", credential: token, token: "provider-secret" },
      ],
      signing: ssh,
    };

    const projected = await buildLocalCredentialEnvironment({
      workspace,
      context,
      uatuArgv: ["/opt/Uatu Code/uatu"],
      sourceEnv: {
        HOME: home,
        PATH: process.env.PATH,
        SSH_AUTH_SOCK: "/ambient-agent.sock",
        GH_TOKEN: "ambient-token",
        GIT_ASKPASS: "/ambient/askpass",
      },
    });

    expect(projected.runtimeDirectory.startsWith(workspace.path)).toBe(false);
    expect(projected.env.SSH_AUTH_SOCK).toBe(path.join(root, "managed-agent.sock"));
    expect(projected.env.GIT_SSH_COMMAND).toStartWith("'/usr/bin/ssh' -F ");
    expect(projected.env.GH_TOKEN).toBe("provider-secret");
    expect(projected.env.PATH?.split(path.delimiter)[0]).toBe(path.join(projected.runtimeDirectory, "tool-bin"));
    expect(await readlink(path.join(projected.runtimeDirectory, "tool-bin", "git"))).toBe("/usr/bin/git");
    expect(Bun.spawnSync(["gh"], { env: projected.env, stdout: "pipe" }).stdout.toString()).toBe("managed-gh\n");
    expect(projected.env.GIT_ASKPASS).toBeUndefined();
    expect(gitConfig(workspace.path, projected.env, "user.name")).toBe("Ambient User");
    expect(gitConfig(workspace.path, projected.env, "gpg.format")).toBe("ssh");
    expect(gitConfig(workspace.path, projected.env, "commit.gpgsign")).toBe("true");
    expect(gitConfig(workspace.path, projected.env, "credential.https://github.com.helper")).toContain("git-credential-token-1");

    const sshConfig = await readFile(path.join(projected.runtimeDirectory, "ssh_config"), "utf8");
    expect(sshConfig).toContain("Host git.example.com");
    expect(sshConfig).toContain(`IdentityAgent "${context.sshAgentSocket}"`);
    expect(sshConfig).toContain("IdentityFile none");
    expect(sshConfig).not.toContain("/ambient-agent.sock");
    const helper = await readFile(path.join(projected.runtimeDirectory, "git-credential-token-1"), "utf8");
    expect(helper).not.toContain("provider-secret");
  });

  test("matches an SSH assignment by hostname and nonstandard port", async () => {
    const { root, workspace } = await fixture();
    const runtimeRoot = path.join(root, "runtime %h with spaces");
    const agentSocket = path.join(root, "managed %h agent.sock");
    const ssh: SshCredentialRecord = {
      id: "ssh-port",
      name: "port key",
      type: "ssh",
      capabilities: ["ssh-authentication"],
      enabled: true,
      createdAt,
      metadata: { publicKey: "ssh-ed25519 AAAATEST uatu", fingerprint: "SHA256:port" },
    };
    const projected = await buildLocalCredentialEnvironment({
      workspace,
      context: {
        revision: "port",
        runtimeRoot,
        stateRoot: root,
        sshAgentSocket: agentSocket,
        gnupgHome: path.join(root, "gnupg"),
        tools: { ssh: "/managed/ssh", git: null, gpg: null, sshKeygen: null, gh: null, glab: null },
        authentication: [{ host: "git.example.com:2222", credential: ssh }],
        signing: null,
      },
      uatuArgv: ["uatu"],
    });

    const sshConfig = await readFile(path.join(projected.runtimeDirectory, "ssh_config"), "utf8");
    expect(sshConfig).toContain('Match host git.example.com exec "test %p = 2222"');
    expect(sshConfig).toContain(`IdentityAgent "${agentSocket.replaceAll("%", "%%")}"`);
    expect(sshConfig).toContain(`IdentityFile "${path.join(projected.runtimeDirectory, "ssh-port.pub").replaceAll("%", "%%")}"`);
    expect(sshConfig).not.toContain("Host git.example.com:2222");
    const matching = Bun.spawnSync(["ssh", "-G", "-F", path.join(projected.runtimeDirectory, "ssh_config"), "-p", "2222", "git.example.com"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const otherPort = Bun.spawnSync(["ssh", "-G", "-F", path.join(projected.runtimeDirectory, "ssh_config"), "-p", "22", "git.example.com"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(matching.exitCode).toBe(0);
    expect(matching.stdout.toString()).toContain(`identityfile ${path.join(projected.runtimeDirectory, "ssh-port.pub").replaceAll("%", "%%")}`);
    expect(matching.stdout.toString()).toContain(`identityagent ${agentSocket}`);
    expect(otherPort.exitCode).toBe(0);
    expect(otherPort.stdout.toString()).toContain("identityfile none");
  });

  test("keeps broad and port-specific SSH assignments for one hostname mutually exclusive", async () => {
    const { root, workspace } = await fixture();
    const ssh = (id: string): SshCredentialRecord => ({
      id,
      name: id,
      type: "ssh",
      capabilities: ["ssh-authentication"],
      enabled: true,
      createdAt,
      metadata: { publicKey: `ssh-ed25519 AAAA${id.toUpperCase()} uatu`, fingerprint: `SHA256:${id}` },
    });
    const projected = await buildLocalCredentialEnvironment({
      workspace,
      context: {
        revision: "overlap",
        runtimeRoot: path.join(root, "runtime"),
        stateRoot: root,
        sshAgentSocket: path.join(root, "agent.sock"),
        gnupgHome: path.join(root, "gnupg"),
        tools: { ssh: "/managed/ssh", git: null, gpg: null, sshKeygen: null, gh: null, glab: null },
        authentication: [
          { host: "git.example.com", credential: ssh("broad") },
          { host: "git.example.com:2222", credential: ssh("ported") },
        ],
        signing: null,
      },
      uatuArgv: ["uatu"],
    });

    const configPath = path.join(projected.runtimeDirectory, "ssh_config");
    const sshConfig = await readFile(configPath, "utf8");
    // IdentityFile is additive across matching blocks, so the broad block
    // must exclude the port another assignment claims.
    expect(sshConfig).toContain('Match host git.example.com exec "test %p != 2222"');
    const onPort = Bun.spawnSync(["ssh", "-G", "-F", configPath, "-p", "2222", "git.example.com"], { stdout: "pipe", stderr: "pipe" });
    const onDefault = Bun.spawnSync(["ssh", "-G", "-F", configPath, "git.example.com"], { stdout: "pipe", stderr: "pipe" });
    expect(onPort.exitCode).toBe(0);
    expect(onPort.stdout.toString()).toContain("ported.pub");
    expect(onPort.stdout.toString()).not.toContain("broad.pub");
    expect(onDefault.exitCode).toBe(0);
    expect(onDefault.stdout.toString()).toContain("broad.pub");
    expect(onDefault.stdout.toString()).not.toContain("ported.pub");
  });

  test("uses a distinct runtime directory for each session generation", async () => {
    const { root, workspace } = await fixture();
    const context: ResolvedCredentialContext = {
      revision: "none",
      runtimeRoot: path.join(root, "runtime"),
      stateRoot: root,
      sshAgentSocket: null,
      gnupgHome: path.join(root, "gnupg"),
      tools: { ssh: null, git: null, gpg: null, sshKeygen: null, gh: null, glab: null },
      authentication: [],
      signing: null,
    };
    const first = await buildLocalCredentialEnvironment({ workspace, context, uatuArgv: ["uatu"] });
    const second = await buildLocalCredentialEnvironment({ workspace, context, uatuArgv: ["uatu"] });
    const marker = path.join(second.runtimeDirectory, "replacement-marker");
    await writeFile(marker, "replacement");

    expect(first.runtimeDirectory).not.toBe(second.runtimeDirectory);
    expect(await Bun.file(first.runtimeDirectory).exists()).toBe(false);
    await rm(first.runtimeDirectory, { recursive: true, force: true });
    expect(await Bun.file(marker).exists()).toBe(true);
  });

  test("removes a session generation when credential projection fails", async () => {
    const { root, workspace } = await fixture();
    const runtimeRoot = path.join(workspace.path, ".runtime");
    const token: TokenCredentialRecord = {
      id: "provider-failure",
      name: "provider failure",
      type: "token",
      capabilities: ["github-cli"],
      enabled: true,
      createdAt,
      metadata: { host: "github.com" },
    };
    await expect(buildLocalCredentialEnvironment({
      workspace,
      context: {
        revision: "broken-tool",
        runtimeRoot,
        stateRoot: root,
        sshAgentSocket: null,
        gnupgHome: path.join(root, "gnupg"),
        tools: { ssh: null, git: null, gpg: null, sshKeygen: null, gh: "/missing/gh", glab: null },
        authentication: [{ host: "github.com", credential: token, token: "secret" }],
        signing: null,
      },
      uatuArgv: ["uatu"],
    })).rejects.toThrow("outside the repository");

    const workspaceRuntimeDirectory = path.join(runtimeRoot, "sessions", workspace.id);
    expect(await readdir(workspaceRuntimeDirectory)).toEqual([]);
  });

  test("rejects multiple provider CLI credentials in one workspace", async () => {
    const { root, workspace } = await fixture();
    const token = (id: string, host: string): TokenCredentialRecord => ({
      id,
      name: host,
      type: "token",
      capabilities: ["https-git", "github-cli"],
      enabled: true,
      createdAt,
      metadata: { host },
    });
    const first = token("token-one", "one.example.com");
    const second = token("token-two", "two.example.com");

    await expect(buildLocalCredentialEnvironment({
      workspace,
      context: {
        revision: "providers",
        runtimeRoot: path.join(root, "runtime"),
        stateRoot: root,
        sshAgentSocket: null,
        gnupgHome: path.join(root, "gnupg"),
        tools: { ssh: null, git: null, gpg: null, sshKeygen: null, gh: "/managed/gh", glab: null },
        authentication: [
          { host: first.metadata.host, credential: first, token: "one" },
          { host: second.metadata.host, credential: second, token: "two" },
        ],
        signing: null,
      },
      uatuArgv: ["uatu"],
    })).rejects.toThrow("only one provider host");
  });

  test("projects a provider-only token without exposing it to Git", async () => {
    const { root, workspace } = await fixture();
    const managedGh = path.join(root, "managed-gh");
    await writeFile(managedGh, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const providerOnly: TokenCredentialRecord = {
      id: "provider-only",
      name: "GitHub CLI",
      type: "token",
      capabilities: ["github-cli"],
      enabled: true,
      createdAt,
      metadata: { host: "github.example.com" },
    };
    const projected = await buildLocalCredentialEnvironment({
      workspace,
      context: {
        revision: "provider-only",
        runtimeRoot: path.join(root, "runtime"),
        stateRoot: root,
        sshAgentSocket: null,
        gnupgHome: path.join(root, "gnupg"),
        tools: { ssh: null, git: null, gpg: null, sshKeygen: null, gh: managedGh, glab: null },
        authentication: [{ host: providerOnly.metadata.host, credential: providerOnly, token: "provider-secret" }],
        signing: null,
      },
      uatuArgv: ["uatu"],
    });

    expect(projected.env.GH_ENTERPRISE_TOKEN).toBe("provider-secret");
    expect(await Bun.file(path.join(projected.runtimeDirectory, "git-credential-provider-only")).exists()).toBe(false);
    expect(gitConfig(workspace.path, projected.env, "credential.https://github.example.com.helper")).toBe("");
  });

  test("projects an OpenPGP signing assignment through the dedicated GnuPG home", async () => {
    const { root, home, workspace } = await fixture();
    const signing: OpenPgpCredentialRecord = {
      id: "pgp-1",
      name: "signing key",
      type: "openpgp",
      capabilities: ["openpgp-signing"],
      enabled: true,
      createdAt,
      metadata: { publicKey: "public", fingerprint: "A".repeat(40) },
    };
    const gnupgHome = path.join(root, "gnupg");
    const projected = await buildLocalCredentialEnvironment({
      workspace,
      context: {
        revision: "pgp",
        runtimeRoot: path.join(root, "runtime"),
        stateRoot: path.join(root, "state"),
        sshAgentSocket: null,
        gnupgHome,
        tools: { ssh: null, git: null, gpg: "/managed/gpg", sshKeygen: null, gh: null, glab: null },
        authentication: [],
        signing,
      },
      uatuArgv: ["uatu"],
      sourceEnv: { HOME: home, PATH: process.env.PATH, GNUPGHOME: "/ambient/gnupg" },
    });

    expect(projected.env.GNUPGHOME).toBe(gnupgHome);
    expect(gitConfig(workspace.path, projected.env, "gpg.format")).toBe("openpgp");
    expect(gitConfig(workspace.path, projected.env, "user.signingkey")).toBe("A".repeat(40));
    expect(gitConfig(workspace.path, projected.env, "gpg.program")).toBe("/managed/gpg");
  });

  test("removes ambient credentials when there are no assignments and documents the same-UID bypass", async () => {
    const { root, home, workspace } = await fixture();
    const marker = path.join(root, "ambient-helper-used");
    const ambientHelper = path.join(root, "ambient-helper");
    await writeFile(ambientHelper, `#!/bin/sh\ntouch '${marker}'\nprintf 'username=ambient\\npassword=ambient\\n'\n`, { mode: 0o700 });
    await writeFile(path.join(home, ".gitconfig"), [
      "[user]",
      "  name = Ambient User",
      "[credential]",
      `  helper = ${ambientHelper}`,
      "[commit]",
      "  gpgsign = true",
      "",
    ].join("\n"));
    const context: ResolvedCredentialContext = {
      revision: "none",
      runtimeRoot: path.join(root, "runtime"),
      stateRoot: path.join(root, "state"),
      sshAgentSocket: null,
      gnupgHome: path.join(root, "gnupg"),
      tools: { ssh: null, git: null, gpg: null, sshKeygen: null, gh: null, glab: null },
      authentication: [],
      signing: null,
    };
    const projected = await buildLocalCredentialEnvironment({
      workspace,
      context,
      uatuArgv: ["uatu"],
      sourceEnv: {
        HOME: home,
        PATH: process.env.PATH,
        SSH_AUTH_SOCK: "/ambient-agent.sock",
        GNUPGHOME: "/ambient/gnupg",
        GH_TOKEN: "ambient-github",
        GITLAB_TOKEN: "ambient-gitlab",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "!ambient-env-helper",
      },
    });

    expect(projected.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(projected.env.GNUPGHOME).toBeUndefined();
    expect(projected.env.GH_TOKEN).toBeUndefined();
    expect(projected.env.GITLAB_TOKEN).toBeUndefined();
    expect(await gitCredentialFill(workspace.path, projected.env)).not.toBe(0);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(gitConfig(workspace.path, projected.env, "user.name")).toBe("Ambient User");
    expect(gitConfig(workspace.path, projected.env, "commit.gpgsign")).toBe("false");
    expect(await readFile(path.join(projected.runtimeDirectory, "ssh_config"), "utf8")).toContain("IdentityAgent none");

    const bypass = { ...projected.env };
    for (const key of Object.keys(bypass)) {
      if (key === "GIT_SSH_COMMAND" || key.startsWith("GIT_CONFIG_")) delete bypass[key];
    }
    expect(await gitCredentialFill(workspace.path, bypass)).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(true);
    expect(LOCAL_CREDENTIAL_ASSIGNMENT_WARNING).toContain("same-UID processes");
    expect(LOCAL_CREDENTIAL_ASSIGNMENT_WARNING).toContain("unset the configuration");
  });
});

describe("clone credential resolution", () => {
  test("parses SCP remotes into assignment-normalized hosts, keeping IPv6 brackets", () => {
    expect(parseCloneRemote("git@github.com:org/repo.git")).toEqual({ transport: "ssh", host: "github.com" });
    expect(parseCloneRemote("git@GitHub.COM.:org/repo.git")).toEqual({ transport: "ssh", host: "github.com" });
    expect(parseCloneRemote("github.com:org/repo.git")).toEqual({ transport: "ssh", host: "github.com" });
    expect(parseCloneRemote("[github.com]:org/repo.git")).toEqual({ transport: "ssh", host: "github.com" });
    expect(parseCloneRemote("git@[2001:db8::1]:org/repo.git")).toEqual({ transport: "ssh", host: "[2001:db8::1]" });
    // The retained-assignment path feeds this host to metadata.assign, whose
    // parser accepts only the normalized representation.
    expect(normalizeProviderHost("[2001:db8::1]")).toBe("[2001:db8::1]");
  });

  test("resolves only an unlocked compatible SSH credential", async () => {
    const { root } = await fixture();
    const metadata = new CredentialMetadataStore(path.join(root, "credentials.json"));
    const tokens = new CredentialTokenStore(path.join(root, "tokens.json"));
    await Promise.all([metadata.load(), tokens.load()]);
    const ssh = await metadata.create({
      name: "clone key",
      type: "ssh",
      capabilities: ["ssh-authentication"],
      enabled: true,
      metadata: { publicKey: "ssh-ed25519 AAAATEST uatu", fingerprint: "SHA256:test" },
    }, () => "ssh-1", () => new Date(createdAt));
    let usable = false;
    const resolver = createStoredCloneCredentialResolver({
      metadata,
      tokens,
      stateRoot: root,
      sshAgentSocket: () => "/managed/agent.sock",
      sshPath: () => "/managed/ssh",
      sshPublicKeyPath: id => path.join(root, `${id}.pub`),
      sshCredentialUsable: async () => usable,
      uatuArgv: ["uatu"],
    });

    await expect(resolver.resolve("git@github.com:acme/repo.git", ssh.id)).rejects.toThrow("locked");
    usable = true;
    expect(await resolver.resolve("git@github.com:acme/repo.git", ssh.id)).toEqual({
      credentialId: "ssh-1",
      host: "github.com",
      process: {
        type: "ssh",
        host: "github.com",
        sshPath: "/managed/ssh",
        agentSocket: "/managed/agent.sock",
        publicKeyPath: path.join(root, "ssh-1.pub"),
      },
    });
  });

  test("matches HTTPS tokens by provider host and never falls back to another credential", async () => {
    const { root } = await fixture();
    const metadata = new CredentialMetadataStore(path.join(root, "credentials.json"));
    const tokens = new CredentialTokenStore(path.join(root, "tokens.json"));
    await Promise.all([metadata.load(), tokens.load()]);
    const token = await metadata.create({
      name: "GitHub",
      type: "token",
      capabilities: ["https-git"],
      enabled: true,
      metadata: { host: "github.com" },
    }, () => "token-1", () => new Date(createdAt));
    await tokens.set(token.id, "provider-secret");
    const resolver = createStoredCloneCredentialResolver({
      metadata,
      tokens,
      stateRoot: root,
      sshAgentSocket: () => undefined,
      sshPath: () => undefined,
      sshPublicKeyPath: id => path.join(root, `${id}.pub`),
      sshCredentialUsable: async () => false,
      uatuArgv: ["uatu"],
    });

    const selected = await resolver.resolve("https://github.com/acme/repo.git", token.id);
    expect(selected?.process).toEqual({
      type: "https",
      host: "github.com",
      credentialId: "token-1",
      stateRoot: root,
      uatuArgv: ["uatu"],
    });
    expect(JSON.stringify(selected)).not.toContain("provider-secret");
    await expect(resolver.resolve("https://gitlab.com/acme/repo.git", token.id)).rejects.toThrow("does not match");
    await expect(resolver.resolve("git@gitlab.com:acme/repo.git", token.id)).rejects.toThrow("not compatible");
    expect(await resolver.resolve("https://github.com/acme/repo.git")).toBeUndefined();
    await expect(resolver.resolve("https://user:secret@github.com/acme/repo.git")).rejects.toThrow("embedded credentials");
  });
});
