import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CredentialMetadataStore, CredentialTokenStore } from "./credential-store";
import { TokenCredentialManager } from "./token-credentials";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function manager(): Promise<{
  directory: string;
  metadataPath: string;
  tokenPath: string;
  manager: TokenCredentialManager;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "uatu-token-credentials-"));
  tempDirectories.push(directory);
  const metadataPath = path.join(directory, "credentials.json");
  const tokenPath = path.join(directory, "tokens.json");
  const manager = new TokenCredentialManager(
    new CredentialMetadataStore(metadataPath),
    new CredentialTokenStore(tokenPath),
  );
  await manager.load();
  return { directory, metadataPath, tokenPath, manager };
}

describe("TokenCredentialManager", () => {
  test("normalizes hosts and persists declared capabilities without putting the token in metadata", async () => {
    const fixture = await manager();
    const credential = await fixture.manager.create({
      name: "GitHub",
      host: "https://GitHub.COM./",
      username: "x-access-token",
      token: "sentinel-provider-token",
      capabilities: ["https-git", "github-cli"],
    }, () => "token-1", () => new Date("2026-08-20T12:00:00Z"));

    expect(credential.metadata.host).toBe("github.com");
    expect(credential.capabilities).toEqual(["https-git", "github-cli"]);
    expect(await readFile(fixture.metadataPath, "utf8")).not.toContain("sentinel-provider-token");
    expect((await stat(fixture.metadataPath)).mode & 0o777).toBe(0o600);
    expect((await stat(fixture.tokenPath)).mode & 0o777).toBe(0o600);

    const reloaded = new TokenCredentialManager(
      new CredentialMetadataStore(fixture.metadataPath),
      new CredentialTokenStore(fixture.tokenPath),
    );
    await reloaded.load();
    expect(reloaded.resolve("token-1")?.token).toBe("sentinel-provider-token");
  });

  test("disables new use, re-enables it, and deletes metadata, assignments, and secret backing", async () => {
    const fixture = await manager();
    await fixture.manager.create({
      name: "GitLab",
      host: "gitlab.com",
      token: "sentinel-provider-token",
      capabilities: ["https-git", "gitlab-cli"],
    }, () => "token-1");

    await fixture.manager.setEnabled("token-1", false);
    expect(fixture.manager.resolve("token-1")).toBeUndefined();
    await fixture.manager.setEnabled("token-1", true);
    expect(fixture.manager.resolve("token-1")?.credential.enabled).toBe(true);
    expect(await fixture.manager.delete("token-1", true)).toBe(true);
    expect(fixture.manager.resolve("token-1")).toBeUndefined();
    expect(await readFile(fixture.metadataPath, "utf8")).not.toContain("token-1");
    expect(await readFile(fixture.tokenPath, "utf8")).not.toContain("sentinel-provider-token");
  });

  test("rejects ambiguous provider capabilities and host paths", async () => {
    const fixture = await manager();
    await expect(fixture.manager.create({
      name: "Ambiguous",
      host: "github.com/org",
      token: "sentinel-provider-token",
      capabilities: ["github-cli", "gitlab-cli"],
    })).rejects.toThrow(/path|both provider/);
    expect(await Bun.file(fixture.tokenPath).exists()).toBe(false);

    await expect(fixture.manager.create({
      name: "Injected",
      host: "github.com",
      username: "user\npassword=other",
      token: "sentinel-provider-token",
      capabilities: ["https-git"],
    })).rejects.toThrow(/protocol line/);
    await expect(fixture.manager.create({
      name: "Injected",
      host: "github.com",
      token: "token\nusername=other",
      capabilities: ["https-git"],
    })).rejects.toThrow(/protocol value/);
  });
});
