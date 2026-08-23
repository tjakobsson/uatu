import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadNoReplaceRename } from "./rename-no-replace";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("loadNoReplaceRename", () => {
  test("is available on the supported platforms and refuses existing destinations atomically", async () => {
    const rename = loadNoReplaceRename();
    // Both CI platforms (darwin, glibc linux) expose the primitive; a null
    // here would silently regress every rename to the fallback strategy.
    expect(rename).not.toBeNull();

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-rename-excl-"));
    tempDirectories.push(root);
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "kept.txt"), "kept");

    // Absent destination: the rename succeeds and moves content.
    expect(rename!(source, destination)).toBe(0);
    expect(await fs.readFile(path.join(destination, "kept.txt"), "utf8")).toBe("kept");

    // Existing destination — even an empty directory POSIX rename would
    // silently replace — is refused without touching either side.
    const occupied = path.join(root, "occupied");
    await fs.mkdir(occupied);
    expect(rename!(destination, occupied)).not.toBe(0);
    expect(await fs.readFile(path.join(destination, "kept.txt"), "utf8")).toBe("kept");
    expect((await fs.readdir(occupied)).length).toBe(0);
  });
});
