/**
 * Spike (claude-scheduled-wakeups, revival follow-up): session-only
 * `CronCreate` crons come back when their session is resumed — the CLI
 * rebuilds them from the transcript. Before the design leans on that, this
 * observes, against a real `claude`:
 *   S1 block:    a revived cron whose fire the UserPromptSubmit hook blocks —
 *                does the block make a model call, what does the stream and
 *                the transcript show, and does the cron keep re-firing?
 *   S2 delete:   two crons, one removed with CronDelete, then resume — does
 *                only the survivor come back?
 *   S3 one-shot: a non-recurring CronCreate, resumed before its fire time —
 *                does it come back and fire?
 *   S4 missed:   a non-recurring CronCreate whose fire time passes while no
 *                process runs, then resumed — does it fire late, stay, or go?
 *
 * `--only S4` runs one scenario (S1…S4); the default runs S1–S3.
 *
 * Run: SPIKE_CLAUDE_EXECUTABLE=$(which claude) bun run scripts/spike-claude-cron-revival.ts [--out /tmp/cron-revival]
 * Manual tool: spends real tokens and several minutes of wall clock.
 */
import { globSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const outDir = path.resolve(process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1]! : "/tmp/cron-revival");
const executable = process.env.SPIKE_CLAUDE_EXECUTABLE;
const started = Date.now();
const at = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`;
const log: Array<{ at: string; session: string; event: string; detail?: unknown }> = [];
function note(session: string, event: string, detail?: unknown) {
  log.push({ at: at(), session, event, ...(detail === undefined ? {} : { detail }) });
  console.log(at(), session, event, detail === undefined ? "" : JSON.stringify(detail).slice(0, 240));
}

class Queue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;
  push(item: SDKUserMessage) { const waiter = this.waiters.shift(); if (waiter) waiter({ value: item, done: false }); else this.items.push(item); }
  close() { this.closed = true; for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true }); }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return { next: () => {
      const item = this.items.shift();
      if (item) return Promise.resolve({ value: item, done: false });
      if (this.closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise(resolve => this.waiters.push(resolve));
    } };
  }
}
const user = (text: string): SDKUserMessage => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: "" });

function open(label: string, cwd: string, options: { resume?: string; block?: (prompt: string) => boolean } = {}) {
  const queue = new Queue();
  const q = query({
    prompt: queue,
    options: {
      cwd,
      ...(options.resume ? { resume: options.resume } : {}),
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      permissionMode: "default",
      canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
      hooks: {
        Stop: [{ hooks: [async input => { note(label, "hook:Stop", { session_crons: (input as { session_crons?: unknown }).session_crons }); return { continue: true }; }] }],
        UserPromptSubmit: [{ hooks: [async input => {
          const prompt = String((input as { prompt?: unknown }).prompt);
          const blocked = options.block?.(prompt) ?? false;
          note(label, "hook:UserPromptSubmit", { prompt: prompt.slice(0, 80), blocked });
          return blocked ? { decision: "block" as const, reason: "Released in uatu: this schedule no longer fires." } : { continue: true };
        }] }],
      },
    },
  });
  const messages: Array<{ at: string; type: string; subtype?: string; text?: string; cost?: unknown }> = [];
  let sessionId = options.resume ?? "";
  const results: Array<() => void> = [];
  let resultCount = 0;
  const reader = (async () => {
    for await (const message of q) {
      const record = message as Record<string, unknown>;
      if (record.type === "system" && record.subtype === "init") sessionId = String(record.session_id);
      if (record.type === "rate_limit_event" || record.type === "stream_event") continue;
      const text = record.type === "assistant"
        ? ((record.message as { content: Array<{ type: string; text?: string; name?: string; input?: unknown }> }).content.map(block => block.text ?? (block.type === "tool_use" ? `${block.name} ${JSON.stringify(block.input)}` : block.type)).join(" | "))
        : undefined;
      const entry = { at: at(), type: String(record.type), ...(typeof record.subtype === "string" ? { subtype: record.subtype } : {}), ...(text ? { text } : {}), ...(record.type === "result" ? { cost: record.total_cost_usd } : {}) };
      messages.push(entry);
      note(label, `msg:${entry.type}${entry.subtype ? `/${entry.subtype}` : ""}`, text ?? (record.type === "result" ? { cost: record.total_cost_usd } : undefined));
      if (record.type === "result") { resultCount += 1; for (const resolve of results.splice(0)) resolve(); }
    }
  })();
  return {
    queue, q, messages, reader,
    get sessionId() { return sessionId; },
    get results() { return resultCount; },
    nextResult: () => new Promise<void>(resolve => results.push(resolve)),
    async close() { queue.close(); await q.return?.(undefined).catch(() => undefined); await reader.catch(() => undefined); },
  };
}

async function transcript(sessionId: string): Promise<Array<Record<string, unknown>>> {
  const file = globSync(path.join(process.env.HOME ?? "", ".claude", "projects", "*", `${sessionId}.jsonl`))[0];
  if (!file) return [];
  return (await readFile(file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const clip = (records: Array<Record<string, unknown>>) => records
  .filter(record => record.type !== "attachment")
  .map(record => ({ type: record.type, isMeta: record.isMeta, turnOrigin: record.turnOrigin, promptSource: record.promptSource, subtype: record.subtype,
    content: JSON.stringify((record.message as { content?: unknown } | undefined)?.content ?? record.content ?? record.operation ?? "").slice(0, 160) }));

const findings: Record<string, unknown> = {};

async function s1Block() {
  const cwd = await mkdtemp(path.join(tmpdir(), "uatu-revival-block-"));
  const prompt = "BLOCK-ME reply with exactly the word ping";
  const create = open("S1", cwd);
  create.queue.push(user(`Use the CronCreate tool with cron "* * * * *", recurring true, and prompt "${prompt}". Then stop.`));
  await create.nextResult();
  const id = create.sessionId;
  await create.close();
  const before = (await transcript(id)).length;
  note("S1", "closed; resuming with the fire blocked", { transcriptLines: before });
  const resumed = open("S1-resume", cwd, { resume: id, block: text => text === prompt });
  await sleep(150_000);
  await resumed.close();
  const after = await transcript(id);
  findings.s1 = { messagesDuringBlockedResume: resumed.messages, appendedTranscript: clip(after.slice(before)) };
}

async function s2Delete() {
  const cwd = await mkdtemp(path.join(tmpdir(), "uatu-revival-delete-"));
  const session = open("S2", cwd);
  session.queue.push(user('Use the CronCreate tool twice: once with cron "* * * * *", recurring true, prompt "KEEP reply with exactly the word keep"; once with cron "* * * * *", recurring true, prompt "DROP reply with exactly the word drop". Then stop.'));
  await session.nextResult();
  session.queue.push(user('Use CronDelete to delete the job whose prompt starts with "DROP". Do nothing else, then stop.'));
  await session.nextResult();
  const id = session.sessionId;
  await session.close();
  note("S2", "closed; resuming idle");
  const resumed = open("S2-resume", cwd, { resume: id });
  await sleep(80_000);
  await resumed.close();
  findings.s2 = { messages: resumed.messages };
}

async function s3OneShot() {
  const cwd = await mkdtemp(path.join(tmpdir(), "uatu-revival-oneshot-"));
  const fire = new Date(Date.now() + 150_000);
  const cron = `${fire.getMinutes()} ${fire.getHours()} ${fire.getDate()} ${fire.getMonth() + 1} *`;
  const session = open("S3", cwd);
  session.queue.push(user(`Use the CronCreate tool with cron "${cron}", recurring false, and prompt "ONCE reply with exactly the word once". Then stop.`));
  await session.nextResult();
  const id = session.sessionId;
  await session.close();
  note("S3", "closed; resuming idle before the fire time", { cron });
  const resumed = open("S3-resume", cwd, { resume: id });
  await sleep(200_000);
  await resumed.close();
  findings.s3 = { cron, messages: resumed.messages };
}

async function s4Missed() {
  const cwd = await mkdtemp(path.join(tmpdir(), "uatu-revival-missed-"));
  const fire = new Date(Date.now() + 90_000);
  const cron = `${fire.getMinutes()} ${fire.getHours()} ${fire.getDate()} ${fire.getMonth() + 1} *`;
  const session = open("S4", cwd);
  session.queue.push(user(`Use the CronCreate tool with cron "${cron}", recurring false, and prompt "MISSED reply with exactly the word late". Then stop.`));
  await session.nextResult();
  const id = session.sessionId;
  await session.close();
  note("S4", "closed; waiting past the fire time with no process", { cron });
  await sleep(Math.max(0, fire.getTime() - Date.now()) + 90_000);
  note("S4", "resuming idle after the fire time");
  const resumed = open("S4-resume", cwd, { resume: id });
  await sleep(90_000);
  // A prompt of our own: its Stop reports whatever crons the session holds.
  resumed.queue.push(user('Reply with exactly "ok".'));
  await resumed.nextResult();
  await resumed.close();
  findings.s4 = { cron, messages: resumed.messages };
}

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
const scenarios: Record<string, () => Promise<void>> = { S1: s1Block, S2: s2Delete, S3: s3OneShot, S4: s4Missed };

try {
  await Promise.all(only ? [scenarios[only]!()] : [s1Block(), s2Delete(), s3OneShot()]);
} finally {
  await mkdir(outDir, { recursive: true });
  const sdk = JSON.parse(await readFile("node_modules/@anthropic-ai/claude-agent-sdk/package.json", "utf8")).version;
  await writeFile(path.join(outDir, "cron-revival.json"), `${JSON.stringify({ sdk, recordedAt: new Date().toISOString(), findings, log }, null, 2)}\n`);
  console.log(`wrote ${path.join(outDir, "cron-revival.json")}`);
}
