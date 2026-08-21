import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { toPublicCredentialDto, type PublicToolReadinessDto, type TokenCredentialRecord } from "./credential-types";
import { createProviderRuntime, providerCliSupport } from "./provider-runtime";

const TOKEN = "sentinel-provider-token";
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function readiness(tool: "gh" | "glab", version: string | null, pathValue: string | null = `/usr/bin/${tool}`): PublicToolReadinessDto {
  return { tool, path: pathValue, version, results: [], guidance: null };
}

const GITHUB: TokenCredentialRecord = {
  id: "token-1",
  name: "GitHub",
  type: "token",
  capabilities: ["https-git", "github-cli"],
  enabled: true,
  createdAt: "2026-08-20T12:00:00Z",
  metadata: { host: "github.com", username: "x-access-token" },
};

describe("provider CLI runtime adapters", () => {
  test("reports gh and glab missing or unsupported independently", () => {
    expect(providerCliSupport("github", readiness("gh", "gh version 2.50.0")).status).toBe("supported");
    expect(providerCliSupport("gitlab", readiness("glab", "glab 1.21.0")).status).toBe("unsupported");
    expect(providerCliSupport("gitlab", readiness("glab", null, null)).status).toBe("missing");
    expect(providerCliSupport("github", readiness("gh", "gh version 2.50.0")).status).toBe("supported");
  });

  test("creates owner-only provider config outside the repository with tokens only in the child environment", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "uatu-provider-runtime-"));
    tempDirectories.push(parent);
    const repository = path.join(parent, "repository");
    const runtimeRoot = path.join(parent, "runtime");
    await mkdir(repository, { recursive: true });
    await writeFile(path.join(repository, "remote.txt"), "https://github.com/example/repository.git\n");

    const runtime = await createProviderRuntime("github", runtimeRoot, repository, GITHUB, TOKEN);
    const config = await readFile(path.join(runtime.configDir, "config.yml"), "utf8");
    const repositoryFile = await readFile(path.join(repository, "remote.txt"), "utf8");
    const argv = ["uatu", "--git-credential-helper", "get"];
    const cloneOutput = "Cloning into 'repository'...\n";
    const publicDto = toPublicCredentialDto(GITHUB, [], []);

    expect(runtime.env.GH_TOKEN).toBe(TOKEN);
    expect(JSON.stringify(runtime.env)).toContain(TOKEN);
    for (const publicValue of [config, repositoryFile, argv.join("\0"), cloneOutput, JSON.stringify(publicDto)]) {
      expect(publicValue).not.toContain(TOKEN);
    }
    expect(repositoryFile).not.toContain("@");
    expect((await stat(runtime.configDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(runtime.configDir, "config.yml"))).mode & 0o777).toBe(0o600);
  });

  test("refuses provider config below a repository or for the wrong declared capability", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "uatu-provider-runtime-"));
    tempDirectories.push(parent);
    const repository = path.join(parent, "repository");
    await mkdir(repository, { recursive: true });
    await expect(createProviderRuntime("github", path.join(repository, ".runtime"), repository, GITHUB, TOKEN))
      .rejects.toThrow(/outside/);
    await expect(createProviderRuntime("gitlab", path.join(parent, "runtime"), repository, GITHUB, TOKEN))
      .rejects.toThrow(/does not support/);
  });
});
