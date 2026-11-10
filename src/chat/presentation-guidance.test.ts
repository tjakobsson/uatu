import { describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHAT_PRESENTATION_GUIDANCE, preparePresentationGuidanceFile, removePresentationGuidanceFile, withPresentationInstructions } from "./presentation-guidance";

describe("Uatu presentation guidance", () => {
  test("merges inherited JSONC without replacing instructions or permissions", () => {
    const original = `{
      // Preserve runtime controls and substitution syntax.
      "instructions": ["team.md", "{env:EXTRA_RULES}"],
      "permissions": [{"action":"edit", "effect":"deny", "resource":"*"}],
      "model": "{env:OPENCODE_MODEL}",
      "providers": {"local": {"settings": {"apiKey": "{file:./key}"}}},
    }`;
    const before = Bun.JSONC.parse(original) as Record<string, unknown> & { instructions: string[] };
    const after = JSON.parse(withPresentationInstructions(original, "/state/uatu/instructions.md"));
    expect(after).toEqual({ ...before, instructions: [...before.instructions, "/state/uatu/instructions.md"] });
    expect(withPresentationInstructions(undefined, "/state/rules.md")).toBe(JSON.stringify({ instructions: ["/state/rules.md"] }));
  });

  test("rejects malformed inherited settings without revealing their values", () => {
    for (const content of ["secret-invalid", "null", "[]", '"secret"', '{"instructions":"secret"}', '{"instructions":[1]}']) {
      expect(() => withPresentationInstructions(content, "/state/rules.md")).toThrow("Uatu cannot add chat guidance:");
      try { withPresentationInstructions(content, "/state/rules.md"); }
      catch (error) { expect(String(error)).not.toContain("secret"); }
    }
  });

  test("materializes bundled text in private app-owned state and removes only its own file", async () => {
    const scratch = path.join(os.tmpdir(), "opencode");
    await fs.mkdir(scratch, { recursive: true });
    const root = await fs.mkdtemp(path.join(scratch, "uatu-presentation-test-"));
    try {
      const env = { XDG_STATE_HOME: root };
      const first = await preparePresentationGuidanceFile(env);
      const second = await preparePresentationGuidanceFile(env);
      expect(first).not.toBe(second);
      expect(first.startsWith(path.join(root, "uatu", "chat-presentation"))).toBe(true);
      expect(await fs.readFile(first, "utf8")).toBe(CHAT_PRESENTATION_GUIDANCE);
      expect((await fs.stat(first)).mode & 0o777).toBe(0o600);
      await removePresentationGuidanceFile(first);
      expect(await fs.readFile(second, "utf8")).toBe(CHAT_PRESENTATION_GUIDANCE);
      expect(await Bun.file(first).exists()).toBe(false);
      await removePresentationGuidanceFile(second);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test("startup sweeps proven-dead owned sessions while preserving live and unknown directories", async () => {
    const scratch = path.join(os.homedir(), ".cache/opencode/scratch/uatu-544-review-resume-20261030");
    await fs.mkdir(scratch, { recursive: true });
    const root = await fs.mkdtemp(path.join(scratch, "guidance-sweep-"));
    const directory = path.join(root, "uatu", "chat-presentation");
    const kill = spyOn(process, "kill").mockImplementation(pid => {
      if (pid === 1234567) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    });
    try {
      for (const name of ["session-dead", "session-live", "session-legacy", "session-with-extra"]) {
        const owned = path.join(directory, name);
        await fs.mkdir(owned, { recursive: true });
        await fs.writeFile(path.join(owned, "instructions.md"), name);
        if (name !== "session-legacy") await fs.writeFile(path.join(owned, "owner.json"), JSON.stringify({ kind: "uatu-chat-presentation", version: 1, pid: name === "session-live" ? process.pid : 1234567 }));
      }
      await fs.writeFile(path.join(directory, "session-with-extra", "keep.txt"), "not an owned instruction file");
      const file = await preparePresentationGuidanceFile({ XDG_STATE_HOME: root });
      expect(await Bun.file(path.join(directory, "session-dead", "instructions.md")).exists()).toBe(false);
      for (const name of ["session-live", "session-legacy", "session-with-extra"]) {
        expect(await fs.readFile(path.join(directory, name, "instructions.md"), "utf8")).toBe(name);
      }
      expect(await fs.readFile(file, "utf8")).toBe(CHAT_PRESENTATION_GUIDANCE);
      await removePresentationGuidanceFile(file);
    } finally { kill.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
  });
});
