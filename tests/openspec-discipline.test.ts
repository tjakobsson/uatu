import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

type StrandedProse = {
  requirement: string;
  scenario: string;
  line: number;
  prose: string;
};

// This checks scenario structure, not whether a WHEN preserves a rule's scope.
function strandedProse(content: string): StrandedProse[] {
  const findings: StrandedProse[] = [];
  let requirement = "";
  let scenario: { name: string; hasStep: boolean; lines: string[]; firstLine: number } | undefined;
  let fence: { character: string; length: number } | undefined;
  const finish = () => {
    if (scenario?.lines.length) {
      findings.push({
        requirement,
        scenario: scenario.name,
        line: scenario.firstLine,
        prose: scenario.lines.join("\n").replace(/\s+/g, " ").trim(),
      });
    }
    scenario = undefined;
  };

  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (fence) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (closing && closing[1]![0] === fence.character && closing[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening && !(opening[1]![0] === "`" && opening[2]!.includes("`"))) {
      fence = { character: opening[1]![0]!, length: opening[1]!.length };
      continue;
    }
    const heading = /^ {0,3}(#{1,4})[ \t]+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const title = heading[2]!.replace(/[ \t]+#+[ \t]*$/, "").trim();
      finish();
      if (level === 3 && title.startsWith("Requirement:")) requirement = title.slice("Requirement:".length).trim();
      else if (level < 4) requirement = "";
      if (level === 4 && title.startsWith("Scenario:")) {
        scenario = { name: title.slice("Scenario:".length).trim(), hasStep: false, lines: [], firstLine: 0 };
      }
      continue;
    }
    if (!scenario) continue;
    if (/^[-*] \*\*(?:GIVEN|WHEN|THEN|AND|BUT)\*\*/.test(line)) {
      scenario.hasStep = true;
      continue;
    }
    if (!line.trim() || (scenario.hasStep && /^[ \t]/.test(line)) || /^(?:-{3,}|\*{3,}|_{3,})[ \t]*$/.test(line)) continue;
    if (!scenario.lines.length) scenario.firstLine = index + 1;
    scenario.lines.push(line);
  }
  finish();
  return findings;
}

function fingerprint(file: string, finding: StrandedProse): string {
  return createHash("sha256")
    .update([file, finding.requirement, finding.scenario, finding.prose].join("\0"))
    .digest("hex");
}

// Three prose tails already belonged to original scenarios at 24c3acf9.
// Preserve that pre-existing text in this editorial migration; exact identity
// and content hashes allow neither a new scenario nor an added paragraph.
const legacyProse = new Set([
  // Keyboard submission cannot bypass pending cancellation.
  "4f9983c43a7b042586979f3aaa2231e19c21238eae455324d90e75cc3dc65c89",
  // Session cost is not a partial message sum or duplicated task cost.
  "76ceb73e012d8d4eb6e5c28297bdab4eede4299e97f7819f2c6bf166f3c03ff8",
  // Expanded pending entries grow while the keyboard is hidden.
  "0d6327d336324f37a0bfce6358fafdfa7a814729fd2a3131897936fd89602a83",
]);

function activeSpecs(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "archive" ? [] : activeSpecs(full);
    return entry.isFile() && entry.name === "spec.md" ? [full] : [];
  });
}

describe("OpenSpec acceptance-step discipline", () => {
  test("detects an old body stranded after generic scenario steps", () => {
    const findings = strandedProse([
      "### Requirement: Preserve identity",
      "A short summary SHALL describe the behavior.",
      "#### Scenario: Start a session",
      "- **WHEN** a session starts",
      "- **THEN** the identity is used",
      "",
      "The service MUST NOT copy credentials at any time.",
    ].join("\n"));
    expect(findings).toEqual([{
      requirement: "Preserve identity",
      scenario: "Start a session",
      line: 7,
      prose: "The service MUST NOT copy credentials at any time.",
    }]);
  });

  test("accepts requirement prose and actual steps with indented continuations", () => {
    expect(strandedProse([
      "### Requirement: Preserve identity",
      "The service MUST NOT copy credentials at any time.",
      "#### Scenario: Start a session",
      "- **WHEN** a session starts",
      "- **THEN** it uses the inherited identity",
      "  without persisting the credential",
      "- **AND** unrelated sessions remain unchanged",
    ].join("\n"))).toEqual([]);
  });

  test("detects prose before a scenario's first step", () => {
    expect(strandedProse([
      "### Requirement: Verify product behavior",
      "The product SHALL satisfy the approved contract.",
      "#### Scenario: Inspect the product",
      "Historical context is not an acceptance precondition.",
      "- **WHEN** the product is inspected",
      "- **THEN** the approved controls are available",
    ].join("\n"))).toEqual([{
      requirement: "Verify product behavior",
      scenario: "Inspect the product",
      line: 4,
      prose: "Historical context is not an acceptance precondition.",
    }]);
  });

  test("indentation cannot hide prose before a scenario's first step", () => {
    expect(strandedProse([
      "### Requirement: Verify product behavior",
      "#### Scenario: Inspect the product",
      "  Historical context is not an acceptance precondition.",
      "- **WHEN** the product is inspected",
      "- **THEN** the approved controls are available",
      "  with an ordinary step continuation",
    ].join("\n"))).toEqual([{
      requirement: "Verify product behavior",
      scenario: "Inspect the product",
      line: 3,
      prose: "Historical context is not an acceptance precondition.",
    }]);
  });

  test("ignores fenced examples rather than parsing their headings as scenarios", () => {
    expect(strandedProse([
      "### Requirement: Render examples",
      "#### Scenario: Read an example",
      "- **WHEN** an example is shown",
      "- **THEN** its text remains literal",
      "````markdown",
      "#### Scenario: This is not a real scenario",
      "```",
      "An example paragraph, not stranded acceptance prose.",
      "````",
      "- **AND** the next step remains part of the actual scenario",
    ].join("\n"))).toEqual([]);
  });

  test("triple-backtick inline code does not hide later prose", () => {
    const findings = strandedProse([
      "### Requirement: Read inline commands",
      "#### Scenario: An inline command is followed by prose",
      "- **WHEN** output is read",
      "- **THEN** the command stays literal",
      "```command```",
      "A stranded normative paragraph MUST still be detected.",
    ].join("\n"));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.prose).toContain("A stranded normative paragraph");
  });

  test("a legacy allowance cannot cover another scenario or additional prose", () => {
    const original: StrandedProse = { requirement: "One", scenario: "One", line: 1, prose: "Old text" };
    const changed = { ...original, prose: "Old text New text" };
    const renamed = { ...original, scenario: "Two" };
    expect(fingerprint("example/spec.md", original)).not.toBe(fingerprint("example/spec.md", changed));
    expect(fingerprint("example/spec.md", original)).not.toBe(fingerprint("example/spec.md", renamed));
  });

  test("active specs contain no newly stranded scenario prose", () => {
    const root = path.resolve(import.meta.dir, "..");
    const files = activeSpecs(path.join(root, "openspec"));
    expect(files.length).toBeGreaterThan(0);
    const findings = files.flatMap(file => {
      const relative = path.relative(root, file).split(path.sep).join("/");
      return strandedProse(readFileSync(file, "utf8"))
        .filter(finding => !legacyProse.has(fingerprint(relative, finding)))
        .map(({ requirement, scenario, line }) => ({ file: relative, requirement, scenario, line }));
    });
    expect(findings).toEqual([]);
  });
});
