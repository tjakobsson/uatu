/**
 * Spike (task 1.1 of claude-scheduled-wakeups): observe how the Claude Agent
 * SDK reports session crons (ScheduleWakeup / CronCreate / /loop) and how a
 * fired wakeup reaches an SDK host, before the provider depends on it.
 *
 * Run: bun run scripts/spike-claude-wakeups.ts [--tool ScheduleWakeup|CronCreate] [--out tests/fixtures/claude-sdk]
 *
 * Manual tool, not part of any suite: it spends real tokens, needs an
 * authenticated `claude` on PATH, and waits several minutes of wall clock.
 * It records:
 *   A. fire: a session that schedules a ~60 s wakeup and stays open — the
 *      Stop hook's `session_crons`, its order relative to `result`, the fired
 *      turn's UserPromptSubmit `source`, the fired turn's SDK messages, and
 *      the native transcript lines the fired turn wrote;
 *   With `--tool CronCreate` the scheduled task is recurring (every minute),
 *   so phase A also shows what the Stop hook reports after a recurring fire.
 *   B. kill: a session that schedules a wakeup and is closed before the fire
 *      — whether anything fires afterwards (transcript growth after the fire
 *      time).
 */
import { globSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { query, type HookCallbackMatcher, type HookEvent, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const arg = (name: string, fallback: string) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback;
const outDir = path.resolve(arg("--out", "tests/fixtures/claude-sdk"));
const tool = arg("--tool", "ScheduleWakeup");
const FIRE_WAIT_MS = Number(arg("--fire-wait", "240")) * 1000;

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replaceAll(process.env.HOME ?? "/nonexistent", "~")
      .replaceAll(/\/(?:private\/)?var\/folders\/[^\s"']*?uatu-claude-wakeup-spike-[^\s"'/]+/g, "/tmp/spike-workdir")
      .replaceAll(/-private-var-folders-[^\s"'/]*?uatu-claude-wakeup-spike-[^\s"'/]+/g, "-tmp-spike-workdir");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
  }
  return value;
}

class Queue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;
  push(item: SDKUserMessage) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false }); else this.items.push(item);
  }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
      },
    };
  }
}

