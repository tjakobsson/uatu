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
  // `system` is admitted for one subtype only: the compaction boundary,
  // which the timeline marks (spec: the timeline marks where compaction
  // happened) and the readout resets on, live and on reload alike.
  kind: "user" | "assistant" | "system";
  uuid: string;
  parentUuid: string | null;
  timestamp: number;
  isSidechain: boolean;
  // The Task tool_use that launched this sidechain entry, when recorded.
  parentToolUseId: string | null;
  cwd?: string;
  // The API-shaped message payload: { role, content } with content either a
  // string or an array of typed blocks. Interpreted by the normalizer, not
  // here. Empty for a system record, which carries no message.
  message: Record<string, unknown>;
  // A system record's subtype and, for a compaction boundary, the store's
  // own figures (camelCase on disk, unlike the live message's snake_case).
  subtype?: string;
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number };
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
  const compaction = record.type === "system" && record.subtype === "compact_boundary";
  if (record.type !== "user" && record.type !== "assistant" && !compaction) return null;
  if (typeof record.uuid !== "string" || !record.uuid) return null;
  const message = compaction ? (record.message ?? {}) : record.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  if (Number.isNaN(timestamp)) return null;
  const metadata = compaction && record.compactMetadata && typeof record.compactMetadata === "object" && !Array.isArray(record.compactMetadata)
    ? record.compactMetadata as Record<string, unknown> : undefined;
  return {
    kind: record.type as "user" | "assistant" | "system",
    ...(compaction ? {
      subtype: "compact_boundary",
      compactMetadata: {
        ...(typeof metadata?.trigger === "string" ? { trigger: metadata.trigger } : {}),
        ...(typeof metadata?.preTokens === "number" ? { preTokens: metadata.preTokens } : {}),
        ...(typeof metadata?.postTokens === "number" ? { postTokens: metadata.postTokens } : {}),
      },
    } : {}),
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
  // The title Claude Code itself assigned (the last `ai-title` entry), and
  // the one a user set (the last `custom-title` entry); the provider ranks
  // custom over generated over prompt-derived (D12).
  generatedTitle?: string;
  customTitle?: string;
};

export type TranscriptTitles = { generatedTitle?: string; customTitle?: string };

// Title entries land wherever the CLI appended them — after the first turn
// for `ai-title`, at rename time for `custom-title` — so neither the head
// nor the tail alone can be trusted to hold them. The whole file is scanned
// for the two markers (a byte search, parsing only the lines that carry
// one), and the answer is cached by size and mtime so a listing pays the
// scan once per change, not once per read.
const TITLE_MARKERS: Array<[Buffer, "generatedTitle" | "customTitle", string]> = [
  [Buffer.from('"type":"ai-title"'), "generatedTitle", "aiTitle"],
  [Buffer.from('"type":"custom-title"'), "customTitle", "customTitle"],
];
const TITLE_SCAN_CHUNK = 1 << 16;
const titleCache = new Map<string, { size: number; mtimeMs: number; titles: TranscriptTitles }>();

/** The last title each marker names within `bytes` (whole lines only), written over `titles`. */
function scanTitleLines(bytes: Buffer, titles: TranscriptTitles): void {
  for (const [marker, key, field] of TITLE_MARKERS) {
    let from = 0;
    while (from < bytes.length) {
      const at = bytes.indexOf(marker, from);
      if (at < 0) break;
      const lineStart = bytes.lastIndexOf(0x0a, at) + 1;
      let lineEnd = bytes.indexOf(0x0a, at);
      if (lineEnd < 0) lineEnd = bytes.length;
      try {
        const record = JSON.parse(bytes.subarray(lineStart, lineEnd).toString("utf8")) as Record<string, unknown>;
        const value = typeof record[field] === "string" ? (record[field] as string).trim() : "";
        if (value) titles[key] = value;
      } catch {
        // A line that only looks like a title entry contributes nothing.
      }
      from = lineEnd + 1;
    }
  }
}
const TITLE_CACHE_LIMIT = 4_096;

