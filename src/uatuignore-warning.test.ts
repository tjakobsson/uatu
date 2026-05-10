import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  __resetUatuignoreWarningCacheForTests,
  warnAboutRetiredUatuignore,
} from "./uatuignore-warning";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-uatuignore-warn-"));
  __resetUatuignoreWarningCacheForTests();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("warnAboutRetiredUatuignore", () => {
  it("emits no warning when no .uatuignore exists", async () => {
    const messages: string[] = [];
    await warnAboutRetiredUatuignore([workspace], { log: msg => messages.push(msg) });
    expect(messages).toEqual([]);
  });

  it("emits one warning when .uatuignore exists at the root", async () => {
    await fs.writeFile(path.join(workspace, ".uatuignore"), "*.lock\n");
    const messages: string[] = [];
    await warnAboutRetiredUatuignore([workspace], { log: msg => messages.push(msg) });
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(".uatuignore");
    expect(messages[0]).toContain(".uatu.json tree.exclude");
    expect(messages[0]).toContain(workspace);
  });

  it("emits the warning exactly once per session for the same root", async () => {
    await fs.writeFile(path.join(workspace, ".uatuignore"), "*.lock\n");
    const messages: string[] = [];
    await warnAboutRetiredUatuignore([workspace], { log: msg => messages.push(msg) });
    await warnAboutRetiredUatuignore([workspace], { log: msg => messages.push(msg) });
    await warnAboutRetiredUatuignore([workspace], { log: msg => messages.push(msg) });
    expect(messages.length).toBe(1);
  });

  it("emits one warning per distinct watched root", async () => {
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-uatuignore-warn-other-"));
    try {
      await fs.writeFile(path.join(workspace, ".uatuignore"), "*.lock\n");
      await fs.writeFile(path.join(otherRoot, ".uatuignore"), "*.tmp\n");
      const messages: string[] = [];
      await warnAboutRetiredUatuignore([workspace, otherRoot], { log: msg => messages.push(msg) });
      expect(messages.length).toBe(2);
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("does not throw on unreadable roots and continues for sibling roots", async () => {
    await fs.writeFile(path.join(workspace, ".uatuignore"), "*.lock\n");
    const messages: string[] = [];
    await expect(
      warnAboutRetiredUatuignore([workspace, "/path/that/does/not/exist"], {
        log: msg => messages.push(msg),
      }),
    ).resolves.toBeUndefined();
    expect(messages.length).toBe(1);
  });
});
