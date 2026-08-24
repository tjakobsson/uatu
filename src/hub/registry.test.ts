import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { defaultWorkspaceDisplayName, validateWorkspaceDisplayName, WorkspaceRegistry, workspaceSlug } from "./registry";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempRegistry(): Promise<WorkspaceRegistry> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-registry-"));
  tempDirectories.push(dir);
  const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
  await registry.load();
  return registry;
}

describe("workspaceSlug", () => {
  test("derives a url-safe slug from the folder basename", () => {
    expect(workspaceSlug("/home/t/src/uatu")).toBe("uatu");
    expect(workspaceSlug("/x/My Project!")).toBe("my-project");
    expect(workspaceSlug("/x/---")).toBe("workspace");
  });
});

describe("WorkspaceRegistry", () => {
  test("registers folders with stable ids and re-registration is idempotent", async () => {
    const registry = await tempRegistry();
    const first = await registry.register("/home/t/src/uatu");
    expect(first.id).toBe("uatu");
    expect(first.backend).toBe("local");

    const again = await registry.register("/home/t/src/uatu");
    expect(again.id).toBe("uatu");
    expect(registry.list()).toHaveLength(1);
  });

  test("reports whether registration created the entry", async () => {
    const registry = await tempRegistry();
    const first = await registry.registerWithStatus("/srv/workspaces/status");
    const second = await registry.registerWithStatus("/srv/workspaces/status");

    expect(first.created).toBe(true);
    expect(second).toEqual({ entry: first.entry, created: false });
  });

  test("collisions get numeric suffixes and existing ids keep theirs", async () => {
    const registry = await tempRegistry();
    const first = await registry.register("/a/docs");
    const second = await registry.register("/b/docs");
    const third = await registry.register("/c/docs");
    expect(first.id).toBe("docs");
    expect(second.id).toBe("docs-2");
    expect(third.id).toBe("docs-3");
  });

  test("ids survive a reload from disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-registry-"));
    tempDirectories.push(dir);
    const filePath = path.join(dir, "registry.json");

    const registry = new WorkspaceRegistry(filePath);
    await registry.load();
    await registry.register("/a/docs");
    await registry.register("/b/docs");

    const reloaded = new WorkspaceRegistry(filePath);
    await reloaded.load();
    expect(reloaded.byPath("/a/docs")?.id).toBe("docs");
    expect(reloaded.byPath("/b/docs")?.id).toBe("docs-2");

    // A new registration after reload never reuses a taken id.
    const third = await reloaded.register("/c/docs");
    expect(third.id).toBe("docs-3");
  });

  test("remove deletes an entry and reports unknown ids", async () => {
    const registry = await tempRegistry();
    await registry.register("/a/docs");
    expect(await registry.remove("docs")).toBe(true);
    expect(await registry.remove("docs")).toBe(false);
    expect(registry.list()).toHaveLength(0);
  });

  test("arbitrary absolute paths register — there is no workspaces root", async () => {
    const registry = await tempRegistry();
    const home = await registry.register("/home/t/src/uatu");
    const docs = await registry.register("/var/data/notes");
    const deep = await registry.register("/srv/projects/nested/deep");
    expect(home.id).toBe("uatu");
    expect(docs.id).toBe("notes");
    expect(deep.id).toBe("deep");
    expect(registry.list()).toHaveLength(3);
  });

  test("relative paths are rejected and leave the registry unchanged", async () => {
    const registry = await tempRegistry();
    await expect(registry.register("relative/docs")).rejects.toThrow(/must be absolute/);
    expect(registry.list()).toEqual([]);
  });

  test("a corrupt registry file loads as empty rather than crashing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-registry-"));
    tempDirectories.push(dir);
    const filePath = path.join(dir, "registry.json");
    await Bun.write(filePath, "not json{");

    const registry = new WorkspaceRegistry(filePath);
    await registry.load();
    expect(registry.list()).toEqual([]);
  });

  test("finds exact and nested registrations without matching prefixed siblings", async () => {
    const registry = await tempRegistry();
    await registry.register("/srv/group");
    await registry.register("/srv/group/nested/repo");
    await registry.register("/srv/group-two/repo");
    await registry.register("/srv/other");

    expect(registry.atOrBelow("/srv/group/./").map(entry => entry.path)).toEqual([
      "/srv/group",
      "/srv/group/nested/repo",
    ]);
  });

  test("replaces exact and nested path prefixes while preserving identity", async () => {
    const registry = await tempRegistry();
    const exact = await registry.register("/srv/group");
    const nested = await registry.register("/srv/group/nested/repo");
    const sibling = await registry.register("/srv/group-two/repo");

    const updated = await registry.replacePathPrefix("/srv/group", "/srv/team");

    expect(updated).toEqual([
      { ...exact, path: "/srv/team" },
      { ...nested, path: "/srv/team/nested/repo" },
    ]);
    expect(registry.byId(exact.id)).toEqual({ ...exact, path: "/srv/team" });
    expect(registry.byId(nested.id)).toEqual({ ...nested, path: "/srv/team/nested/repo" });
    expect(registry.byId(sibling.id)).toEqual(sibling);
  });

  test("atomically restores exact journal entries, including a missing id", async () => {
    const registry = await tempRegistry();
    const first = await registry.register("/srv/old/first");
    const second = await registry.register("/srv/old/second");
    await registry.replacePathPrefix("/srv/old", "/srv/new");
    await registry.remove(second.id);

    await registry.restoreEntries([first, second]);
    expect(registry.byId(first.id)).toEqual(first);
    expect(registry.byId(second.id)).toEqual(second);
  });

  test("rejects exact recovery collisions without changing entries", async () => {
    const registry = await tempRegistry();
    const source = await registry.register("/srv/source");
    const occupied = await registry.register("/srv/occupied");
    await expect(registry.restoreEntries([{ ...source, path: occupied.path }])).rejects.toThrow("path collision");
    expect(registry.list()).toEqual([source, occupied]);
  });

  test("rejects replacement collisions without changing memory", async () => {
    const registry = await tempRegistry();
    const source = await registry.register("/srv/source/repo");
    const occupied = await registry.register("/srv/destination/repo");

    await expect(registry.replacePathPrefix("/srv/source", "/srv/destination")).rejects.toThrow("path collision");
    expect(registry.list()).toEqual([source, occupied]);
  });
});

