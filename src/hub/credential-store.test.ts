import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CredentialMetadataStore,
  CredentialTokenStore,
  CredentialToolOverrideStore,
} from "./credential-store";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempPath(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-store-"));
  tempDirectories.push(directory);
  return path.join(directory, name);
}

const SSH_CREDENTIAL = {
  id: "ssh-1",
  name: "SSH key",
  type: "ssh" as const,
  capabilities: ["ssh-authentication" as const, "ssh-signing" as const],
  enabled: true,
  createdAt: "2026-08-20T12:00:00Z",
  metadata: { publicKey: "ssh-ed25519 AAAA", fingerprint: "SHA256:example" },
};

describe("CredentialMetadataStore", () => {
  test("persists validated state atomically across restart", async () => {
    const filePath = await tempPath("credentials.json");
    const store = new CredentialMetadataStore(filePath);
    await store.load();
    await store.transaction(state => state.credentials.push(SSH_CREDENTIAL));

    const reloaded = new CredentialMetadataStore(filePath);
    await reloaded.load();
    expect(reloaded.snapshot().credentials).toEqual([SSH_CREDENTIAL]);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  test("serializes concurrent mutations without losing updates", async () => {
    const filePath = await tempPath("credentials.json");
    const store = new CredentialMetadataStore(filePath);
    await store.load();
    await Promise.all([
      store.transaction(state => state.credentials.push(SSH_CREDENTIAL)),
      store.transaction(state => state.credentials.push({ ...SSH_CREDENTIAL, id: "ssh-2", name: "Second key" })),
    ]);
    expect(store.snapshot().credentials.map(item => item.id)).toEqual(["ssh-1", "ssh-2"]);
  });

  test("rejects an invalid draft before writing", async () => {
    const filePath = await tempPath("credentials.json");
    const store = new CredentialMetadataStore(filePath);
    await store.load();
    await expect(store.transaction(state => {
      state.credentials.push(SSH_CREDENTIAL, SSH_CREDENTIAL);
    })).rejects.toThrow(/unique/);
    expect(store.snapshot().credentials).toEqual([]);
    expect(await Bun.file(filePath).exists()).toBe(false);
  });

  test("rolls memory back when an atomic write fails", async () => {
    const directory = await tempPath("missing");
    const filePath = path.join(directory, "credentials.json");
    const store = new CredentialMetadataStore(filePath);
    await store.load();
    await expect(store.transaction(state => state.credentials.push(SSH_CREDENTIAL))).rejects.toThrow();
    expect(store.snapshot().credentials).toEqual([]);

    await mkdir(directory);
    await store.transaction(state => state.credentials.push(SSH_CREDENTIAL));
    expect(store.snapshot().credentials).toEqual([SSH_CREDENTIAL]);
  });

  test("creates stable ids with no assignments by default", async () => {
    const filePath = await tempPath("credentials.json");
    const store = new CredentialMetadataStore(filePath);
    await store.load();
    const created = await store.create(
      {
        name: "Generated key",
        type: "ssh",
        capabilities: ["ssh-authentication"],
        enabled: true,
        metadata: SSH_CREDENTIAL.metadata,
      },
      () => "stable-id",
      () => new Date("2026-08-20T13:00:00Z"),
    );
    expect(created.id).toBe("stable-id");
    expect(store.snapshot().assignments).toEqual([]);

    const reloaded = new CredentialMetadataStore(filePath);
    await reloaded.load();
    expect(reloaded.snapshot().credentials[0]?.id).toBe("stable-id");
  });

  test("enforces one authentication host default and one signing default per workspace", async () => {
    const filePath = await tempPath("credentials.json");
    const store = new CredentialMetadataStore(filePath);
    await store.load();
    await store.transaction(state => state.credentials.push(
      SSH_CREDENTIAL,
      { ...SSH_CREDENTIAL, id: "ssh-2", name: "Second key" },
    ));
    await store.assign({ workspaceId: "uatu", credentialId: "ssh-1", role: "authentication", host: "github.com" });
    await store.assign({ workspaceId: "uatu", credentialId: "ssh-1", role: "signing" });
    await expect(store.assign({
      workspaceId: "uatu",
      credentialId: "ssh-2",
      role: "authentication",
      host: "github.com",
    })).rejects.toThrow(/conflicts/);
    await expect(store.assign({
      workspaceId: "uatu",
      credentialId: "ssh-2",
      role: "signing",
    })).rejects.toThrow(/conflicts/);

    await store.assign({
      workspaceId: "uatu",
      credentialId: "ssh-2",
      role: "authentication",
      host: "github.com",
    }, true);
    expect(store.snapshot().assignments).toContainEqual({
      workspaceId: "uatu",
      credentialId: "ssh-2",
      role: "authentication",
      host: "github.com",
    });
  });

  test("validates assignment capability and token host", async () => {
    const filePath = await tempPath("credentials.json");
    const store = new CredentialMetadataStore(filePath);
    await store.load();
    await store.transaction(state => state.credentials.push({
      id: "token-1",
      name: "GitHub token",
      type: "token",
      capabilities: ["https-git"],
      enabled: true,
      createdAt: "2026-08-20T12:00:00Z",
      metadata: { host: "github.com" },
    }));
    await expect(store.assign({
      workspaceId: "uatu",
      credentialId: "token-1",
      role: "authentication",
      host: "gitlab.com",
    })).rejects.toThrow(/host does not match/);
    await expect(store.assign({
      workspaceId: "uatu",
      credentialId: "token-1",
      role: "signing",
    })).rejects.toThrow(/does not support signing/);
  });

  test("cleans assignments on workspace forget and deletes references only when confirmed", async () => {
    const filePath = await tempPath("credentials.json");
    const store = new CredentialMetadataStore(filePath);
    await store.load();
    await store.transaction(state => state.credentials.push(SSH_CREDENTIAL));
    await store.assign({ workspaceId: "uatu", credentialId: "ssh-1", role: "signing" });
    await store.assign({ workspaceId: "other", credentialId: "ssh-1", role: "signing" });
    expect(await store.removeWorkspaceAssignments("other")).toBe(1);
    await expect(store.deleteCredential("ssh-1")).rejects.toThrow(/assigned/);
    expect(store.snapshot().credentials).toHaveLength(1);

    expect(await store.deleteCredential("ssh-1", true)).toBe(true);
    expect(store.snapshot()).toEqual({ version: 1, credentials: [], assignments: [] });
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    expect(persisted).toEqual({ version: 1, credentials: [], assignments: [] });
  });

  test("rolls metadata and assignments back when credential cleanup fails", async () => {
    const filePath = await tempPath("credentials.json");
    const store = new CredentialMetadataStore(filePath);
    await store.load();
    await store.transaction(state => state.credentials.push(SSH_CREDENTIAL));
    await store.assign({ workspaceId: "uatu", credentialId: "ssh-1", role: "signing" });
    const before = store.snapshot();

    await expect(store.deleteCredentialWithCleanup("ssh-1", true, async () => {
      throw new Error("backing cleanup failed");
    })).rejects.toThrow("backing cleanup failed");
    expect(store.snapshot()).toEqual(before);
    const reloaded = new CredentialMetadataStore(filePath);
    await reloaded.load();
    expect(reloaded.snapshot()).toEqual(before);
  });

  test("holds later metadata mutations until cleanup rollback completes", async () => {
    const filePath = await tempPath("credentials.json");
    const store = new CredentialMetadataStore(filePath);
    await store.load();
    await store.transaction(state => state.credentials.push(
      SSH_CREDENTIAL,
      { ...SSH_CREDENTIAL, id: "ssh-2", name: "Second key" },
    ));
    let rejectCleanup!: (error: Error) => void;
    const blocked = store.deleteCredentialWithCleanup("ssh-1", true, () => new Promise((_, reject) => {
      rejectCleanup = reject;
    }));
    const later = store.setEnabled("ssh-2", false);
    await Bun.sleep(1);
    rejectCleanup(new Error("cleanup failed"));

    await expect(blocked).rejects.toThrow("cleanup failed");
    await later;
    expect(store.snapshot().credentials).toEqual([
      SSH_CREDENTIAL,
      { ...SSH_CREDENTIAL, id: "ssh-2", name: "Second key", enabled: false },
    ]);
  });
});

describe("CredentialTokenStore", () => {
  test("persists owner-only tokens without exposing a list API", async () => {
    const filePath = await tempPath("tokens.json");
    const store = new CredentialTokenStore(filePath);
    await store.load();
    await store.set("token-1", "sentinel-token");
    expect(store.get("token-1")).toBe("sentinel-token");
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);

    const reloaded = new CredentialTokenStore(filePath);
    await reloaded.load();
    expect(reloaded.get("token-1")).toBe("sentinel-token");
    expect(await reloaded.delete("token-1")).toBe(true);
    expect(reloaded.get("token-1")).toBeUndefined();
  });

  test("rejects secret files with unsafe permissions", async () => {
    const filePath = await tempPath("tokens.json");
    await Bun.write(filePath, JSON.stringify({ version: 1, tokens: [] }));
    await chmod(filePath, 0o644);
    await expect(new CredentialTokenStore(filePath).load()).rejects.toThrow(/unsafe permissions/);
  });
});

describe("CredentialToolOverrideStore", () => {
  test("persists replacement overrides and restores them after restart", async () => {
    const filePath = await tempPath("credential-tools.json");
    const store = new CredentialToolOverrideStore(filePath);
    await store.load();
    await store.set({ tool: "gpg", path: "/usr/bin/gpg" });
    await store.set({ tool: "gpg", path: "/opt/bin/gpg" });
    await store.set({ tool: "git", path: "/usr/bin/git" });

    const reloaded = new CredentialToolOverrideStore(filePath);
    await reloaded.load();
    expect(reloaded.list()).toEqual([
      { tool: "gpg", path: "/opt/bin/gpg" },
      { tool: "git", path: "/usr/bin/git" },
    ]);
    expect(await reloaded.delete("gpg")).toBe(true);
    expect(JSON.parse(await readFile(filePath, "utf8")).overrides).toEqual([
      { tool: "git", path: "/usr/bin/git" },
    ]);
  });
});
