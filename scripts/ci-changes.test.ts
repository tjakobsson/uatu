import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ci = readFileSync(path.join(import.meta.dir, "..", ".github/workflows/ci.yml"), "utf8");

// Runs ci.yml's own `case` block, so the test follows the workflow's
// classification instead of a copy of its path list.
function classify(file: string): string {
  const block = ci.match(/^[ \t]*case "\$file" in\n[\s\S]*?^[ \t]*esac$/m);
  expect(block, "ci.yml change classifier not found").not.toBeNull();
  const script = `code=false\nfile="$1"\n${block![0]}\necho "$code"`;
  const result = Bun.spawnSync(["bash", "-c", script, "classify", file]);
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim() === "true" ? "code" : "non-code";
}

describe("ci.yml change classifier", () => {
  test("classifies every agent-skill directory as non-code", () => {
    for (const file of [
      ".agents/skills/openspec-propose/SKILL.md",
      ".claude/skills/openspec-propose/SKILL.md",
      ".opencode/skills/openspec-propose/SKILL.md",
    ]) {
      expect(`${file}: ${classify(file)}`).toBe(`${file}: non-code`);
    }
  });

  test("keeps product files and lookalike directories as code", () => {
    for (const file of ["src/app.ts", "package.json", ".agentsrc/config", "agents/skills/SKILL.md"]) {
      expect(`${file}: ${classify(file)}`).toBe(`${file}: code`);
    }
  });
});
