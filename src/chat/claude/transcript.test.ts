import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { claudeProjectDir, listTranscriptSessions, promptText, readSessionTranscript, sessionTranscriptPath } from "./transcript";

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function userLine(uuid: string, text: string, timestamp: string, extra: Record<string, unknown> = {}): string {
  return line({ type: "user", uuid, parentUuid: null, isSidechain: false, timestamp, message: { role: "user", content: text }, ...extra });
}

function assistantLine(uuid: string, text: string, timestamp: string, extra: Record<string, unknown> = {}): string {
  return line({ type: "assistant", uuid, parentUuid: null, isSidechain: false, timestamp, message: { role: "assistant", content: [{ type: "text", text }] }, ...extra });
}

function fixture(): { workspace: string; configDir: string; projectDir: string } {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "uatu-claude-transcript-")));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const configDir = path.join(root, "claude-config");
  const projectDir = claudeProjectDir(workspace, configDir);
  mkdirSync(projectDir, { recursive: true });
  return { workspace, configDir, projectDir };
}

describe("project directory encoding", () => {
  test("replaces every non-alphanumeric with a dash, like the real store", () => {
    const encoded = path.basename(claudeProjectDir("/Users/x/src/github.com/acme/repo_1", "/cfg"));
    expect(encoded).toBe("-Users-x-src-github-com-acme-repo-1");
  });

  test("caps very long paths with a stable disambiguating suffix", () => {
    const long = `/tmp/${"a".repeat(300)}`;
    const encoded = path.basename(claudeProjectDir(long, "/cfg"));
    expect(encoded.length).toBeLessThanOrEqual(210);
    expect(encoded).toMatch(/^-tmp-a+-[a-z0-9]+$/);
    // Deterministic: the same path encodes identically across calls.
    expect(path.basename(claudeProjectDir(long, "/cfg"))).toBe(encoded);
  });

  test("session transcript paths refuse path-shaped session ids", () => {
    expect(() => sessionTranscriptPath("/workspace", "../escape", "/cfg")).toThrow("invalid session id");
    expect(() => sessionTranscriptPath("/workspace", "a/b", "/cfg")).toThrow("invalid session id");
  });
});

describe("reading one transcript", () => {
  test("keeps user and assistant entries, skips and counts everything else", async () => {
    const { projectDir } = fixture();
    const file = path.join(projectDir, "session-1.jsonl");
    writeFileSync(file, [
      line({ type: "queue-operation", operation: "enqueue", timestamp: "2026-08-22T15:53:56.063Z" }),
      userLine("u1", "hello", "2026-08-22T15:54:00.000Z"),
      "this line is not JSON at all {{{\n",
      line({ type: "system", subtype: "hook", timestamp: "2026-08-22T15:54:01.000Z" }),
      assistantLine("a1", "hi there", "2026-08-22T15:54:02.000Z"),
      // A recognizable type whose payload is missing what the shape requires.
      line({ type: "assistant", uuid: "broken", timestamp: "2026-08-22T15:54:03.000Z" }),
    ].join(""));

    const { entries, skipped } = await readSessionTranscript(file);
    expect(entries.map(entry => entry.uuid)).toEqual(["u1", "a1"]);
    expect(entries[0]).toEqual(expect.objectContaining({ kind: "user", parentToolUseId: null, isSidechain: false }));
    expect(entries[0]!.timestamp).toBe(Date.parse("2026-08-22T15:54:00.000Z"));
    expect(skipped).toEqual({ "queue-operation": 1, "": 1, system: 1, assistant: 1 });
  });

  test("marks sidechain entries and their launching tool use", async () => {
    const { projectDir } = fixture();
    const file = path.join(projectDir, "session-2.jsonl");
    writeFileSync(file, [
      userLine("u1", "spawn a subagent", "2026-08-22T15:54:00.000Z"),
      userLine("side-1", "child prompt", "2026-08-22T15:54:01.000Z", { isSidechain: true, parent_tool_use_id: "toolu_123" }),
    ].join(""));
    const { entries } = await readSessionTranscript(file);
    expect(entries[1]).toEqual(expect.objectContaining({ isSidechain: true, parentToolUseId: "toolu_123" }));
  });

  test("prompt text reads strings and text blocks but never tool results", () => {
    const stringEntry = { kind: "user", uuid: "u", parentUuid: null, timestamp: 1, isSidechain: false, parentToolUseId: null, message: { role: "user", content: "typed text" } } as const;
    const blockEntry = { ...stringEntry, message: { role: "user", content: [{ type: "text", text: "block text" }] } };
    const toolResultEntry = { ...stringEntry, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "output" }] } };
    expect(promptText(stringEntry)).toBe("typed text");
    expect(promptText(blockEntry)).toBe("block text");
    expect(promptText(toolResultEntry)).toBeNull();
  });
});

