import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { HubPreferencesStore } from "./preferences";
import { WorkspaceRegistry } from "./registry";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "uatu-hub-prefs-")));
  tempDirectories.push(dir);
  return dir;
}

async function fixture() {
  const root = await tempRoot();
  const home = path.join(root, "home");
  const parent = path.join(root, "workspaces");
  await Promise.all([fs.mkdir(home), fs.mkdir(parent)]);
  const filePath = path.join(root, "hub-preferences.json");
  const store = new HubPreferencesStore(filePath, () => home);
  await store.load();
  return { root, home, parent, filePath, store };
}

describe("HubPreferencesStore", () => {
  test("defaults to no configured parent with the home directory effective", async () => {
    const f = await fixture();
    expect(f.store.configuredDefaultWorkspaceParent()).toBeNull();
    expect(await f.store.resolveDefaultWorkspaceParent()).toEqual({
      configured: null,
      configuredAvailable: false,
      effective: f.home,
    });
  });

  test("saves a canonical parent owner-only and survives restart", async () => {
    const f = await fixture();
    // A non-canonical spelling of the same directory canonicalizes on save.
    const saved = await f.store.setDefaultWorkspaceParent(path.join(f.parent, ".", "..", "workspaces"));
    expect(saved).toBe(f.parent);
    expect((await fs.lstat(f.filePath)).mode & 0o777).toBe(0o600);

    const reloaded = new HubPreferencesStore(f.filePath, () => f.home);
    await reloaded.load();
    expect(reloaded.configuredDefaultWorkspaceParent()).toBe(f.parent);
    expect(await reloaded.resolveDefaultWorkspaceParent()).toEqual({
      configured: f.parent,
      configuredAvailable: true,
      effective: f.parent,
    });
  });

  test("preserves significant whitespace in a default parent path", async () => {
    const f = await fixture();
    const padded = path.join(f.root, "workspaces ");
    await fs.mkdir(padded);

    expect(await f.store.setDefaultWorkspaceParent(padded)).toBe(padded);
    expect(f.store.configuredDefaultWorkspaceParent()).toBe(padded);
    expect(await f.store.resolveDefaultWorkspaceParent()).toEqual({
      configured: padded,
      configuredAvailable: true,
      effective: padded,
    });
  });

  test("rejects relative, missing, file, and symlink parents without changing the value", async () => {
    const f = await fixture();
    await f.store.setDefaultWorkspaceParent(f.parent);

    const file = path.join(f.root, "not-a-dir.txt");
    await fs.writeFile(file, "x");
    const link = path.join(f.root, "linked");
    await fs.symlink(f.parent, link);

    for (const invalid of ["relative/path", path.join(f.root, "missing"), file, link, 42, "with\0null"]) {
      await expect(f.store.setDefaultWorkspaceParent(invalid)).rejects.toMatchObject({ code: "invalid-input" });
    }
    expect(f.store.configuredDefaultWorkspaceParent()).toBe(f.parent);
  });

  test("an unavailable saved parent stays visible while home becomes effective", async () => {
    const f = await fixture();
    await f.store.setDefaultWorkspaceParent(f.parent);
    await fs.rmdir(f.parent);

    expect(await f.store.resolveDefaultWorkspaceParent()).toEqual({
      configured: f.parent,
      configuredAvailable: false,
      effective: f.home,
    });
    // The saved value is retained for diagnosis, including across restart.
    const reloaded = new HubPreferencesStore(f.filePath, () => f.home);
    await reloaded.load();
    expect(reloaded.configuredDefaultWorkspaceParent()).toBe(f.parent);
  });

  test("a parent replaced by a symlink becomes unavailable rather than followed", async () => {
    const f = await fixture();
    await f.store.setDefaultWorkspaceParent(f.parent);
    await fs.rmdir(f.parent);
    await fs.symlink(f.home, f.parent);

    const state = await f.store.resolveDefaultWorkspaceParent();
    expect(state.configuredAvailable).toBe(false);
    expect(state.effective).toBe(f.home);
  });

  test("clearing removes the configured value and restores the home default", async () => {
    const f = await fixture();
    await f.store.setDefaultWorkspaceParent(f.parent);
    await f.store.clearDefaultWorkspaceParent();
    expect(f.store.configuredDefaultWorkspaceParent()).toBeNull();
    expect((await f.store.resolveDefaultWorkspaceParent()).effective).toBe(f.home);

    const reloaded = new HubPreferencesStore(f.filePath, () => f.home);
    await reloaded.load();
    expect(reloaded.configuredDefaultWorkspaceParent()).toBeNull();
  });

  test("a corrupt or foreign-version file loads as defaults", async () => {
    const f = await fixture();
    await fs.writeFile(f.filePath, "not json{");
    await f.store.load();
    expect(f.store.configuredDefaultWorkspaceParent()).toBeNull();

    await fs.writeFile(f.filePath, JSON.stringify({ version: 99, defaultWorkspaceParent: f.parent }));
    await f.store.load();
    expect(f.store.configuredDefaultWorkspaceParent()).toBeNull();
  });

  test("a failed save rolls the mutation back", async () => {
    const root = await tempRoot();
    const parent = path.join(root, "workspaces");
    await fs.mkdir(parent);
    const stateDir = path.join(root, "state");
    await fs.mkdir(stateDir);
    const store = new HubPreferencesStore(path.join(stateDir, "hub-preferences.json"), () => root);
    await store.load();

    await fs.rm(stateDir, { recursive: true, force: true });
    await expect(store.setDefaultWorkspaceParent(parent)).rejects.toMatchObject({ code: "internal" });
    expect(store.configuredDefaultWorkspaceParent()).toBeNull();
  });

  test("a failed chmod fails the save before it commits, leaving disk and memory agreed", async () => {
    const f = await fixture();
    const second = path.join(f.root, "other-workspaces");
    await fs.mkdir(second);
    await f.store.setDefaultWorkspaceParent(f.parent);

    const chmodSpy = spyOn(fs, "chmod").mockRejectedValue(new Error("injected chmod failure"));
    try {
      await expect(f.store.setDefaultWorkspaceParent(second)).rejects.toMatchObject({ code: "internal" });
    } finally {
      chmodSpy.mockRestore();
    }

    // The rollback is honest: the uncommitted write left the old value on
    // disk, so a restart sees exactly what the getter reports.
    expect(f.store.configuredDefaultWorkspaceParent()).toBe(f.parent);
    expect(JSON.parse(await fs.readFile(f.filePath, "utf8")).defaultWorkspaceParent).toBe(f.parent);
    const reloaded = new HubPreferencesStore(f.filePath, () => f.home);
    await reloaded.load();
    expect(reloaded.configuredDefaultWorkspaceParent()).toBe(f.parent);

    // The mode is set on the temporary file, never on the published one.
    expect(chmodSpy.mock.calls.map(([target]) => target)).not.toContain(f.filePath);
    expect(chmodSpy.mock.calls.every(([target]) => String(target).endsWith(".tmp"))).toBe(true);

    // No temporary file survives the failure, and the next save still lands
    // owner-only.
    expect((await fs.readdir(f.root)).some(name => name.endsWith(".tmp"))).toBe(false);
    await f.store.setDefaultWorkspaceParent(second);
    expect((await fs.lstat(f.filePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(f.filePath, "utf8")).defaultWorkspaceParent).toBe(second);
  });

  test("clearing survives a failed chmod without diverging from disk", async () => {
    const f = await fixture();
    await f.store.setDefaultWorkspaceParent(f.parent);

    const chmodSpy = spyOn(fs, "chmod").mockRejectedValue(new Error("injected chmod failure"));
    try {
      await expect(f.store.clearDefaultWorkspaceParent()).rejects.toMatchObject({ code: "internal" });
    } finally {
      chmodSpy.mockRestore();
    }

    expect(f.store.configuredDefaultWorkspaceParent()).toBe(f.parent);
    expect(JSON.parse(await fs.readFile(f.filePath, "utf8")).defaultWorkspaceParent).toBe(f.parent);
  });

  test("the default parent does not constrain workspace registration", async () => {
    const f = await fixture();
    await f.store.setDefaultWorkspaceParent(f.parent);

    const registry = new WorkspaceRegistry(path.join(f.root, "registry.json"));
    await registry.load();
    const outside = await registry.register(path.join(f.root, "home", "elsewhere-project"));
    expect(outside.id).toBe("elsewhere-project");
    expect(registry.byPath(path.join(f.home, "elsewhere-project"))).toBeDefined();
  });
});