const started = Date.now();
const stamp = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`;
const recorded: Array<{ phase: string; at: string; kind: string; payload: unknown }> = [];
function log(phase: string, kind: string, payload: unknown, line?: string) {
  recorded.push({ phase, at: stamp(), kind, payload: redact(payload) });
  console.log(`${stamp()} [${phase}] ${kind}${line ? ` ${line}` : ""}`);
}

function hooksFor(phase: string): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const observe = (event: string) => ({
    hooks: [async (input: unknown) => {
      const record = input as Record<string, unknown>;
      const summary = event === "Stop"
        ? `session_crons=${JSON.stringify(record.session_crons)} background=${JSON.stringify(record.background_tasks)}`
        : event === "UserPromptSubmit" ? `source=${JSON.stringify(record.source)} prompt=${JSON.stringify(String(record.prompt).slice(0, 80))}` : "";
      log(phase, `hook:${event}`, input, summary);
      return { continue: true };
    }],
  });
  return {
    Stop: [observe("Stop")],
    UserPromptSubmit: [observe("UserPromptSubmit")],
    SessionEnd: [observe("SessionEnd")],
  };
}

function describe(message: SDKMessage): string {
  const subtype = "subtype" in message ? `/${(message as { subtype?: string }).subtype}` : "";
  if (message.type === "assistant") {
    const blocks = (message.message.content as Array<{ type: string; name?: string; text?: string; input?: unknown }>)
      .map(block => block.type === "tool_use" ? `tool_use:${block.name} ${JSON.stringify(block.input)}` : block.type === "text" ? `text:${JSON.stringify(block.text?.slice(0, 80))}` : block.type);
    return `assistant ${blocks.join(" | ")}`;
  }
  if (message.type === "user") {
    const content = message.message.content;
    const text = typeof content === "string" ? content : (content as Array<{ type: string; text?: string; content?: unknown }>).map(block => block.type === "text" ? JSON.stringify(block.text?.slice(0, 80)) : block.type).join(" | ");
    const extras = Object.keys(message).filter(key => !["type", "message", "parent_tool_use_id", "session_id", "uuid"].includes(key));
    return `user ${text} extras=${JSON.stringify(extras)}`;
  }
  return `${message.type}${subtype}`;
}

function userMessage(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: "" };
}

const schedulePrompt = tool === "CronCreate"
  ? "Use the CronCreate tool to schedule a recurring task with the cron expression \"* * * * *\" (every minute) and the prompt: CRON-FIRED reply with exactly the word ping. Then stop and do nothing else."
  : "Use the ScheduleWakeup tool with delaySeconds 60, reason \"spike\", and prompt \"WAKEUP-FIRED reply with exactly the word pong\". Then stop and do nothing else.";

function open(phase: string, cwd: string) {
  const queue = new Queue();
  const q = query({
    prompt: queue,
    options: {
      cwd,
      permissionMode: "default",
      canUseTool: async (name, input) => {
        log(phase, "canUseTool", { name, input }, name);
        return { behavior: "allow", updatedInput: input };
      },
      hooks: hooksFor(phase),
      ...(process.env.SPIKE_CLAUDE_EXECUTABLE ? { pathToClaudeCodeExecutable: process.env.SPIKE_CLAUDE_EXECUTABLE } : {}),
    },
  });
  return { queue, q };
}

async function transcriptLines(sessionId: string): Promise<unknown[]> {
  const file = globSync(path.join(process.env.HOME ?? "", ".claude", "projects", "*", `${sessionId}.jsonl`))[0];
  if (!file) return [];
  return (await readFile(file, "utf8")).split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return line; } });
}

const workdir = await mkdtemp(path.join(tmpdir(), "uatu-claude-wakeup-spike-"));
const findings: Record<string, unknown> = { tool };
try {
  // ---- A. fire -----------------------------------------------------------
  {
    const { queue, q } = open("fire", workdir);
    queue.push(userMessage(schedulePrompt));
    let sessionId = "";
    let results = 0;
    let init: unknown = null;
    const deadline = { at: Number.POSITIVE_INFINITY };
    const reader = (async () => {
      for await (const message of q) {
        log("fire", `msg:${message.type}${"subtype" in message ? `/${(message as { subtype?: string }).subtype}` : ""}`, message, describe(message));
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
          init ??= { tools: (message as { tools?: string[] }).tools?.filter(name => /cron|wake|loop|schedule/i.test(name)) };
        }
        if (message.type === "result") {
          results += 1;
          if (results === 1) deadline.at = Date.now() + FIRE_WAIT_MS;
          if (results >= 2) break;
        }
      }
    })();
    while (results < 2 && Date.now() < deadline.at) {
      await Promise.race([reader, new Promise(resolve => setTimeout(resolve, 1000))]);
      if (results === 0 && Date.now() - started > 180_000) break;
    }
    findings.fireInitTools = init;
    findings.fireResults = results;
    findings.fireSessionId = sessionId;
    queue.close();
    await q.return(undefined).catch(() => undefined);
    await reader.catch(() => undefined);
    const lines = await transcriptLines(sessionId);
    log("fire", "transcript", lines, `${lines.length} lines`);
  }

  // ---- B. kill -----------------------------------------------------------
  {
    const { queue, q } = open("kill", workdir);
    queue.push(userMessage(schedulePrompt));
    let sessionId = "";
    for await (const message of q) {
      log("kill", `msg:${message.type}${"subtype" in message ? `/${(message as { subtype?: string }).subtype}` : ""}`, message, describe(message));
      if (message.type === "system" && message.subtype === "init") sessionId = message.session_id;
      if (message.type === "result") break;
    }
    queue.close();
    await q.return(undefined).catch(() => undefined);
    const before = (await transcriptLines(sessionId)).length;
    log("kill", "closed", { before }, `transcript lines at close: ${before}; waiting past the fire time`);
    await new Promise(resolve => setTimeout(resolve, 130_000));
    const after = (await transcriptLines(sessionId)).length;
    findings.killTranscriptLines = { before, after };
    log("kill", "after-fire-time", { before, after }, `transcript lines: ${before} -> ${after}`);
  }
} finally {
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `spike-wakeups-${tool}.json`);
  const sdk = JSON.parse(await readFile("node_modules/@anthropic-ai/claude-agent-sdk/package.json", "utf8")).version;
  await writeFile(file, `${JSON.stringify({ sdk: `@anthropic-ai/claude-agent-sdk@${sdk}`, recordedAt: new Date().toISOString(), findings: redact(findings), entries: recorded }, null, 2)}\n`);
  console.log(`wrote ${recorded.length} entries to ${file}`);
  console.log(JSON.stringify(redact(findings), null, 2));
  await rm(workdir, { recursive: true, force: true });
}