describe("enumerating a workspace's sessions", () => {
  test("lists sessions newest first with first prompts and timestamps", async () => {
    const { workspace, configDir, projectDir } = fixture();
    writeFileSync(path.join(projectDir, "older.jsonl"), [
      userLine("u1", "first question", "2026-08-22T10:00:00.000Z", { cwd: workspace }),
      assistantLine("a1", "answer", "2026-08-22T10:00:05.000Z"),
    ].join(""));
    writeFileSync(path.join(projectDir, "newer.jsonl"), [
      userLine("u2", "second question", "2026-08-22T12:00:00.000Z", { cwd: workspace }),
    ].join(""));

    const { sessions, skippedFiles } = await listTranscriptSessions(workspace, configDir);
    expect(skippedFiles).toBe(0);
    expect(sessions.map(session => session.id)).toEqual(["newer", "older"]);
    expect(sessions[1]).toEqual({
      id: "older",
      firstPrompt: "first question",
      createdAt: Date.parse("2026-08-22T10:00:00.000Z"),
      updatedAt: Date.parse("2026-08-22T10:00:05.000Z"),
    });
  });

  test("a session recorded under a foreign directory is not offered", async () => {
    const { workspace, configDir, projectDir } = fixture();
    writeFileSync(path.join(projectDir, "foreign.jsonl"),
      userLine("u1", "from elsewhere", "2026-08-22T10:00:00.000Z", { cwd: "/somewhere/else" }));
    writeFileSync(path.join(projectDir, "local.jsonl"),
      userLine("u2", "from here", "2026-08-22T11:00:00.000Z", { cwd: workspace }));

    const { sessions, skippedFiles } = await listTranscriptSessions(workspace, configDir);
    expect(sessions.map(session => session.id)).toEqual(["local"]);
    expect(skippedFiles).toBe(1);
  });

  test("a corrupt file degrades to a skip, never a failed enumeration", async () => {
    const { workspace, configDir, projectDir } = fixture();
    writeFileSync(path.join(projectDir, "corrupt.jsonl"), "not json\nstill not json\n");
    writeFileSync(path.join(projectDir, "good.jsonl"),
      userLine("u1", "works", "2026-08-22T11:00:00.000Z", { cwd: workspace }));

    const { sessions, skippedFiles } = await listTranscriptSessions(workspace, configDir);
    expect(sessions.map(session => session.id)).toEqual(["good"]);
    expect(skippedFiles).toBe(1);
  });

  test("a missing project directory is an empty list, not an error", async () => {
    const { workspace, configDir } = fixture();
    const { sessions, skippedFiles } = await listTranscriptSessions(path.join(workspace, "never-used"), configDir);
    expect(sessions).toEqual([]);
    expect(skippedFiles).toBe(0);
  });

  test("sidechain-only files are skipped; sidechains do not shape summaries", async () => {
    const { workspace, configDir, projectDir } = fixture();
    writeFileSync(path.join(projectDir, "children-only.jsonl"),
      userLine("side", "child work", "2026-08-22T10:00:00.000Z", { isSidechain: true }));
    writeFileSync(path.join(projectDir, "mixed.jsonl"), [
      userLine("u1", "parent prompt", "2026-08-22T11:00:00.000Z", { cwd: workspace }),
      userLine("side2", "child prompt", "2026-08-22T12:00:00.000Z", { isSidechain: true }),
    ].join(""));

    const { sessions, skippedFiles } = await listTranscriptSessions(workspace, configDir);
    expect(skippedFiles).toBe(1);
    expect(sessions).toEqual([expect.objectContaining({
      id: "mixed",
      firstPrompt: "parent prompt",
      // The sidechain's later timestamp does not extend the summary.
      updatedAt: Date.parse("2026-08-22T11:00:00.000Z"),
    })]);
  });
});

describe("against the real store layout", () => {
  test("encodes this repository's path exactly as the installed CLI did", () => {
    // The spike observed the CLI create this directory for this repo; the
    // encoder must agree with it byte for byte.
    const encoded = path.basename(claudeProjectDir("/Users/tobias/src/github.com/tjakobsson/uatu", "/cfg"));
    expect(encoded).toBe("-Users-tobias-src-github-com-tjakobsson-uatu");
  });
});