/** The session's own titles from its transcript, cached per file version. */
export async function readTranscriptTitles(file: string): Promise<TranscriptTitles> {
  let info;
  try {
    info = await fs.stat(file);
  } catch {
    return {};
  }
  const cached = titleCache.get(file);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.titles;
  const titles: TranscriptTitles = {};
  try {
    // Chunked, never the whole file: a listing scans every candidate
    // transcript, and one can run to hundreds of megabytes. Complete lines
    // are searched as each chunk lands; the trailing partial line carries
    // over, so a marker split across chunks is still seen whole.
    const handle = await fs.open(file, "r");
    try {
      const chunk = Buffer.allocUnsafe(TITLE_SCAN_CHUNK);
      let carry: Buffer = Buffer.alloc(0);
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        const eof = bytesRead === 0;
        const buffer = eof ? carry : carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        const complete = eof ? buffer.length : buffer.lastIndexOf(0x0a) + 1;
        scanTitleLines(buffer.subarray(0, complete), titles);
        if (eof) break;
        carry = Buffer.from(buffer.subarray(complete));
      }
    } finally {
      await handle.close();
    }
  } catch {
    return {};
  }
  if (titleCache.size >= TITLE_CACHE_LIMIT) titleCache.clear();
  titleCache.set(file, { size: info.size, mtimeMs: info.mtimeMs, titles });
  return titles;
}

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
          let residualParts: Buffer[] = [];
          let residualBytes = 0;
          let offset = 0;
          let parsedBytes = 0;
          let stopped = false;
          const identityComplete = () =>
            mainline.length > 0 && mainline.some(entry => entry.cwd)
            && mainline.some(entry => entry.kind === "user" && promptText(entry) !== null);
          while (
            offset < info.size && !stopped
            && parsedBytes < SUMMARY_PARSED_LIMIT_BYTES
            && residualBytes < SUMMARY_RECORD_LIMIT_BYTES
          ) {
            const length = Math.min(SUMMARY_HEAD_BYTES, info.size - offset);
            const chunk = Buffer.alloc(length);
            await handle.read(chunk, 0, length, offset);
            offset += length;
            const atEnd = offset >= info.size;
            // A record spanning many chunks accumulates without recopying:
            // the concat happens once, when a delimiter finally arrives.
            if (!atEnd && chunk.indexOf(0x0a) < 0) {
              residualParts.push(chunk);
              residualBytes += chunk.length;
              continue;
            }
            let combined = Buffer.concat([...residualParts, chunk]);
            residualParts = [];
            residualBytes = 0;
            if (!atEnd) {
              const lastNewline = combined.lastIndexOf(0x0a);
              residualParts = [combined.subarray(lastNewline + 1)];
              residualBytes = residualParts[0]!.length;
              combined = combined.subarray(0, lastNewline + 1);
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
      const titles = await readTranscriptTitles(file);
      sessions.push({
        id: path.basename(name, ".jsonl"),
        firstPrompt: firstUser ? promptText(firstUser) : null,
        ...(titles.generatedTitle === undefined ? {} : { generatedTitle: titles.generatedTitle }),
        ...(titles.customTitle === undefined ? {} : { customTitle: titles.customTitle }),
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
  if (typeof content === "string") return foldCommandMarkup(content);
  if (!Array.isArray(content)) return null;
  const blocks = content.filter((block): block is { type: string; text?: unknown } =>
    Boolean(block) && typeof block === "object");
  if (blocks.some(block => block.type === "tool_result")) return null;
  const text = blocks
    .filter(block => block.type === "text" && typeof block.text === "string")
    .map(block => block.text as string)
    .join("\n");
  return text.length > 0 ? foldCommandMarkup(text) : null;
}

/**
 * A slash-command prompt as the person typed it. Claude Code stores such a
 * prompt as markup — `<command-name>/x</command-name>` plus
 * `<command-args>y</command-args>` and a `<command-message>` label, in any
 * order and on any lines — rather than the composer text; this folds it back
 * to `/x y`. Text without a command-name tag comes back unchanged.
 */
export function foldCommandMarkup(text: string): string {
  const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim();
  if (!name) return text;
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? "";
  const command = args ? `${name} ${args}` : name;
  // Anything outside the tags is kept: the fold replaces the markup, never
  // the rest of what was said around it.
  const rest = text
    .replace(/<command-(name|args|message)>[\s\S]*?<\/command-\1>/g, "")
    .split("\n").map(line => line.trim()).filter(Boolean).join("\n");
  return rest ? `${command}\n${rest}` : command;
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
