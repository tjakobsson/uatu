import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { WatchEntry } from "../server/roots";
import {
  ConversationNotFoundError,
  isSessionInWorkspace,
  requireWorkspaceSession,
  selectCanonicalChatRoot,
} from "./workspace";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "uatu-chat-root-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("canonical chat root", () => {
  test("uses the canonical first root for direct multi-root serving", async () => {
    const parent = await tempDirectory();
    const first = path.join(parent, "first");
    const second = path.join(parent, "second");
    await mkdir(first);
    await mkdir(second);
    const entries: WatchEntry[] = [
      { kind: "dir", absolutePath: first },
      { kind: "dir", absolutePath: second },
    ];

    expect(await selectCanonicalChatRoot(entries)).toBe(await realpath(first));
  });

  test("canonicalizes a symlink root and uses a file root's containing directory", async () => {
    const parent = await tempDirectory();
    const target = path.join(parent, "target");
    const link = path.join(parent, "link");
    await mkdir(target);
    await symlink(target, link);

    expect(await selectCanonicalChatRoot([{ kind: "dir", absolutePath: link }])).toBe(await realpath(target));
    expect(await selectCanonicalChatRoot([{
      kind: "file",
      absolutePath: path.join(target, "README.md"),
      parentDir: target,
    }])).toBe(await realpath(target));
  });

  test("rejects an empty or missing first root", async () => {
    const parent = await tempDirectory();
    await expect(selectCanonicalChatRoot([])).rejects.toThrow(/watch root/);
    await expect(selectCanonicalChatRoot([{ kind: "dir", absolutePath: path.join(parent, "missing") }])).rejects.toThrow(/available directory/);
  });
});

describe("session directory validation", () => {
  test("accepts symlink-equivalent workspace paths", async () => {
    const parent = await tempDirectory();
    const target = path.join(parent, "target");
    const link = path.join(parent, "link");
    await mkdir(target);
    await symlink(target, link);
    expect(await isSessionInWorkspace(link, target)).toBe(true);
  });

  test("uses normalized paths as a fallback when both paths no longer resolve", async () => {
    const parent = await tempDirectory();
    const missing = path.join(parent, "gone");
    expect(await isSessionInWorkspace(`${missing}/.`, missing)).toBe(true);
    expect(await isSessionInWorkspace(path.join(parent, "other"), missing)).toBe(false);
  });

  test("returns the session only after directory validation", async () => {
    const workspace = await tempDirectory();
    const session = { id: "session-1", directory: workspace, title: "Chat" };
    expect(await requireWorkspaceSession("session-1", workspace, async () => session)).toBe(session);
  });

  test("does not reveal whether a session is missing or foreign", async () => {
    const workspace = await tempDirectory();
    const foreign = await tempDirectory();
    const missing = requireWorkspaceSession("missing", workspace, async () => null);
    const outside = requireWorkspaceSession("foreign", workspace, async () => ({ id: "foreign", directory: foreign }));

    await expect(missing).rejects.toBeInstanceOf(ConversationNotFoundError);
    await expect(outside).rejects.toBeInstanceOf(ConversationNotFoundError);
    await expect(missing).rejects.toThrow("conversation not found");
    await expect(outside).rejects.toThrow("conversation not found");
  });
});
