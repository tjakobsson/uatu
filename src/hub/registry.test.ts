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

  test("pruneOutsideRoot forgets entries not directly inside the workspaces root", async () => {
    const registry = await tempRegistry();
    await registry.register("/srv/workspaces/keep-me");
    await registry.register("/srv/workspaces/also-keep");
    await registry.register("/home/old/place/legacy");
    // Nested deeper than a direct child is outside too.
    await registry.register("/srv/workspaces/nested/too-deep");

    const removed = await registry.pruneOutsideRoot("/srv/workspaces");
    expect(removed.map(entry => entry.id).sort()).toEqual(["legacy", "too-deep"]);
    expect(registry.list().map(entry => entry.id).sort()).toEqual(["also-keep", "keep-me"]);

    // Idempotent; a second prune removes nothing.
    expect(await registry.pruneOutsideRoot("/srv/workspaces")).toEqual([]);
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
