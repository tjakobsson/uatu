import { createHash } from "node:crypto";
import { promises as fs, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Read-only access to Claude Code's native session storage:
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` (D6). Enumeration and
 * turn-free history come from here; live turns and resume never do — they go
 * through the SDK, so a format change here degrades listings, not
 * conversations. Every line is shape-validated; anything unrecognized is
 * skipped and counted by type, never fatal.
 */

// The store caps the encoded directory name and disambiguates the remainder
// with a short hash. Interoperability constants of the storage layout, pinned
// by tests against directories the real CLI created.
const PROJECT_DIR_LENGTH_CAP = 200;

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
}

/** `/Users/x/repo` → `<configDir>/projects/-Users-x-repo`. */
export function claudeProjectDir(workspacePath: string, configDir: string = claudeConfigDir()): string {
  return path.join(configDir, "projects", encodeProjectPath(canonicalize(workspacePath)));
}

function canonicalize(input: string): string {
  let resolved = input;
  try {
    resolved = realpathSync.native(input);
  } catch {
    // A directory that cannot be resolved still encodes deterministically.
  }
  return process.platform === "darwin" ? resolved.normalize("NFC") : resolved;
}

function encodeProjectPath(input: string): string {
  const replaced = input.replace(/[^a-zA-Z0-9]/g, "-");
  if (replaced.length <= PROJECT_DIR_LENGTH_CAP) return replaced;
  return `${replaced.slice(0, PROJECT_DIR_LENGTH_CAP)}-${hashSuffix(input)}`;
}

function hashSuffix(input: string): string {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export type TranscriptEntry = {
  kind: "user" | "assistant";
  uuid: string;
  parentUuid: string | null;
  timestamp: number;
  isSidechain: boolean;
  // The Task tool_use that launched this sidechain entry, when recorded.
  parentToolUseId: string | null;
  cwd?: string;
  // The API-shaped message payload: { role, content } with content either a
  // string or an array of typed blocks. Interpreted by the normalizer, not here.
  message: Record<string, unknown>;
  // The store's own record of a tool's outcome, when present. A Task
  // completion carries the subagent linkage here: agentId, resolvedModel,
  // usage.
  toolUseResult?: Record<string, unknown>;
};

export type TranscriptReadResult = {
  entries: TranscriptEntry[];
  // Lines that carried nothing for the timeline, counted by their declared
  // type ("" for unparseable JSON). Honest bookkeeping, never payloads.
  skipped: Record<string, number>;
};

export async function readSessionTranscript(file: string): Promise<TranscriptReadResult> {
  const text = await fs.readFile(file, "utf8");
  const entries: TranscriptEntry[] = [];
  const skipped: Record<string, number> = {};
  const count = (type: string) => { skipped[type] = (skipped[type] ?? 0) + 1; };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      count("");
      continue;
    }
    const entry = validateEntry(value);
    if (entry) entries.push(entry);
    else count(typeof (value as { type?: unknown })?.type === "string" ? (value as { type: string }).type : "");
  }
  return { entries, skipped };
}

function validateEntry(value: unknown): TranscriptEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "user" && record.type !== "assistant") return null;
  if (typeof record.uuid !== "string" || !record.uuid) return null;
  const message = record.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  if (Number.isNaN(timestamp)) return null;
  return {
    kind: record.type,
    uuid: record.uuid,
    parentUuid: typeof record.parentUuid === "string" ? record.parentUuid : null,
    timestamp,
    isSidechain: record.isSidechain === true,
    parentToolUseId: typeof record.parent_tool_use_id === "string" ? record.parent_tool_use_id
      : typeof record.parentToolUseId === "string" ? record.parentToolUseId : null,
    ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
    message: message as Record<string, unknown>,
    ...(record.toolUseResult && typeof record.toolUseResult === "object" && !Array.isArray(record.toolUseResult)
      ? { toolUseResult: record.toolUseResult as Record<string, unknown> }
      : {}),
  };
}

/**
 * A subagent run's own transcript: the store keeps each run beside its
 * parent at `<projectDir>/<parentSessionId>/subagents/agent-<agentId>.jsonl`.
 */
export function subagentTranscriptPath(workspacePath: string, parentSessionId: string, agentId: string, configDir: string = claudeConfigDir()): string {
  if (!/^[A-Za-z0-9-]+$/.test(parentSessionId) || !/^[A-Za-z0-9-]+$/.test(agentId)) throw new Error("invalid session id");
  return path.join(claudeProjectDir(workspacePath, configDir), parentSessionId, "subagents", `agent-${agentId}.jsonl`);
}

export type TranscriptSessionSummary = {
  id: string;
  // The first user prompt's text, raw; the provider derives a display title.
  firstPrompt: string | null;
  createdAt: number;
  updatedAt: number;
};

export type TranscriptSessionList = {
  sessions: TranscriptSessionSummary[];
  // Files skipped whole: unreadable, empty of entries, or recorded under a
  // different working directory than this workspace.
  skippedFiles: number;
};

/**
 * Every resumable session recorded for `workspacePath`, newest first. The
 * project-directory encoding already scopes by path, but encoding collisions
 * and moved directories exist — the entries' own recorded `cwd` is the
 * confinement authority (spec: a foreign directory's session is not offered).
 */
// Enumeration reads only this much of each file: enough for the identity
// facts (first prompt, recorded cwd, creation time). A long-running session
// grows to tens of megabytes, and inventory listing runs often — a full
// parse per file per listing stalls the whole single-threaded server.
const SUMMARY_HEAD_BYTES = 256 * 1024;
// Two bounds, two failure modes. Parsed-line budget: a file yielding no
// mainline entry across this much COMPLETE-line content (sidechain-only,
// corrupt) is skipped without reading it whole. Single-record budget: one
// unbroken line may run to the largest admitted prompt (eight 10 MiB
// images as base64, plus text) — a legitimate image-first transcript must
// not be dropped at an arbitrary cap, and memory peaks at one such line
// only when the file actually contains one.
const SUMMARY_PARSED_LIMIT_BYTES = 32 * 1024 * 1024;
const SUMMARY_RECORD_LIMIT_BYTES = 128 * 1024 * 1024;

export async function listTranscriptSessions(workspacePath: string, configDir: string = claudeConfigDir()): Promise<TranscriptSessionList> {
  const directory = claudeProjectDir(workspacePath, configDir);
  const canonicalWorkspace = canonicalize(workspacePath);
  let names: string[];
  try {
    names = (await fs.readdir(directory)).filter(name => name.endsWith(".jsonl"));
  } catch {
    return { sessions: [], skippedFiles: 0 };
  }
  const sessions: TranscriptSessionSummary[] = [];
  let skippedFiles = 0;
  for (const name of names) {
    try {
      const file = path.join(directory, name);
      const info = await fs.stat(file);
      // The head can be defeated by a single oversized first line — an
      // image prompt's base64 easily exceeds it — and a session must not
      // vanish from the chooser for that. Grow the window until at least
      // one mainline entry parses (or the whole file has been read).
      // A bounded streaming scan: sequential chunks, only the trailing
      // partial line carried between them (as bytes, so multibyte
      // characters split across a boundary survive). It stops as soon as
      // the identity facts are in hand, and a file that yields no mainline
      // entry within the scan limit — sidechain-only, corrupt — is skipped
      // rather than read whole.
      let wholeFileRead = false;
      const mainline: TranscriptEntry[] = [];
      {
        const handle = await fs.open(file, "r");
        try {
          let residual = Buffer.alloc(0);
          let offset = 0;
          let parsedBytes = 0;
          let stopped = false;
          const identityComplete = () =>
            mainline.length > 0 && mainline.some(entry => entry.cwd)
            && mainline.some(entry => entry.kind === "user" && promptText(entry) !== null);
          while (
            offset < info.size && !stopped
            && (mainline.length > 0 || parsedBytes < SUMMARY_PARSED_LIMIT_BYTES)
            && residual.length < SUMMARY_RECORD_LIMIT_BYTES
          ) {
            const length = Math.min(SUMMARY_HEAD_BYTES, info.size - offset);
            const chunk = Buffer.alloc(length);
            await handle.read(chunk, 0, length, offset);
            offset += length;
            const atEnd = offset >= info.size;
            let combined = Buffer.concat([residual, chunk]);
            if (!atEnd) {
              const lastNewline = combined.lastIndexOf(0x0a);
              if (lastNewline < 0) { residual = combined; continue; }
              residual = combined.subarray(lastNewline + 1);
              combined = combined.subarray(0, lastNewline + 1);
            } else {
              residual = Buffer.alloc(0);
            }
            parsedBytes += combined.length;
            for (const line of combined.toString("utf8").split("\n")) {
              if (!line.trim()) continue;
              try {
                const entry = validateEntry(JSON.parse(line));
                if (entry && !entry.isSidechain) mainline.push(entry);
              } catch {
                // Unparseable lines contribute nothing to a summary.
              }
            }
            if (atEnd) wholeFileRead = true;
            // The first chunk parses in full so a small file keeps its
            // deterministic timestamps; beyond it, stop once the identity
            // facts are known.
            else if (identityComplete()) stopped = true;
          }
        } finally {
          await handle.close();
        }
      }
      if (mainline.length === 0) {
        skippedFiles += 1;
        continue;
      }
      // The entries' recorded cwd is the confinement authority; the
      // directory encoding is collision-prone ("/tmp/a-b" and "/tmp/a/b"
      // encode alike), so a transcript that records no directory at all is
      // unverifiable and is not offered.
      const recordedCwd = mainline.find(entry => entry.cwd)?.cwd;
      if (!recordedCwd || canonicalize(recordedCwd) !== canonicalWorkspace) {
        skippedFiles += 1;
        continue;
      }
      const firstUser = mainline.find(entry => entry.kind === "user" && promptText(entry) !== null);
      sessions.push({
        id: path.basename(name, ".jsonl"),
        firstPrompt: firstUser ? promptText(firstUser) : null,
        createdAt: mainline[0]!.timestamp,
        // Deterministic from entries when the head covered the whole file;
        // a file too large for that uses its mtime — recency is what the
        // ordering needs, and reading the tail would defeat the bound.
        updatedAt: wholeFileRead ? mainline[mainline.length - 1]!.timestamp : Math.round(info.mtimeMs),
      });
    } catch {
      skippedFiles += 1;
    }
  }
  sessions.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  return { sessions, skippedFiles };
}

/** The user-typed text of an entry, or null for tool results and non-text. */
export function promptText(entry: TranscriptEntry): string | null {
  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const blocks = content.filter((block): block is { type: string; text?: unknown } =>
    Boolean(block) && typeof block === "object");
  if (blocks.some(block => block.type === "tool_result")) return null;
  const text = blocks
    .filter(block => block.type === "text" && typeof block.text === "string")
    .map(block => block.text as string)
    .join("\n");
  return text.length > 0 ? text : null;
}

/** Stable per-file identity for a session id, mirroring the store layout. */
export function sessionTranscriptPath(workspacePath: string, sessionId: string, configDir: string = claudeConfigDir()): string {
  // Session ids come from the SDK (uuids); reject anything path-shaped so a
  // hostile id can never escape the project directory.
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) throw new Error("invalid session id");
  return path.join(claudeProjectDir(workspacePath, configDir), `${sessionId}.jsonl`);
}

/** Deterministic short digest used by tests to name fixture sessions. */
export function fixtureSessionId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}
