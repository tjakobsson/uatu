import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { claudeCoverageAnnotations } from "../src/chat/claude/sdk-coverage";
import { openCodeCoverageAnnotations } from "../src/chat/opencode/sdk-coverage";
import {
  CLAUDE_SOURCES,
  ExtractionError,
  FLOORS,
  MATRIX_DIR,
  README_END,
  README_START,
  REPO_ROOT,
  claudeReport,
  extractClaude,
  extractOpenCode,
  generate,
  openCodeReport,
  renderBadge,
  renderMatrix,
  sinceSection,
  staleOutputs,
  type AgentReport,
  type Entry,
} from "./agent-coverage";

const claude = claudeReport();
const openCode = openCodeReport();

function entry(report: AgentReport, axis: string, name: string): Entry {
  const found = report.axes.find(candidate => candidate.id === axis)?.entries.find(candidate => candidate.name === name);
  if (!found) throw new Error(`${report.id} ${axis} has no ${name}`);
  return found;
}

describe("agent coverage: vocabulary extraction", () => {
  test("every axis meets its floor against the installed packages", () => {
    const claudeVocabulary = extractClaude();
    expect(claudeVocabulary.messages.names.length).toBeGreaterThanOrEqual(FLOORS.claudeMessages);
    expect(claudeVocabulary.blocks.names.length).toBeGreaterThanOrEqual(FLOORS.claudeBlocks);
    expect(claudeVocabulary.tools.names.length).toBeGreaterThanOrEqual(FLOORS.claudeTools);
    expect(claudeVocabulary.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
    const openCodeVocabulary = extractOpenCode();
    expect(openCodeVocabulary.v1Events.names.length).toBeGreaterThanOrEqual(FLOORS.openCodeV1Events);
    expect(openCodeVocabulary.v1Parts.names.length).toBeGreaterThanOrEqual(FLOORS.openCodeV1Parts);
    expect(openCodeVocabulary.v2Events.names.length).toBeGreaterThanOrEqual(FLOORS.openCodeV2Events);
    expect(openCodeVocabulary.v2Parts.names.length).toBeGreaterThanOrEqual(FLOORS.openCodeV2Parts);
  });

  test("the stdout-only message types and every result subtype are part of the vocabulary", () => {
    const { messages } = extractClaude();
    expect(messages.names).toContain("active_goal");
    expect(messages.names).toContain("result/success");
    expect(messages.names).toContain("result/error_max_turns");
    expect(messages.names).toContain("system/hook_started");
  });

  test("an axis below its floor fails naming the file and the pattern, not an empty report", () => {
    const stub = mkdtempSync(path.join(tmpdir(), "uatu-coverage-stub-"));
    writeFileSync(path.join(stub, "package.json"), JSON.stringify({ version: "9.9.9" }));
    writeFileSync(path.join(stub, "manifest.json"), JSON.stringify({ version: "9.9.9" }));
    // A layout the patterns no longer understand: one message, no unions.
    writeFileSync(path.join(stub, "sdk.d.ts"), "export interface SDKMessage { type: string }\r\n");
    writeFileSync(path.join(stub, "sdk-tools.d.ts"), "export type ToolInputSchemas = BashInput;\n");
    const run = () => extractClaude({ sdkDir: stub, apiSdkDir: CLAUDE_SOURCES.apiSdkDir });
    expect(run).toThrow(ExtractionError);
    expect(run).toThrow(/sdk\.d\.ts yielded 0 entries for the SDKMessage and StdoutMessage unions/);
  });
});

describe("agent coverage: classification", () => {
  test("states are observed from the product code for the installed Claude SDK", () => {
    expect(entry(claude, "tools", "Bash")).toMatchObject({ state: "dedicated", declared: "BashInput" });
    expect(entry(claude, "tools", "ScheduleWakeup").state).toBe("behavior-missing");
    expect(entry(claude, "tools", "Monitor").state).toBe("generic");
    expect(entry(claude, "messages", "system/hook_started").state).toBe("ignored");
    expect(entry(claude, "messages", "active_goal").state).toBe("unhandled");
    // Dedicated surfaces that are not tool-detail rows are observed too.
    expect(entry(claude, "tools", "TodoWrite")).toMatchObject({ state: "dedicated", renders: "task progress" });
    expect(entry(claude, "tools", "AskUserQuestion")).toMatchObject({ state: "dedicated", renders: "question card" });
    expect(entry(claude, "blocks", "text").state).toBe("dedicated");
    expect(entry(claude, "blocks", "redacted_thinking").state).toBe("unhandled");
  });

  test("behavior-missing entries carry a reason naming the fix, and /loop's tools are both covered", () => {
    for (const name of ["ScheduleWakeup", "CronCreate"]) {
      const found = entry(claude, "tools", name);
      expect(found.state).toBe("behavior-missing");
      expect(found.reason).toContain("/loop");
      expect(found.reason).toContain("claude-scheduled-wakeups");
    }
  });

  test("every annotation key resolves to an extracted entry", () => {
    // An exact key names one entry; a family key (`…*`) at least one ignored entry.
    const resolves = (report: AgentReport, key: string): boolean => {
      const keys = report.axes.flatMap(axis => axis.entries.flatMap(candidate =>
        [`${axis.keyPrefix}${candidate.name}`, ...(candidate.declared ? [`${axis.keyPrefix}${candidate.declared}`] : [])].map(name => ({ name, candidate }))));
      return key.endsWith("*")
        ? keys.some(({ name, candidate }) => name.startsWith(key.slice(0, -1)) && candidate.state === "ignored")
        : keys.filter(({ name }) => name === key).length === 1;
    };
    for (const [report, annotations] of [[claude, claudeCoverageAnnotations], [openCode, openCodeCoverageAnnotations]] as const) {
      for (const key of [...Object.keys(annotations.reasons), ...Object.keys(annotations.behaviorMissing)]) expect(resolves(report, key), key).toBe(true);
    }
    const tools = extractClaude().tools.names;
    for (const key of Object.keys(claudeCoverageAnnotations.toolNames)) expect(tools).toContain(key);
  });

  test("an annotation naming anything the SDK does not declare is rejected by name", () => {
    const vocabulary = extractClaude();
    expect(() => claudeReport(vocabulary, { ...claudeCoverageAnnotations, reasons: { ...claudeCoverageAnnotations.reasons, "system/no_such_subtype": "stale" } }))
      .toThrow(/annotates system\/no_such_subtype, which the installed SDK does not declare/);
    expect(() => claudeReport(vocabulary, { ...claudeCoverageAnnotations, behaviorMissing: { NoSuchTool: "x" } }))
      .toThrow(/annotates NoSuchTool/);
    expect(() => claudeReport(vocabulary, { ...claudeCoverageAnnotations, behaviorMissing: { ...claudeCoverageAnnotations.behaviorMissing, active_goal: "x" } }))
      .toThrow(/marks active_goal behavior-missing, but it is unhandled, not rendered/);
    expect(() => claudeReport(vocabulary, { ...claudeCoverageAnnotations, toolNames: { NoSuchInput: "NoSuch" } }))
      .toThrow(/maps NoSuchInput, which sdk-tools\.d\.ts does not declare/);
    expect(() => openCodeReport(extractOpenCode(), { reasons: { "2.x:no.such.event": "stale" }, behaviorMissing: {} }))
      .toThrow(/annotates 2\.x:no\.such\.event/);
  });

  test("every ignored entry states a reason, and one left without is rejected by name", () => {
    for (const report of [claude, openCode]) {
      for (const axis of report.axes) for (const candidate of axis.entries) {
        if (candidate.state === "ignored") expect(candidate.reason, `${axis.keyPrefix}${candidate.name}`).toBeTruthy();
      }
    }
    const { "system/mirror_error": _dropped, ...reasons } = claudeCoverageAnnotations.reasons;
    expect(() => claudeReport(extractClaude(), { ...claudeCoverageAnnotations, reasons }))
      .toThrow(/states no reason for ignored system\/mirror_error/);
  });

  test("a family key explains every ignored entry under its prefix, and the most specific key wins", () => {
    expect(entry(openCode, "2.x-events", "pty.exited").reason).toBe(openCodeCoverageAnnotations.reasons["2.x:pty.*"]);
    expect(entry(openCode, "1.x-events", "tui.toast.show").reason).toBe(openCodeCoverageAnnotations.reasons["1.x:tui.*"]);
    const specific = openCodeReport(extractOpenCode(), { ...openCodeCoverageAnnotations, reasons: { ...openCodeCoverageAnnotations.reasons, "2.x:pty.exited": "exact" } });
    expect(entry(specific, "2.x-events", "pty.exited").reason).toBe("exact");
    expect(entry(specific, "2.x-events", "pty.created").reason).toBe(openCodeCoverageAnnotations.reasons["2.x:pty.*"]);
    expect(() => openCodeReport(extractOpenCode(), { ...openCodeCoverageAnnotations, reasons: { ...openCodeCoverageAnnotations.reasons, "2.x:no-such-family.*": "stale" } }))
      .toThrow(/family 2\.x:no-such-family\.\*, which matches no ignored entry/);
  });

  test("OpenCode's tool axis says its SDKs do not enumerate tools and lists only dedicated names", () => {
    const tools = openCode.axes.find(axis => axis.id === "tools")!;
    expect(tools.entries.every(candidate => candidate.state === "dedicated")).toBe(true);
    expect(tools.entries.map(candidate => candidate.name)).toEqual(expect.arrayContaining(["bash", "apply_patch", "edit", "task"]));
    const matrix = renderMatrix(openCode, undefined);
    const section = matrix.slice(matrix.indexOf('<a id="axis-tools">'));
    expect(section).toContain("Neither OpenCode SDK enumerates tool names");
    expect(section).toContain("every other tool name renders through the generic tool row");
  });
});

describe("agent coverage: outputs", () => {
  test("regeneration is byte-identical", () => {
    const first = generate();
    const root = mkdtempSync(path.join(tmpdir(), "uatu-coverage-root-"));
    mkdirSync(path.join(root, MATRIX_DIR), { recursive: true });
    for (const file of first) writeFileSync(path.join(root, file.path), file.content);
    expect(generate(root)).toEqual(first);
  });

  test("a version bump lists what arrived and what left, and keeps saying so on the next run", () => {
    const current = renderMatrix(claude, undefined);
    const previous = current
      .replace(/^Generated against .*$/m, "Generated against `@anthropic-ai/claude-agent-sdk` 0.0.1 (bundled Claude Code CLI 0.0.1) · content blocks from `@anthropic-ai/sdk` 0.0.1.")
      .replace(/^\| `active_goal` \|.*\n/m, "")
      .replace(/^\| `Monitor` \|.*\n/m, "")
      .replace(/^\| `assistant` \|/m, "| `retired_type` | dedicated |  |  |\n| `assistant` |");
    const since = sinceSection(claude, previous);
    expect(since).toContain("## Since `@anthropic-ai/claude-agent-sdk` 0.0.1 (bundled Claude Code CLI 0.0.1) · content blocks from `@anthropic-ai/sdk` 0.0.1");
    expect(since).toContain("- **Message types** — added `active_goal`; removed `retired_type`");
    expect(since).toContain("- **Tools** — added `Monitor`");
    // The regenerated matrix, regenerated again, still names the bump.
    const next = renderMatrix(claude, previous);
    expect(renderMatrix(claude, next)).toBe(next);
  });

  test("a hand edit to a carried-forward since section is rejected, even one that still parses", () => {
    const previous = renderMatrix(claude, undefined)
      .replace(/^Generated against .*$/m, "Generated against `@anthropic-ai/claude-agent-sdk` 0.0.1.")
      .replace(/^\| `active_goal` \|.*\n/m, "");
    const next = renderMatrix(claude, previous);
    expect(next).toContain("added `active_goal`");
    for (const edited of [
      next.replace("added `active_goal`", "added `something_else`"),
      next.replace("## Since `@anthropic-ai/claude-agent-sdk` 0.0.1", "## Since `@anthropic-ai/claude-agent-sdk` 0.0.2"),
      next.replace(/^<!-- agent-coverage:since:start seal=[0-9a-f]+ -->$/m, "<!-- agent-coverage:since:start -->"),
    ]) {
      expect(edited).not.toBe(next);
      expect(() => renderMatrix(claude, edited)).toThrow(/does not match its seal, so it was edited by hand/);
    }
  });

  test("the badge carries agent, version, and gap count, is green only at zero gaps, and has no timestamp", () => {
    const svg = renderBadge(claude);
    expect(svg).toContain(`Claude Code: ${claude.badgeVersion} · `);
    expect(svg).toMatch(/\d+ gaps?</);
    expect(svg).not.toMatch(/\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}/);
    const clean: AgentReport = { ...claude, axes: claude.axes.map(axis => ({ ...axis, entries: axis.entries.filter(candidate => candidate.state !== "unhandled" && candidate.state !== "behavior-missing") })) };
    expect(renderBadge(clean)).toContain("0 gaps");
    // badge-maker's brightgreen.
    expect(renderBadge(clean)).toContain("#4b0");
    expect(svg).not.toContain("#4b0");
  });

  test("the README block references only files in the checkout", () => {
    const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    const block = readme.slice(readme.indexOf(README_START), readme.indexOf(README_END) + README_END.length);
    expect(block).not.toMatch(/img\.shields\.io|https?:\/\//);
    const targets = [...block.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map(match => match[1]!);
    expect(targets).toEqual(["docs/agents/claude-code.md", "docs/agents/claude-code.svg", "docs/agents/opencode.md", "docs/agents/opencode.svg"]);
    for (const target of targets) expect(() => readFileSync(path.join(REPO_ROOT, target))).not.toThrow();
  });
});

describe("agent coverage: freshness", () => {
  test("the committed report matches the installed SDKs (run `bun run coverage:agents` after an SDK bump)", () => {
    expect(staleOutputs()).toEqual([]);
  });

  test("a one-character edit to a committed matrix is named as stale", () => {
    const root = mkdtempSync(path.join(tmpdir(), "uatu-coverage-fresh-"));
    mkdirSync(path.join(root, MATRIX_DIR), { recursive: true });
    for (const file of ["README.md", `${MATRIX_DIR}/claude-code.md`, `${MATRIX_DIR}/claude-code.svg`, `${MATRIX_DIR}/opencode.md`, `${MATRIX_DIR}/opencode.svg`]) {
      copyFileSync(path.join(REPO_ROOT, file), path.join(root, file));
    }
    expect(staleOutputs(root)).toEqual([]);
    const matrix = path.join(root, MATRIX_DIR, "claude-code.md");
    writeFileSync(matrix, readFileSync(matrix, "utf8").replace("| `Monitor` | `MonitorInput` | generic |", "| `Monitor` | `MonitorInput` | generiC |"));
    expect(staleOutputs(root)).toEqual([`${MATRIX_DIR}/claude-code.md`]);
  });
});
