import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { claudeCoverageAnnotations } from "../src/chat/claude/sdk-coverage";
import { openCodeCoverageAnnotations } from "../src/chat/opencode/sdk-coverage";
import {
  CLAUDE_SOURCES,
  DASHBOARD_ISSUE,
  ExtractionError,
  FLOORS,
  ISSUE_BODY_LIMIT,
  REPO_ROOT,
  buildReports,
  claudeReport,
  extractClaude,
  extractOpenCode,
  openCodeReport,
  parseStateMarker,
  publication,
  renderDashboard,
  renderStateMarker,
  vocabularyOf,
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
    expect(claudeVocabulary.userBlocks.names.length).toBeGreaterThanOrEqual(FLOORS.claudeUserBlocks);
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
    expect(entry(claude, "tools", "ScheduleWakeup")).toMatchObject({ state: "dedicated", renders: "schedule row" });
    expect(entry(claude, "tools", "Monitor").state).toBe("generic");
    expect(entry(claude, "messages", "system/hook_started").state).toBe("ignored");
    expect(entry(claude, "messages", "active_goal").state).toBe("unhandled");
    // Dedicated surfaces that are not tool-detail rows are observed too.
    expect(entry(claude, "tools", "TodoWrite")).toMatchObject({ state: "dedicated", renders: "task progress" });
    expect(entry(claude, "tools", "AskUserQuestion")).toMatchObject({ state: "dedicated", renders: "question card" });
    expect(entry(claude, "blocks", "text").state).toBe("dedicated");
    expect(entry(claude, "blocks", "redacted_thinking").state).toBe("unhandled");
    // User-message blocks are their own axis, observed through a stored user frame.
    expect(entry(claude, "user-blocks", "tool_result").state).toBe("dedicated");
    expect(entry(claude, "user-blocks", "image").state).toBe("dedicated");
    expect(entry(claude, "user-blocks", "document").state).toBe("unhandled");
  });

  test("/loop's tools and the cron family are dedicated now that the session holds its wakeups", () => {
    for (const name of ["ScheduleWakeup", "CronCreate", "CronDelete", "CronList"]) {
      expect(entry(claude, "tools", name)).toMatchObject({ state: "dedicated", renders: "schedule row" });
    }
  });

  test("a behavior-missing annotation marks a rendered entry and carries its reason", () => {
    const report = claudeReport(extractClaude(), { ...claudeCoverageAnnotations, behaviorMissing: { Monitor: "Renders as a tool row, but nothing watches. Fixed by some-change." } });
    const found = report.axes.flatMap(axis => axis.entries).find(candidate => candidate.name === "Monitor")!;
    expect(found.state).toBe("behavior-missing");
    expect(found.reason).toContain("some-change");
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
    const dashboard = renderDashboard([claude, openCode]);
    const section = dashboard.slice(dashboard.indexOf("### OpenCode: Tools"));
    expect(section).toContain("Neither OpenCode SDK enumerates tool names");
    expect(section).toContain("every other tool name renders through the generic tool row");
  });
});

// A report as an older SDK would have produced it: the same entries, minus
// `drop` (per axis id) and plus `add`, under another version line.
function olderReport(report: AgentReport, versionLine: string, drop: Record<string, string[]>, add: Record<string, string[]> = {}): AgentReport {
  return {
    ...report,
    versionLine,
    axes: report.axes.map(axis => ({
      ...axis,
      entries: [
        ...axis.entries.filter(candidate => !(drop[axis.id] ?? []).includes(candidate.name)),
        ...(add[axis.id] ?? []).map(name => ({ name, state: "dedicated" as const })),
      ],
    })),
  };
}

