import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parsePersonalWorkspaceStatePatch,
  PersonalWorkspaceStateStore,
} from "./personal-state";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempStore(): Promise<{ store: PersonalWorkspaceStateStore; filePath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-personal-state-"));
  tempDirectories.push(dir);
  const filePath = path.join(dir, "state.json");
  const store = new PersonalWorkspaceStateStore(filePath);
  await store.load();
  return { store, filePath };
}

describe("personal workspace state validation", () => {
  test("accepts the complete versioned shape and null clears", () => {
    expect(parsePersonalWorkspaceStatePatch({
      version: 1,
      documentPath: "guides/setup.md",
      follow: false,
      previewMode: "diff",
      compareTarget: "last-commit",
      filesFilter: "changed",
      lastPtyId: "11111111-1111-4111-8111-111111111111",
    })).toEqual({
      version: 1,
      documentPath: "guides/setup.md",
      follow: false,
      previewMode: "diff",
      compareTarget: "last-commit",
      filesFilter: "changed",
      lastPtyId: "11111111-1111-4111-8111-111111111111",
    });
    expect(parsePersonalWorkspaceStatePatch({ documentPath: null })).toEqual({ documentPath: null });
  });

  test("rejects unknown fields and unsafe values", () => {
    expect(() => parsePersonalWorkspaceStatePatch({ user: "other" })).toThrow(/unknown/);
    expect(() => parsePersonalWorkspaceStatePatch({ documentPath: "/etc/passwd" })).toThrow(/relative/);
    expect(() => parsePersonalWorkspaceStatePatch({ documentPath: "a/../b" })).toThrow(/relative/);
    expect(() => parsePersonalWorkspaceStatePatch({ previewMode: "preview" })).toThrow(/previewMode/);
    expect(() => parsePersonalWorkspaceStatePatch({ lastPtyId: "not-a-uuid" })).toThrow(/UUID/);
  });
});

describe("PersonalWorkspaceStateStore", () => {
  test("missing file starts empty and persists owner-only state across reload", async () => {
    const { store, filePath } = await tempStore();
    expect(store.get("tobias", "uatu")).toEqual({ version: 1 });
    await store.patch("tobias", "uatu", { documentPath: "README.md", follow: false });

    const reloaded = new PersonalWorkspaceStateStore(filePath);
    await reloaded.load();
    expect(reloaded.get("tobias", "uatu")).toEqual({
      version: 1,
      documentPath: "README.md",
      follow: false,
    });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  test("corrupt files fail without being overwritten", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-personal-state-"));
    tempDirectories.push(dir);
    const filePath = path.join(dir, "state.json");
    await writeFile(filePath, "not json{");
    const store = new PersonalWorkspaceStateStore(filePath);
    await expect(store.load()).rejects.toThrow(/corrupt/);
    expect(await readFile(filePath, "utf8")).toBe("not json{");
  });

  test("partial and concurrent updates preserve unrelated fields and isolation", async () => {
    const { store, filePath } = await tempStore();
    await Promise.all([
      store.patch("tobias", "uatu", { documentPath: "README.md" }),
      store.patch("tobias", "uatu", { filesFilter: "changed" }),
      store.patch("alice", "uatu", { follow: false }),
      store.patch("tobias", "other", { previewMode: "source" }),
    ]);
    expect(store.get("tobias", "uatu")).toEqual({
      version: 1,
      documentPath: "README.md",
      filesFilter: "changed",
    });
    expect(store.get("alice", "uatu")).toEqual({ version: 1, follow: false });
    expect(store.get("tobias", "other")).toEqual({ version: 1, previewMode: "source" });

    const reloaded = new PersonalWorkspaceStateStore(filePath);
    await reloaded.load();
    expect(reloaded.get("tobias", "uatu")).toEqual(store.get("tobias", "uatu"));
  });

  test("null clears one field and workspace removal clears every user only there", async () => {
    const { store } = await tempStore();
    await store.patch("tobias", "uatu", { documentPath: "README.md", follow: false });
    await store.patch("alice", "uatu", { filesFilter: "changed" });
    await store.patch("tobias", "other", { previewMode: "diff" });
    await store.patch("tobias", "uatu", { documentPath: null });
    expect(store.get("tobias", "uatu")).toEqual({ version: 1, follow: false });

    expect(await store.removeWorkspace("uatu")).toBe(true);
    expect(store.get("tobias", "uatu")).toEqual({ version: 1 });
    expect(store.get("alice", "uatu")).toEqual({ version: 1 });
    expect(store.get("tobias", "other")).toEqual({ version: 1, previewMode: "diff" });
  });

  test("failed writes roll memory back and later mutations can succeed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-personal-state-"));
    tempDirectories.push(dir);
    const stateDir = path.join(dir, "state");
    const filePath = path.join(stateDir, "state.json");
    const store = new PersonalWorkspaceStateStore(filePath);
    await store.load();
    await expect(store.patch("tobias", "uatu", { follow: false })).rejects.toThrow();
    expect(store.get("tobias", "uatu")).toEqual({ version: 1 });

    await mkdir(stateDir);
    await store.patch("tobias", "uatu", { follow: true });
    expect(store.get("tobias", "uatu")).toEqual({ version: 1, follow: true });
  });

  test("failed registry removal restores personal state", async () => {
    const { store } = await tempStore();
    await store.patch("tobias", "uatu", { documentPath: "README.md" });
    await expect(store.forgetWorkspace("uatu", async () => {
      throw new Error("registry disk full");
    })).rejects.toThrow(/registry disk full/);
    expect(store.get("tobias", "uatu")).toEqual({ version: 1, documentPath: "README.md" });
  });

  test("pending forget recovery restores or commits according to the registry", async () => {
    const { store, filePath } = await tempStore();
    await store.patch("tobias", "kept", { follow: false });
    await store.patch("tobias", "gone", { previewMode: "diff" });

    // Simulate crashes after the personal-state removal but before/after the
    // registry removal by planting the durable journal shape directly.
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      records: Record<string, Record<string, unknown>>;
      pendingForgets: Record<string, Record<string, unknown>>;
    };
    persisted.pendingForgets = {
      kept: { tobias: persisted.records.tobias!.kept! },
      gone: { tobias: persisted.records.tobias!.gone! },
    };
    delete persisted.records.tobias!.kept;
    delete persisted.records.tobias!.gone;
    await writeFile(filePath, JSON.stringify(persisted));

    const recovered = new PersonalWorkspaceStateStore(filePath);
    await recovered.load();
    await recovered.recoverPendingForgets(id => id === "kept");
    expect(recovered.get("tobias", "kept")).toEqual({ version: 1, follow: false });
    expect(recovered.get("tobias", "gone")).toEqual({ version: 1 });
  });
});
