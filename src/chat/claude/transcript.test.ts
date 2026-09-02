import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { claudeProjectDir, foldCommandMarkup, listTranscriptSessions, promptText, readSessionTranscript, readTranscriptTitles, sessionTranscriptPath } from "./transcript";

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

  test("prompt text folds slash-command markup to what was typed", () => {
    const markup = "<command-message>openspec-explore</command-message>\n<command-name>/openspec-explore</command-name>\n<command-args>why is the build slow?</command-args>";
    const stringEntry = { kind: "user", uuid: "u", parentUuid: null, timestamp: 1, isSidechain: false, parentToolUseId: null, message: { role: "user", content: markup } } as const;
    const blockEntry = { ...stringEntry, message: { role: "user", content: [{ type: "text", text: markup }] } };
    expect(promptText(stringEntry)).toBe("/openspec-explore why is the build slow?");
    expect(promptText(blockEntry)).toBe("/openspec-explore why is the build slow?");
  });
});

describe("folding slash-command markup", () => {
  test("joins the command name and its arguments", () => {
    expect(foldCommandMarkup("<command-message>openspec-explore</command-message>\n<command-name>/openspec-explore</command-name>\n<command-args>the user's actual text</command-args>"))
      .toBe("/openspec-explore the user's actual text");
  });

  test("tolerates the store's own tag order, indentation and empty arguments", () => {
    // Verbatim from a Claude Code transcript.
    expect(foldCommandMarkup("<command-name>/context</command-name>\n            <command-message>context</command-message>\n            <command-args></command-args>"))
      .toBe("/context");
    expect(foldCommandMarkup("<command-name>/clear</command-name>")).toBe("/clear");
  });

  test("keeps multi-line arguments and any text around the tags", () => {
    expect(foldCommandMarkup("<command-name>/plan</command-name>\n<command-args>first line\nsecond line</command-args>"))
      .toBe("/plan first line\nsecond line");
    expect(foldCommandMarkup("before\n<command-name>/x</command-name><command-args>y</command-args>\nafter"))
      .toBe("/x y\nbefore\nafter");
  });

  test("leaves text without a command-name tag unchanged", () => {
    expect(foldCommandMarkup("plain question")).toBe("plain question");
    expect(foldCommandMarkup("<command-message>orphan</command-message> only")).toBe("<command-message>orphan</command-message> only");
    expect(foldCommandMarkup("")).toBe("");
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

  test("a session opened with a slash command summarizes as the typed command", async () => {
    const { workspace, configDir, projectDir } = fixture();
    writeFileSync(path.join(projectDir, "slash.jsonl"),
      userLine("u1", "<command-message>openspec-explore</command-message>\n<command-name>/openspec-explore</command-name>\n<command-args>why is the build slow?</command-args>", "2026-08-22T10:00:00.000Z", { cwd: workspace }));

    const { sessions } = await listTranscriptSessions(workspace, configDir);
    expect(sessions[0]!.firstPrompt).toBe("/openspec-explore why is the build slow?");
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

  test("an oversized first line (an image prompt) does not hide the session", async () => {
    const { workspace, configDir, projectDir } = fixture();
    // The first line alone exceeds the summary head window, the way a
    // base64 image block does.
    const hugeImage = JSON.stringify({
      type: "user", uuid: "u1", parentUuid: null, isSidechain: false,
      timestamp: "2026-08-22T10:00:00.000Z", cwd: workspace,
      message: { role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(600 * 1024) } },
        { type: "text", text: "what is in this picture?" },
      ] },
    });
    writeFileSync(path.join(projectDir, "pictured.jsonl"), `${hugeImage}\n${userLine("u2", "follow-up", "2026-08-22T10:05:00.000Z", { cwd: workspace })}`);

    const { sessions, skippedFiles } = await listTranscriptSessions(workspace, configDir);
    expect(skippedFiles).toBe(0);
    expect(sessions.map(session => session.id)).toEqual(["pictured"]);
    expect(sessions[0]!.firstPrompt).toBe("what is in this picture?");
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

describe("transcript titles (D12)", () => {
  test("the last ai-title and custom-title entries are read wherever they sit, and cached per file version", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "uatu-transcript-titles-"));
    const file = path.join(root, "s.jsonl");
    writeFileSync(file, [
      JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, isSidechain: false, timestamp: "2026-09-02T10:00:00.000Z", cwd: root, message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "ai-title", aiTitle: "First title", sessionId: "s" }),
      JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", isSidechain: false, timestamp: "2026-09-02T10:00:01.000Z", cwd: root, message: { role: "assistant", content: [{ type: "text", text: "x".repeat(300_000) }] } }),
      JSON.stringify({ type: "ai-title", aiTitle: "  Second title  ", sessionId: "s" }),
    ].join("\n") + "\n");
    expect(await readTranscriptTitles(file)).toEqual({ generatedTitle: "Second title" });
    writeFileSync(file, `${JSON.stringify({ type: "custom-title", customTitle: "Mine", sessionId: "s" })}\n`, { flag: "a" });
    expect(await readTranscriptTitles(file)).toEqual({ generatedTitle: "Second title", customTitle: "Mine" });
    expect(await readTranscriptTitles(path.join(root, "missing.jsonl"))).toEqual({});
    // A title is what it says, suffix and all: the provider keeps the SDK's
    // fork bookkeeping out by naming the fork itself.
    writeFileSync(file, `${JSON.stringify({ type: "custom-title", customTitle: "Mine (fork)", sessionId: "s2" })}\n`, { flag: "a" });
    expect(await readTranscriptTitles(file)).toEqual({ generatedTitle: "Second title", customTitle: "Mine (fork)" });
    // A title past the first scan chunk, behind a line larger than the chunk
    // (an embedded image), is still found — and the scan never buffers the
    // file whole, so the cache key is the only thing that grows.
    const large = path.join(root, "large.jsonl");
    writeFileSync(large, [
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "x".repeat(300_000) } }),
      JSON.stringify({ type: "ai-title", aiTitle: "Past the chunk", sessionId: "large" }),
      JSON.stringify({ type: "custom-title", customTitle: "Split", sessionId: "large" }),
    ].join("\n") + "\n");
    expect(await readTranscriptTitles(large)).toEqual({ generatedTitle: "Past the chunk", customTitle: "Split" });
  });
});