describe("workspace display names", () => {
  test("validation trims and bounds names without requiring uniqueness", () => {
    expect(validateWorkspaceDisplayName("  Payments API  ")).toBe("Payments API");
    expect(validateWorkspaceDisplayName("a".repeat(64))).toBe("a".repeat(64));
    expect(() => validateWorkspaceDisplayName("")).toThrow(/empty/);
    expect(() => validateWorkspaceDisplayName("   ")).toThrow(/empty/);
    expect(() => validateWorkspaceDisplayName("a".repeat(65))).toThrow(/at most 64/);
    expect(() => validateWorkspaceDisplayName("bad\u0000name")).toThrow(/control/);
    expect(() => validateWorkspaceDisplayName("bad\nname")).toThrow(/control/);
    // Invisible formatting: a name of only zero-width characters renders
    // blank yet passes the emptiness check, and bidi overrides can
    // visually spoof other workspace labels.
    expect(() => validateWorkspaceDisplayName("\u200b\u200b")).toThrow(/formatting/);
    expect(() => validateWorkspaceDisplayName("evil\u202egnp.repo")).toThrow(/formatting/);
    expect(() => validateWorkspaceDisplayName(42)).toThrow(/string/);
  });

  test("default display names derive from the folder basename", () => {
    expect(defaultWorkspaceDisplayName("/home/t/src/My Project")).toBe("My Project");
    expect(defaultWorkspaceDisplayName("/")).toBe("workspace");
  });

  test("registration defaults the display name from the basename", async () => {
    const registry = await tempRegistry();
    const entry = await registry.register("/home/t/src/uatu");
    expect(entry.displayName).toBe("uatu");
  });

  test("registration accepts an explicit display name and rejects invalid ones", async () => {
    const registry = await tempRegistry();
    const entry = await registry.register("/srv/payments-service", "local", "Payments API");
    expect(entry.displayName).toBe("Payments API");
    expect(entry.id).toBe("payments-service");

    await expect(registry.register("/srv/other", "local", "bad\u0007name")).rejects.toThrow(/control/);
    expect(registry.byPath("/srv/other")).toBeUndefined();
  });

  test("a pre-display-name registry file migrates and persists basename defaults", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-registry-"));
    tempDirectories.push(dir);
    const filePath = path.join(dir, "registry.json");
    await Bun.write(filePath, JSON.stringify({
      workspaces: [
        { id: "uatu", path: "/home/t/src/uatu", backend: "local" },
        { id: "notes", path: "/var/data/My Notes", backend: "local" },
      ],
    }));

    const registry = new WorkspaceRegistry(filePath);
    await registry.load();
    expect(registry.byId("uatu")).toEqual({ id: "uatu", path: "/home/t/src/uatu", backend: "local", displayName: "uatu" });
    expect(registry.byId("notes")?.displayName).toBe("My Notes");

    // The migration is persisted: a fresh load of the file sees the names
    // without re-deriving them, and ids/paths are byte-for-byte intact.
    const onDisk = JSON.parse(await Bun.file(filePath).text()) as { workspaces: Array<Record<string, unknown>> };
    expect(onDisk.workspaces).toEqual([
      { id: "uatu", path: "/home/t/src/uatu", backend: "local", displayName: "uatu" },
      { id: "notes", path: "/var/data/My Notes", backend: "local", displayName: "My Notes" },
    ]);
  });

  test("duplicate display names are stored unchanged with distinct ids", async () => {
    const registry = await tempRegistry();
    const first = await registry.register("/a/api", "local", "API");
    const second = await registry.register("/b/api", "local", "API");
    expect(first.displayName).toBe("API");
    expect(second.displayName).toBe("API");
    expect(first.id).not.toBe(second.id);
  });

  test("updateDisplayName persists across reload and changes nothing else", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-registry-"));
    tempDirectories.push(dir);
    const filePath = path.join(dir, "registry.json");
    const registry = new WorkspaceRegistry(filePath);
    await registry.load();
    const before = await registry.register("/srv/api");

    const renamed = await registry.updateDisplayName(before.id, "  Payments API ");
    expect(renamed).toEqual({ ...before, displayName: "Payments API" });

    const reloaded = new WorkspaceRegistry(filePath);
    await reloaded.load();
    expect(reloaded.byId(before.id)).toEqual({ ...before, displayName: "Payments API" });
  });

  test("updateDisplayName reports unknown ids and rejects invalid names", async () => {
    const registry = await tempRegistry();
    const entry = await registry.register("/srv/api");
    expect(await registry.updateDisplayName("missing", "Name")).toBeUndefined();
    await expect(registry.updateDisplayName(entry.id, "")).rejects.toThrow(/empty/);
    await expect(registry.updateDisplayName(entry.id, "x".repeat(65))).rejects.toThrow(/at most/);
    expect(registry.byId(entry.id)?.displayName).toBe("api");
  });

  test("a failed rename save rolls the display name back", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-registry-"));
    tempDirectories.push(dir);
    const stateDir = path.join(dir, "state");
    await (await import("node:fs/promises")).mkdir(stateDir);
    const registry = new WorkspaceRegistry(path.join(stateDir, "registry.json"));
    await registry.load();
    const entry = await registry.register("/srv/api");

    await rm(stateDir, { recursive: true, force: true });
    await expect(registry.updateDisplayName(entry.id, "New Name")).rejects.toThrow();
    expect(registry.byId(entry.id)?.displayName).toBe("api");
  });

  test("path-prefix replacement preserves display names", async () => {
    const registry = await tempRegistry();
    const entry = await registry.register("/srv/group/repo", "local", "Kept Name");
    await registry.replacePathPrefix("/srv/group", "/srv/team");
    expect(registry.byId(entry.id)).toEqual({ ...entry, path: "/srv/team/repo" });
    expect(registry.byId(entry.id)?.displayName).toBe("Kept Name");
  });

  test("restoreEntries rejects entries without a valid display name", async () => {
    const registry = await tempRegistry();
    const entry = await registry.register("/srv/api");
    await expect(
      registry.restoreEntries([{ ...entry, displayName: "" }]),
    ).rejects.toThrow(/empty/);
    expect(registry.byId(entry.id)).toEqual(entry);
  });

  test("concurrent renames and registrations serialize with disk matching memory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-registry-"));
    tempDirectories.push(dir);
    const filePath = path.join(dir, "registry.json");
    const registry = new WorkspaceRegistry(filePath);
    await registry.load();
    const entry = await registry.register("/w/alpha");

    await Promise.all([
      registry.updateDisplayName(entry.id, "First"),
      registry.register("/w/beta", "local", "Beta"),
      registry.updateDisplayName(entry.id, "Second"),
      registry.register("/w/gamma"),
    ]);

    expect(registry.byId(entry.id)?.displayName).toBe("Second");
    const reloaded = new WorkspaceRegistry(filePath);
    await reloaded.load();
    expect(reloaded.list()).toEqual(registry.list());
  });
});