describe("agent coverage: dashboard", () => {
  const reports = [claude, openCode];
  const dashboard = renderDashboard(reports);

  test("rendering is byte-identical and carries no run metadata", () => {
    expect(renderDashboard([claudeReport(), openCodeReport()])).toBe(dashboard);
    expect(dashboard).not.toMatch(/\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}|\b[0-9a-f]{40}\b|actions\/runs/);
  });

  test("the summary names each agent's versions and gap count, and each agent's tables follow", () => {
    expect(dashboard).toContain(`| Claude Code | ${claude.versionLine} |`);
    expect(dashboard).toContain(`| OpenCode | ${openCode.versionLine} |`);
    expect(dashboard).toMatch(/^## Claude Code$/m);
    expect(dashboard).toMatch(/^### Claude Code: Tools$/m);
    expect(dashboard).toContain("| `Monitor` | `MonitorInput` | generic |");
    expect(dashboard).toMatch(/^## OpenCode$/m);
    expect(dashboard).toMatch(/^### OpenCode: 2\.x events$/m);
  });

  test("the hidden marker round-trips the vocabulary, a name containing -- included", () => {
    expect(parseStateMarker(dashboard)).toEqual(vocabularyOf(reports));
    const awkward = { "claude-code": { versionLine: "x --> y", axes: { tools: ["a--b", "c---", "-->"] } } };
    const marker = renderStateMarker(awkward);
    expect(marker.slice("<!-- ".length, -" -->".length)).not.toContain("--");
    expect(parseStateMarker(`intro\n\n${marker}\n`)).toEqual(awkward);
    // GitHub may hand the body back with CRLF line endings.
    expect(parseStateMarker(dashboard.replaceAll("\n", "\r\n"))).toEqual(vocabularyOf(reports));
  });

  test("an unreadable marker is no baseline", () => {
    for (const body of [
      "",
      "a hand-written body",
      dashboard.replace("agent-coverage:state v1 ", "agent-coverage:state v0 "),
      dashboard.replace(/(<!-- agent-coverage:state v1 )\{/, "$1{garbled"),
      dashboard.replace(/(<!-- agent-coverage:state v1 ).*( -->)$/m, '$1{"claude-code":{"versionLine":1,"axes":{}}}$2'),
    ]) expect(parseStateMarker(body)).toBeUndefined();
  });

  test("a bump that adds and removes vocabulary posts both, with the versions before and after", () => {
    const published = renderDashboard([olderReport(claude, "`@anthropic-ai/claude-agent-sdk` 0.0.1", { messages: ["active_goal"], tools: ["Monitor"] }, { messages: ["retired_type"] }), openCode]);
    const result = publication(published, reports);
    expect(result.changed).toBe(true);
    expect(result.body).toBe(dashboard);
    expect(result.comment).toContain("### Claude Code");
    expect(result.comment).toContain("From `@anthropic-ai/claude-agent-sdk` 0.0.1");
    expect(result.comment).toContain(`to ${claude.versionLine}.`);
    expect(result.comment).toContain("- **Message types** — added `active_goal`; removed `retired_type`");
    expect(result.comment).toContain("- **Tools** — added `Monitor`");
    // The agent whose vocabulary did not move is not mentioned.
    expect(result.comment).not.toContain("OpenCode");
  });

  test("a version-only bump changes the body and posts no comment", () => {
    const result = publication(renderDashboard([olderReport(claude, "`@anthropic-ai/claude-agent-sdk` 0.0.1", {}), openCode]), reports);
    expect(result.changed).toBe(true);
    expect(result.comment).toBeUndefined();
  });

  test("republishing an unchanged report edits nothing and posts nothing", () => {
    const result = publication(dashboard.replaceAll("\n", "\r\n").trimEnd(), reports);
    expect(result.changed).toBe(false);
    expect(result.comment).toBeUndefined();
  });

  test("without a readable baseline, the dashboard is the new baseline and no comment is posted", () => {
    for (const previous of [undefined, "This issue is the agent SDK coverage dashboard.", dashboard.replace("agent-coverage:state v1 {", "agent-coverage:state v1 {{")]) {
      const result = publication(previous, reports);
      expect(result.changed).toBe(true);
      expect(result.comment).toBeUndefined();
    }
  });

  test("bumps that land between publications are reported together, against the last published versions", () => {
    // Published at 0.0.1; 0.0.2 (which brought active_goal) was never
    // published; the current SDK also brought Monitor.
    const published = renderDashboard([olderReport(claude, "`@anthropic-ai/claude-agent-sdk` 0.0.1", { messages: ["active_goal"], tools: ["Monitor"] }), openCode]);
    const comment = publication(published, reports).comment!;
    expect(comment).toContain("From `@anthropic-ai/claude-agent-sdk` 0.0.1");
    expect(comment).toContain("added `active_goal`");
    expect(comment).toContain("added `Monitor`");
  });

  test("an axis or agent the published dashboard did not have reports no additions", () => {
    const published = renderDashboard([claude]);
    expect(publication(published, reports).comment).toBeUndefined();
    const withoutTools = renderStateMarker({ ...vocabularyOf(reports), "claude-code": { ...vocabularyOf(reports)["claude-code"]!, axes: { messages: vocabularyOf(reports)["claude-code"]!.axes.messages! } } });
    expect(publication(withoutTools, reports).comment).toBeUndefined();
  });

  test("a dashboard over the issue body limit fails naming its size instead of truncating", () => {
    const padded: AgentReport = { ...claude, axes: [...claude.axes, { id: "padding", title: "Padding", source: "test", keyPrefix: "", entries: Array.from({ length: 2_000 }, (_, index) => ({ name: `padding_entry_${index}`, state: "unhandled" as const })) }] };
    expect(() => renderDashboard([padded, openCode])).toThrow(new RegExp(`the dashboard is \\d+ characters, over the ${ISSUE_BODY_LIMIT}-character limit`));
    expect(dashboard.length).toBeLessThanOrEqual(ISSUE_BODY_LIMIT);
  });

  test("the README and the publication workflow name the same dashboard issue", () => {
    const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    expect(readme.includes(`https://github.com/tjakobsson/uatu/issues/${DASHBOARD_ISSUE}`), `README.md links issue #${DASHBOARD_ISSUE}`).toBe(true);
    const workflow = readFileSync(path.join(REPO_ROOT, ".github/workflows/agent-coverage.yml"), "utf8");
    expect(workflow.includes(`DASHBOARD_ISSUE: "${DASHBOARD_ISSUE}"`), `agent-coverage.yml publishes to issue #${DASHBOARD_ISSUE}`).toBe(true);
  });
});

describe("agent coverage: the installed SDKs", () => {
  // The gate a dependency bump meets: it fails only when uatu's code or
  // annotations must change (an unreadable axis, a stale or unexplained
  // annotation, a probe that no longer tells handled from unhandled), never
  // because a version moved or the vocabulary grew.
  test("both agents' reports build from the installed SDKs, controls included", () => {
    const built = buildReports();
    expect(built.map(report => report.id)).toEqual(["claude-code", "opencode"]);
    for (const report of built) expect(report.axes.every(axis => axis.entries.length > 0)).toBe(true);
  });
});
