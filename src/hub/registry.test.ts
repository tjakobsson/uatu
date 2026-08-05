import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorkspaceRegistry, workspaceSlug } from "./registry";

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
});