describe("registry persistence under concurrency", () => {
  test("concurrent mutations all survive a reload (serialized, atomic saves)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-registry-"));
    tempDirectories.push(dir);
    const filePath = path.join(dir, "registry.json");

    const registry = new WorkspaceRegistry(filePath);
    await registry.load();
    // Fire a burst of unawaited mutations — creates and a forget — then
    // settle them all; the last snapshot must win with every entry intact.
    const churn = [
      registry.register("/a/one"),
      registry.register("/b/two"),
      registry.register("/c/three"),
      registry.register("/d/four"),
      registry.register("/e/five"),
    ];
    await Promise.all(churn);
    await registry.remove("two");

    const reloaded = new WorkspaceRegistry(filePath);
    await reloaded.load();
    expect(reloaded.list().map(entry => entry.id).sort()).toEqual(["five", "four", "one", "three"]);
    // No temp files left behind.
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).filter(name => name.includes(".tmp"))).toEqual([]);
  });
});

describe("registry rollback on persistence failure", () => {
  test("a failed save rolls the mutation back so retries re-attempt the write", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-registry-"));
    tempDirectories.push(dir);
    // A registry whose file lives in a directory that does not exist:
    // every save fails (temp-file write ENOENT).
    const registry = new WorkspaceRegistry(path.join(dir, "missing", "registry.json"));
    await registry.load();

    await expect(registry.register("/srv/workspaces/doomed")).rejects.toThrow();
    // The in-memory entry must not linger — a later retry would otherwise
    // return it without ever persisting.
    expect(registry.list()).toEqual([]);
    expect(registry.byPath("/srv/workspaces/doomed")).toBeUndefined();
  });

  test("a failed remove restores the entry", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-registry-"));
    tempDirectories.push(dir);
    const stateDir = path.join(dir, "state");
    await (await import("node:fs/promises")).mkdir(stateDir);
    const registry = new WorkspaceRegistry(path.join(stateDir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/keeper");

    // Make subsequent saves fail by removing the directory.
    await rm(stateDir, { recursive: true, force: true });
    await expect(registry.remove("keeper")).rejects.toThrow();
    expect(registry.byId("keeper")).toBeDefined();
  });

  test("a failed bulk replacement restores every old path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-registry-"));
    tempDirectories.push(dir);
    const stateDir = path.join(dir, "state");
    await (await import("node:fs/promises")).mkdir(stateDir);
    const registry = new WorkspaceRegistry(path.join(stateDir, "registry.json"));
    await registry.load();
    const parent = await registry.register("/srv/group");
    const child = await registry.register("/srv/group/child");
    await rm(stateDir, { recursive: true, force: true });

    await expect(registry.replacePathPrefix("/srv/group", "/srv/team")).rejects.toThrow();
    expect(registry.list()).toEqual([parent, child]);
  });

  test("a failed exact recovery restores the previous in-memory entries", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-registry-"));
    tempDirectories.push(dir);
    const stateDir = path.join(dir, "state");
    await (await import("node:fs/promises")).mkdir(stateDir);
    const registry = new WorkspaceRegistry(path.join(stateDir, "registry.json"));
    await registry.load();
    const entry = await registry.register("/srv/old");
    await rm(stateDir, { recursive: true, force: true });

    await expect(registry.restoreEntries([{ ...entry, path: "/srv/new" }])).rejects.toThrow();
    expect(registry.byId(entry.id)).toEqual(entry);
  });

  test("bulk replacement preserves ids and backends after reload", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-registry-"));
    tempDirectories.push(dir);
    const filePath = path.join(dir, "registry.json");
    const registry = new WorkspaceRegistry(filePath);
    await registry.load();
    const parent = await registry.register("/srv/group");
    const child = await registry.register("/srv/group/child");
    await registry.replacePathPrefix("/srv/group", "/srv/team");

    const reloaded = new WorkspaceRegistry(filePath);
    await reloaded.load();
    expect(reloaded.byPath("/srv/team")).toEqual({ ...parent, path: "/srv/team" });
    expect(reloaded.byPath("/srv/team/child")).toEqual({ ...child, path: "/srv/team/child" });
  });
});

