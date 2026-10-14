import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isUncontained, openContainedFile, readContainedFile, statContainedFile, UNCONTAINED } from "./contained-file";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

// A root holding `docs/in.md`, and an outside directory holding its own
// `in.md` with bytes that must never come back.
async function layout() {
  const root = await tempDirectory("uatu-contained-root-");
  const outside = await tempDirectory("uatu-contained-outside-");
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs", "in.md"), "inside\n");
  await writeFile(path.join(outside, "in.md"), "OUTSIDE SECRET\n");
  return { root, outside, file: path.join(root, "docs", "in.md") };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error("expected a rejection"); }, (error: unknown) => error);
}

describe("contained files", () => {
  test("a regular file below the root is read with its metadata", async () => {
    const { root, file } = await layout();
    const { text, stats } = await readContainedFile(root, file);
    expect(text).toBe("inside\n");
    expect(stats.size).toBe(7);
    expect((await statContainedFile(root, file)).ino).toBe(stats.ino);
  });

  test("a directory replaced by a link out of the root refuses every read", async () => {
    const { root, outside, file } = await layout();
    await rm(path.join(root, "docs"), { recursive: true });
    await symlink(outside, path.join(root, "docs"));
    // Each read starts only when it is awaited: started together, a later one
    // would reject before its handler is attached.
    for (const attempt of [() => statContainedFile(root, file), () => openContainedFile(root, file), () => readContainedFile(root, file)]) {
      expect(isUncontained(await rejection(attempt()))).toBe(true);
    }
  });

  test("a file replaced by a link refuses every read, even one pointing inside the root", async () => {
    const { root, outside, file } = await layout();
    await writeFile(path.join(root, "sibling.md"), "sibling\n");
    for (const target of [path.join(outside, "in.md"), path.join(root, "sibling.md")]) {
      await rm(file);
      await symlink(target, file);
      expect(isUncontained(await rejection(readContainedFile(root, file)))).toBe(true);
      expect(isUncontained(await rejection(statContainedFile(root, file)))).toBe(true);
    }
  });

  test("a directory link that stays inside the root is still refused", async () => {
    const { root } = await layout();
    await symlink(path.join(root, "docs"), path.join(root, "alias"));
    expect(isUncontained(await rejection(readContainedFile(root, path.join(root, "alias", "in.md"))))).toBe(true);
  });

  test("a root given as a symlink is trusted", async () => {
    const { root } = await layout();
    const holder = await tempDirectory("uatu-contained-holder-");
    const linkedRoot = path.join(holder, "root");
    await symlink(root, linkedRoot);
    const { text } = await readContainedFile(linkedRoot, path.join(linkedRoot, "docs", "in.md"));
    expect(text).toBe("inside\n");
  });

  test("the root itself, an escaping path, and a directory are not contained files", async () => {
    const { root, outside } = await layout();
    expect(isUncontained(await rejection(readContainedFile(root, root)))).toBe(true);
    expect(isUncontained(await rejection(readContainedFile(root, path.join(outside, "in.md"))))).toBe(true);
    expect(isUncontained(await rejection(readContainedFile(root, path.join(root, "..", path.basename(outside), "in.md"))))).toBe(true);
    expect(isUncontained(await rejection(statContainedFile(root, path.join(root, "docs"))))).toBe(true);
  });

  test("a missing file keeps its own error code", async () => {
    const { root } = await layout();
    const error = await rejection(readContainedFile(root, path.join(root, "docs", "gone.md")));
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(isUncontained(error)).toBe(false);
  });

  test("a FIFO swapped in for a file is refused without blocking the open", async () => {
    const { root, file } = await layout();
    await rm(file);
    const made = Bun.spawnSync(["mkfifo", file]);
    if (made.exitCode !== 0) throw new Error("mkfifo failed");
    expect((await rejection(readContainedFile(root, file)) as { code?: string }).code).toBe(UNCONTAINED);
  });

  test("past maxBytes the file is not read", async () => {
    const { root, file } = await layout();
    const { text, stats } = await readContainedFile(root, file, { maxBytes: 3 });
    expect(text).toBeNull();
    expect(stats.size).toBe(7);
  });
});
