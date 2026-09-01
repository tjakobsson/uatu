/**
 * Spike (task 1.1 of add-claude-code-agent): prove the Claude Agent SDK
 * works under Bun against a real local `claude`, including the rewind
 * surface the reversible-history capability depends on, and record the
 * observed message shapes as fixtures for the provider's unit tests.
 *
 * Run: bun run scripts/spike-claude-sdk.ts [--out tests/fixtures/claude-sdk]
 *
 * The script is a manual tool, not part of any suite: it spends real
 * tokens and requires an authenticated `claude` on PATH. It:
 *   1. runs a minimal prompt turn in a temp directory and streams messages;
 *   2. runs a second turn that edits a file (so a checkpoint exists);
 *   3. resumes the session and rewinds files to the first user message;
 *   4. forks the session up to that message (conversation rewind);
 *   5. writes every observed SDK message, redacted, to the fixture dir.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { forkSession, query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const outDir = path.resolve(process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]!
  : "tests/fixtures/claude-sdk");

// Fixtures must not leak the machine they were recorded on.
function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replaceAll(process.env.HOME ?? "/nonexistent", "~")
      // Replace the temp workdir prefix but keep the path inside it, so a
      // fixture still shows which file a tool touched.
      .replaceAll(/\/(?:private\/)?var\/folders\/[^\s"']*?uatu-claude-spike-[^\s"'/]+/g, "/tmp/spike-workdir");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
  }
  return value;
}

function userMessage(text: string, sessionId: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

async function runTurn(options: {
  cwd: string;
  prompt: string;
  resume?: string;
  record: (label: string, message: SDKMessage) => void;
  label: string;
}): Promise<{ sessionId: string; firstUserMessageId: string | null; queryHandle: ReturnType<typeof query> }> {
  const q = query({
    prompt: (async function* () {
      yield userMessage(options.prompt, options.resume ?? "");
    })(),
    options: {
      cwd: options.cwd,
      resume: options.resume,
      permissionMode: "acceptEdits",
      allowedTools: ["Write", "Read", "Edit"],
      enableFileCheckpointing: true,
      maxTurns: 6,
      // The compiled single-file binary cannot carry the SDK's vendored
      // per-platform `claude` sidecar, so the provider will always point the
      // SDK at the user's own install; the spike proves that configuration.
      ...(process.env.SPIKE_CLAUDE_EXECUTABLE ? { pathToClaudeCodeExecutable: process.env.SPIKE_CLAUDE_EXECUTABLE } : {}),
    },
  });
  let sessionId = options.resume ?? "";
  let firstUserMessageId: string | null = null;
  for await (const message of q) {
    options.record(options.label, message);
    if (message.type === "system" && message.subtype === "init") sessionId = message.session_id;
    if (message.type === "user" && firstUserMessageId === null) {
      firstUserMessageId = (message as { uuid?: string }).uuid ?? null;
    }
    if (message.type === "result") break;
  }
  return { sessionId, firstUserMessageId, queryHandle: q };
}

const workdir = await mkdtemp(path.join(tmpdir(), "uatu-claude-spike-"));
const recorded: Array<{ label: string; message: unknown }> = [];
const record = (label: string, message: SDKMessage) => {
  recorded.push({ label, message: redact(message) });
  console.log(`[${label}] ${message.type}${"subtype" in message ? `/${(message as { subtype?: string }).subtype}` : ""}`);
};

try {
  // 1. Minimal prompt round trip.
  const first = await runTurn({
    cwd: workdir,
    prompt: 'Reply with exactly the word "pong" and nothing else. Do not use any tools.',
    record,
    label: "turn-1-prompt",
  });
  console.log(`turn 1 done, session ${first.sessionId}`);

  // 2. A file-editing turn so a checkpoint exists to rewind.
  const second = await runTurn({
    cwd: workdir,
    prompt: 'Immediately use the Write tool to create marker.txt in the current directory containing exactly "one". Do not run any other tool first, then stop.',
    resume: first.sessionId,
    record,
    label: "turn-2-edit",
  });
  const markerAfterEdit = await readFile(path.join(workdir, "marker.txt"), "utf8").catch(() => null);
  console.log(`turn 2 done, marker.txt=${JSON.stringify(markerAfterEdit)}`);
  if (markerAfterEdit === null) throw new Error("edit turn did not produce marker.txt; cannot exercise rewind");

  // 3. File rewind to before the edit, via a resumed query. Checkpoints are
  // keyed to prompt user-message uuids as recorded in the native transcript,
  // so read them from there (which also proves the D6 enumeration path).
  const { globSync } = await import("node:fs");
  const transcriptPath = globSync(path.join(process.env.HOME ?? "", ".claude", "projects", "*", `${second.sessionId}.jsonl`))[0];
  if (!transcriptPath) throw new Error(`no native transcript found for session ${second.sessionId}`);
  const promptUuids = (await readFile(transcriptPath, "utf8")).split("\n").filter(Boolean).flatMap(line => {
    try {
      const entry = JSON.parse(line) as { type?: string; uuid?: string; isSidechain?: boolean; message?: { content?: unknown } };
      const content = entry.message?.content;
      const isToolResult = Array.isArray(content) && content.some(block => (block as { type?: string }).type === "tool_result");
      return entry.type === "user" && !entry.isSidechain && !isToolResult && entry.uuid ? [entry.uuid] : [];
    } catch { return []; }
  });
  recorded.push({ label: "transcript-prompt-uuids", message: { transcript: "found", promptUuids: promptUuids.length } });
  console.log(`transcript at ${transcriptPath.replace(process.env.HOME ?? "", "~")}, ${promptUuids.length} prompt uuids`);
  if (!second.firstUserMessageId) throw new Error("no user message id observed on the edit turn");
  const resumed = query({
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      // Stream stays open; we only need the control channel.
      await new Promise(() => {});
    })(),
    options: {
      cwd: workdir,
      resume: second.sessionId,
      permissionMode: "acceptEdits",
      enableFileCheckpointing: true,
      maxTurns: 1,
      ...(process.env.SPIKE_CLAUDE_EXECUTABLE ? { pathToClaudeCodeExecutable: process.env.SPIKE_CLAUDE_EXECUTABLE } : {}),
    },
  });
  // Try newest prompt first, older ones as fallback — the reference
  // implementation does the same candidate walk.
  let rewindResult: { canRewind: boolean; error?: string } = { canRewind: false };
  let boundaryUuid: string | null = null;
  for (const candidate of [...promptUuids].reverse()) {
    rewindResult = await resumed.rewindFiles(candidate, { dryRun: false }).catch(error => ({ canRewind: false, error: String(error) }));
    if (rewindResult.canRewind) { boundaryUuid = candidate; break; }
    recorded.push({ label: "rewind-files-miss", message: redact({ candidate, ...rewindResult }) });
  }
  recorded.push({ label: "rewind-files-result", message: redact({ boundaryUuid, ...rewindResult }) });
  console.log(`rewindFiles canRewind=${rewindResult.canRewind} boundary=${boundaryUuid}`);
  await resumed.interrupt().catch(() => undefined);
  const markerAfterRewind = await readFile(path.join(workdir, "marker.txt"), "utf8").catch(() => null);
  console.log(`after rewind, marker.txt=${JSON.stringify(markerAfterRewind)}`);
  if (!boundaryUuid) throw new Error(`no prompt uuid had a checkpoint: ${rewindResult.error ?? "unknown"}`);

  // 4. Conversation rewind: fork the session up to the same boundary.
  const fork = await forkSession(second.sessionId, { upToMessageId: boundaryUuid });
  recorded.push({ label: "fork-session-result", message: redact(fork) });
  console.log(`forked session ${fork.sessionId}`);

  console.log(`SPIKE OK: prompt=${markerAfterEdit !== null} fileRewind=${rewindResult.canRewind && markerAfterRewind === null} fork=${Boolean(fork.sessionId)}`);
  // Close the control-channel query deterministically: its input generator
  // never ends, and an open query keeps the child process and event loop
  // alive forever (observed: the first successful run never exited).
  await resumed.return(undefined).catch(() => undefined);
} finally {
  // Persist fixtures even on failure — a failed run's messages are the evidence.
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, "spike-messages.json"),
    `${JSON.stringify({ sdk: "@anthropic-ai/claude-agent-sdk@0.3.252", recordedAt: new Date().toISOString(), entries: recorded }, null, 2)}\n`,
  );
  console.log(`wrote ${recorded.length} entries to ${path.join(outDir, "spike-messages.json")}`);
  await rm(workdir, { recursive: true, force: true });
}