describe("registry mutation serialization", () => {
  test("interleaved register/remove bursts settle with memory equal to disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-registry-"));
    tempDirectories.push(dir);
    const filePath = path.join(dir, "registry.json");
    const registry = new WorkspaceRegistry(filePath);
    await registry.load();

    // Unawaited interleaving: registers racing a remove racing more
    // registers. Serialized mutations mean the outcome is the sequential
    // one, and disk matches memory exactly afterwards.
    const burst = [
      registry.register("/w/alpha"),
      registry.register("/w/beta"),
      registry.remove("alpha"),
      registry.register("/w/gamma"),
      registry.remove("beta"),
      registry.register("/w/delta"),
    ];
    await Promise.all(burst);

    const inMemory = registry.list().map(entry => entry.id).sort();
    expect(inMemory).toEqual(["delta", "gamma"]);

    const reloaded = new WorkspaceRegistry(filePath);
    await reloaded.load();
    expect(reloaded.list().map(entry => entry.id).sort()).toEqual(inMemory);
  });

  test("a failed mutation does not block or corrupt later ones", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-registry-"));
    tempDirectories.push(dir);
    const stateDir = path.join(dir, "state");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir);
    const filePath = path.join(stateDir, "registry.json");
    const registry = new WorkspaceRegistry(filePath);
    await registry.load();

    // First mutation fails (directory vanishes mid-flight is hard to
    // stage deterministically, so: registry pointed at a good path,
    // remove the dir, fail one register, restore the dir, succeed another).
    await rm(stateDir, { recursive: true, force: true });
    await expect(registry.register("/w/doomed")).rejects.toThrow();
    expect(registry.byPath("/w/doomed")).toBeUndefined();

    await mkdir(stateDir);
    const entry = await registry.register("/w/phoenix");
    expect(entry.id).toBe("phoenix");

    const reloaded = new WorkspaceRegistry(filePath);
    await reloaded.load();
    // The rejected registration must NOT resurrect from any snapshot.
    expect(reloaded.list().map(e => e.id)).toEqual(["phoenix"]);
  });

  test("bulk replacement serializes with concurrent registrations", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-registry-"));
    tempDirectories.push(dir);
    const filePath = path.join(dir, "registry.json");
    const registry = new WorkspaceRegistry(filePath);
    await registry.load();
    const original = await registry.register("/srv/group/repo");

    const [updated, concurrent] = await Promise.all([
      registry.replacePathPrefix("/srv/group", "/srv/team"),
      registry.register("/srv/unrelated/notes"),
    ]);

    expect(updated).toEqual([{ ...original, path: "/srv/team/repo" }]);
    expect(concurrent.path).toBe("/srv/unrelated/notes");
    const reloaded = new WorkspaceRegistry(filePath);
    await reloaded.load();
    expect(reloaded.list()).toEqual(registry.list());
  });
});
