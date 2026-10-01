/**
 * `bun run coverage:agents` — the agent SDK coverage report.
 *
 * For each supported agent, reads the vocabulary its installed SDK declares
 * (message types and subtypes, content-block or part types, tool names where
 * the SDK enumerates them) and classifies every entry by running the
 * product's own normalizers and renderers against a minimal stub of it. The
 * only hand-kept input is the per-agent annotations module
 * (`src/chat/<agent>/sdk-coverage.ts`).
 *
 * Renders the dashboard issue body (`DASHBOARD_ISSUE`), and, against the body
 * published before, the comment naming what a bump added or removed. Nothing
 * is written into the repository: `.github/workflows/agent-coverage.yml`
 * publishes after every push to main. Output is deterministic: no
 * timestamps, sorted entries, versions only.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { claudeCoverageAnnotations } from "../src/chat/claude/sdk-coverage";
import { INTENTIONALLY_IGNORED, claudeToolInteraction, createClaudeEventMemory, normalizeClaudeMessage } from "../src/chat/claude/normalization";
import type { CoverageAnnotations } from "../src/chat/coverage-annotations";
import { COMMAND_TOOL_NAMES, CORE_IGNORED, IGNORED_PARTS, createProviderEventMemory, normalizeEventWith, normalizeToolPart, type GenerationMapper } from "../src/chat/opencode/normalization";
import { openCodeCoverageAnnotations } from "../src/chat/opencode/sdk-coverage";
import { openCodeV1Mapper } from "../src/chat/opencode/v1/normalization";
import { createOpenCodeV2Mapper, createOpenCodeV2Memory } from "../src/chat/opencode/v2/normalization";
import type { NormalizedProviderEvent } from "../src/chat/provider";
import { describeToolDetail } from "../src/chat/tool-detail";

export const REPO_ROOT = path.resolve(import.meta.dir, "..");
const MODULES = path.join(REPO_ROOT, "node_modules");

// ---------------------------------------------------------------------------
// Vocabulary extraction

/** A declaration file that no longer yields an axis: the generator's only loud failure mode. */
export class ExtractionError extends Error {}

export type ExtractedAxis = { names: string[]; file: string; pattern: string };

/** Reads a declaration file with line endings normalized (the Claude SDK ships CRLF). */
export function readDeclarations(file: string): string {
  if (!existsSync(file)) throw new ExtractionError(`agent coverage: ${relative(file)} does not exist`);
  return readFileSync(file, "utf8").replaceAll("\r\n", "\n");
}

/** Fails naming the file and the pattern when an axis yields fewer entries than its floor. */
export function requireFloor(axis: ExtractedAxis, floor: number): ExtractedAxis {
  if (axis.names.length < floor) {
    throw new ExtractionError(`agent coverage: ${relative(axis.file)} yielded ${axis.names.length} entries for ${axis.pattern} (floor ${floor}); the declaration layout changed`);
  }
  return axis;
}

/** Member names of `type NAME = A | B | …`, or null when NAME is not a union alias. */
export function unionMembers(source: string, name: string): string[] | null {
  const match = new RegExp(`^(?:export )?(?:declare )?type ${escapeRegExp(name)} =\\s*([^;{]+);`, "m").exec(source);
  if (!match) return null;
  const members = match[1]!.split("|").map(member => member.trim()).filter(Boolean);
  return members.every(member => /^[\w.]+$/.test(member)) ? members : null;
}

/**
 * The string literals of a top-level field (`type`, `subtype`) of a named
 * declaration — an object type alias, an interface, or an Effect
 * `Schema.Struct` constant. Only the declaration's own first-level fields are
 * read, never a nested object's.
 */
export function fieldLiterals(source: string, name: string, field: string): string[] {
  // A schema module declares a name twice (an empty `interface X extends …`
  // and the `const X: Schema.Struct<{…}>`); the first declaration that has
  // the field wins.
  const starts = new RegExp(`^(?:export )?(?:declare )?(?:type ${escapeRegExp(name)} = \\{|interface ${escapeRegExp(name)}\\b[^\\n]*\\{|const ${escapeRegExp(name)}: [^\\n]*\\{)$`, "gm");
  const fieldLine = new RegExp(`^    (?:readonly )?${escapeRegExp(field)}\\??: (.+);$`);
  for (const start of source.matchAll(starts)) {
    const lines = source.slice(start.index + start[0].length + 1).split("\n");
    for (const line of lines) {
      if (/^\S/.test(line)) break;
      const match = fieldLine.exec(line);
      if (match) return [...match[1]!.matchAll(/["']([^"']+)["']/g)].map(literal => literal[1]!);
    }
  }
  return [];
}

/** The `type` literals of every member of a union, resolving nested unions. */
function unionTypeLiterals(source: string, union: string): string[] {
  const names: string[] = [];
  const visit = (member: string): void => {
    const literals = fieldLiterals(source, member, "type");
    if (literals.length) { names.push(...literals); return; }
    for (const nested of unionMembers(source, member) ?? []) visit(nested);
  };
  for (const member of unionMembers(source, union) ?? []) visit(member);
  return sortedUnique(names);
}

function packageVersion(dir: string): string {
  const file = path.join(dir, "package.json");
  const version = (JSON.parse(readDeclarations(file)) as { version?: unknown }).version;
  if (typeof version !== "string") throw new ExtractionError(`agent coverage: ${relative(file)} names no version`);
  return version;
}

export type ClaudeVocabulary = {
  sdkVersion: string;
  cliVersion: string;
  apiSdkVersion: string;
  messages: ExtractedAxis;
  blocks: ExtractedAxis;
  userBlocks: ExtractedAxis;
  tools: ExtractedAxis;
};

export type ClaudeSources = { sdkDir: string; apiSdkDir: string };

export const CLAUDE_SOURCES: ClaudeSources = {
  sdkDir: path.join(MODULES, "@anthropic-ai/claude-agent-sdk"),
  apiSdkDir: path.join(MODULES, "@anthropic-ai/sdk"),
};

export const FLOORS = {
  claudeMessages: 30,
  claudeBlocks: 10,
  claudeUserBlocks: 3,
  claudeTools: 30,
  openCodeV1Events: 80,
  openCodeV1Parts: 8,
  openCodeV2Events: 80,
  openCodeV2Parts: 3,
} as const;

/**
 * Claude Code's vocabulary: the `SDKMessage` union plus the extra message
 * types the CLI's stdout carries (`StdoutMessage`'s `coreTypes.*` members),
 * as `type` or `type/subtype`; the content blocks the API SDK declares for
 * an assistant message (`BetaContentBlock`), and the blocks only a user
 * message carries — `MessageParam`'s `ContentBlockParam` minus every type a
 * response can contain (`ContentBlock`), since `ContentBlockParam` is the
 * request union for either role; one tool per `*Input` in `sdk-tools.d.ts`.
 */
export function extractClaude(sources: ClaudeSources = CLAUDE_SOURCES): ClaudeVocabulary {
  const sdkFile = path.join(sources.sdkDir, "sdk.d.ts");
  const sdk = readDeclarations(sdkFile);
  const extra = (unionMembers(sdk, "StdoutMessage") ?? [])
    .filter(member => member.startsWith("coreTypes.") && member !== "coreTypes.SDKMessage")
    .map(member => member.slice("coreTypes.".length));
  const messages: string[] = [];
  const visit = (member: string): void => {
    const types = fieldLiterals(sdk, member, "type");
    if (types.length) {
      const subtypes = fieldLiterals(sdk, member, "subtype");
      for (const type of types) {
        if (subtypes.length) messages.push(...subtypes.map(subtype => `${type}/${subtype}`));
        else messages.push(type);
      }
      return;
    }
    for (const nested of unionMembers(sdk, member) ?? []) visit(nested);
  };
  for (const member of [...(unionMembers(sdk, "SDKMessage") ?? []), ...extra]) visit(member);

  const blocksFile = path.join(sources.apiSdkDir, "resources/beta/messages/messages.d.mts");
  const userBlocksFile = path.join(sources.apiSdkDir, "resources/messages/messages.d.mts");
  const toolsFile = path.join(sources.sdkDir, "sdk-tools.d.ts");
  const tools = sortedUnique((unionMembers(readDeclarations(toolsFile), "ToolInputSchemas") ?? []).filter(name => name.endsWith("Input")));
  const manifestFile = path.join(sources.sdkDir, "manifest.json");
  const cliVersion = (JSON.parse(readDeclarations(manifestFile)) as { version?: unknown }).version;
  if (typeof cliVersion !== "string") throw new ExtractionError(`agent coverage: ${relative(manifestFile)} names no CLI version`);
  return {
    sdkVersion: packageVersion(sources.sdkDir),
    cliVersion,
    apiSdkVersion: packageVersion(sources.apiSdkDir),
    messages: requireFloor({ names: sortedUnique(messages), file: sdkFile, pattern: "the SDKMessage and StdoutMessage unions' type/subtype literals" }, FLOORS.claudeMessages),
    blocks: requireFloor({ names: unionTypeLiterals(readDeclarations(blocksFile), "BetaContentBlock"), file: blocksFile, pattern: "the BetaContentBlock union's type literals" }, FLOORS.claudeBlocks),
    userBlocks: requireFloor({ names: userOnly(readDeclarations(userBlocksFile)), file: userBlocksFile, pattern: "the ContentBlockParam union's type literals not in ContentBlock" }, FLOORS.claudeUserBlocks),
    tools: requireFloor({ names: tools, file: toolsFile, pattern: "the ToolInputSchemas union's *Input members" }, FLOORS.claudeTools),
  };
}

function userOnly(source: string): string[] {
  const response = new Set(unionTypeLiterals(source, "ContentBlock"));
  return unionTypeLiterals(source, "ContentBlockParam").filter(type => !response.has(type));
}

export type OpenCodeVocabulary = {
  v1Version: string;
  v2Version: string;
  v2SchemaVersion: string;
  v1Events: ExtractedAxis;
  v1Parts: ExtractedAxis;
  v2Events: ExtractedAxis;
  v2Parts: ExtractedAxis;
};

export type OpenCodeSources = { v1Dir: string; v2ClientDir: string; v2SchemaDir: string };

export const OPENCODE_SOURCES: OpenCodeSources = {
  v1Dir: path.join(MODULES, "@opencode-ai/sdk"),
  v2ClientDir: path.join(MODULES, "@opencode/client"),
  v2SchemaDir: path.join(MODULES, "@opencode/schema"),
};

/**
 * OpenCode's vocabulary per generation. 1.x: the `Event` and `Part` unions of
 * the SDK client the 1.x provider imports (`@opencode-ai/sdk/v2`). 2.x: the
 * event names the schema package's event manifest and session events
 * declare, and the assistant content union.
 */
export function extractOpenCode(sources: OpenCodeSources = OPENCODE_SOURCES): OpenCodeVocabulary {
  const v1File = path.join(sources.v1Dir, "dist/v2/gen/types.gen.d.ts");
  const v1 = readDeclarations(v1File);
  const manifestFile = path.join(sources.v2SchemaDir, "dist/event-manifest.d.ts");
  const sessionEventFile = path.join(sources.v2SchemaDir, "dist/session-event.d.ts");
  const eventLine = /^    type: "([^"]+)";$/gm;
  const v2Events = sortedUnique([manifestFile, sessionEventFile].flatMap(file => [...readDeclarations(file).matchAll(eventLine)].map(match => match[1]!)));
  const messageFile = path.join(sources.v2SchemaDir, "dist/session-message.d.ts");
  return {
    v1Version: packageVersion(sources.v1Dir),
    v2Version: packageVersion(sources.v2ClientDir),
    v2SchemaVersion: packageVersion(sources.v2SchemaDir),
    v1Events: requireFloor({ names: unionTypeLiterals(v1, "Event"), file: v1File, pattern: "the Event union's type literals" }, FLOORS.openCodeV1Events),
    v1Parts: requireFloor({ names: unionTypeLiterals(v1, "Part"), file: v1File, pattern: "the Part union's type literals" }, FLOORS.openCodeV1Parts),
    v2Events: requireFloor({ names: v2Events, file: manifestFile, pattern: "event definitions' `type: \"…\"` lines (with session-event.d.ts)" }, FLOORS.openCodeV2Events),
    v2Parts: requireFloor({ names: unionTypeLiterals(readDeclarations(messageFile), "AssistantContent"), file: messageFile, pattern: "the AssistantContent union's type literals" }, FLOORS.openCodeV2Parts),
  };
}

// ---------------------------------------------------------------------------
// Classification by probing the product code

export type CoverageState = "dedicated" | "generic" | "ignored" | "unhandled" | "behavior-missing";
export const STATES: readonly CoverageState[] = ["dedicated", "generic", "ignored", "unhandled", "behavior-missing"];
export const GAP_STATES: ReadonlySet<CoverageState> = new Set(["unhandled", "behavior-missing"]);

export type Entry = { name: string; state: CoverageState; declared?: string; renders?: string; reason?: string };

export type Axis = {
  id: string;
  title: string;
  source: string;
  // Annotation keys for this axis are `<keyPrefix><name>`.
  keyPrefix: string;
  entries: Entry[];
  // Set when the SDK does not enumerate this axis: the entries are the
  // product's own dedicated names, and the matrix says so.
  notEnumerated?: string;
};

/**
 * An event or message's outcome → its observed state. A case that matched
 * but emitted nothing for the stub reports `ignored` just like a type on the
 * ignore list; only the list's membership makes it a deliberate drop.
 */
function stateOf(outcome: NormalizedProviderEvent["outcome"], onIgnoreList: boolean): CoverageState {
  if (outcome === "unrecognized") return "unhandled";
  if (outcome === "ignored") return onIgnoreList ? "ignored" : "dedicated";
  return "dedicated";
}

const PROBE = "__uatu_coverage_probe__";

// One input shaped to satisfy any tool renderer's required field, so a
// renderer that has a case for the tool's name takes it. The name decides;
// the stub never makes an unknown tool look dedicated (the control checks).
const TOOL_STUB: Record<string, unknown> = {
  command: "probe", description: "probe", prompt: "probe", plan: "probe", name: "probe", skill: "probe",
  file_path: "probe", filePath: "probe", path: "probe", pattern: "probe", query: "probe", url: "probe",
  patchText: "*** Begin Patch\n*** End Patch", todos: [],
  questions: [{ question: "probe", header: "probe", options: [], multiSelect: false }],
};

function assertControl(what: string, actual: string, expected: string): void {
  if (actual !== expected) throw new Error(`agent coverage: the ${what} control classified as ${actual}, expected ${expected}; the probe can no longer tell handled from unhandled`);
}

export function probeClaudeMessage(name: string): CoverageState {
  const [type, subtype] = name.split("/") as [string, string | undefined];
  const stub = { type, ...(subtype === undefined ? {} : { subtype }), uuid: PROBE, session_id: PROBE, timestamp: 0 };
  const { outcome } = normalizeClaudeMessage(stub, createClaudeEventMemory(), "live");
  return stateOf(outcome, INTENTIONALLY_IGNORED.has(subtype ?? type));
}

/** A user-message block, through a stored frame: the source whose user records become bubbles. */
export function probeClaudeUserBlock(type: string): CoverageState {
  const normalized = normalizeClaudeMessage({ type: "user", uuid: PROBE, timestamp: 0, message: { content: [{ type }] } }, createClaudeEventMemory(), "stored");
  return normalized.skippedBlocks?.includes(type) ? "unhandled" : "dedicated";
}

export function probeClaudeBlock(type: string): CoverageState {
  const normalized = normalizeClaudeMessage({ type: "assistant", uuid: PROBE, timestamp: 0, message: { content: [{ type }] } }, createClaudeEventMemory(), "live");
  return normalized.skippedBlocks?.includes(type) ? "unhandled" : "dedicated";
}

/** What a Claude tool renders as: a dedicated surface, or the generic tool row. */
export function probeClaudeTool(name: string): { state: CoverageState; renders?: string } {
  // The agent's todo tool becomes the task-progress surface instead of a row.
  const normalized = normalizeClaudeMessage({ type: "assistant", uuid: PROBE, timestamp: 0, message: { content: [{ type: "tool_use", id: PROBE, name, input: TOOL_STUB }] } }, createClaudeEventMemory(), "live");
  const row = normalized.updates.find(update => update.kind === "upsert" && update.item.id === `tool:${PROBE}`);
  if (!row) {
    const surface = normalized.updates.find(update => update.kind === "upsert");
    return { state: "dedicated", renders: surface?.kind === "upsert" ? surface.item.type.replaceAll("_", " ") : "no row" };
  }
  const interaction = claudeToolInteraction(name, TOOL_STUB);
  if (interaction.kind !== "permission") return { state: "dedicated", renders: `${interaction.kind} card` };
  const detail = describeToolDetail({ name, input: JSON.stringify(TOOL_STUB) });
  if (detail.kind !== "generic") return { state: "dedicated", renders: `${detail.kind} row` };
  return { state: "generic", renders: "tool row" };
}

function openCodeIgnored(mapper: GenerationMapper<never>, type: string): boolean {
  let canonical: string | undefined;
  try {
    canonical = mapper.toCanonical(type, {}, { type })?.type;
  } catch {
    canonical = undefined;
  }
  return mapper.ignored.has(type) || CORE_IGNORED.has(type) || (canonical !== undefined && CORE_IGNORED.has(canonical));
}

const V2_PROBE_DIRECTORY = "/uatu-coverage-probe";

export function probeOpenCodeEvent(generation: "1.x" | "2.x", type: string): CoverageState {
  if (generation === "1.x") {
    const { outcome } = normalizeEventWith({ id: PROBE, type, properties: {} }, openCodeV1Mapper, createProviderEventMemory());
    return stateOf(outcome, openCodeIgnored(openCodeV1Mapper as GenerationMapper<never>, type));
  }
  const mapper = createOpenCodeV2Mapper(V2_PROBE_DIRECTORY);
  const { outcome } = normalizeEventWith({ id: PROBE, type, created: 0, data: {} }, mapper, createOpenCodeV2Memory());
  return stateOf(outcome, openCodeIgnored(mapper as unknown as GenerationMapper<never>, type));
}

export function probeOpenCodePart(generation: "1.x" | "2.x", type: string): CoverageState {
  const normalized = generation === "1.x"
    ? normalizeEventWith({ id: PROBE, type: "message.part.updated", properties: { part: { id: PROBE, messageID: PROBE, sessionID: PROBE, type } } }, openCodeV1Mapper, createProviderEventMemory())
    : normalizeEventWith({ id: PROBE, type: "session.message.content.updated", created: 0, data: { sessionID: PROBE, messageID: PROBE, content: [{ type }] } }, createOpenCodeV2Mapper(V2_PROBE_DIRECTORY), createOpenCodeV2Memory());
  if (normalized.outcome === "unparseable") throw new Error(`agent coverage: the ${generation} part probe for ${type} did not parse`);
  if (normalized.skippedBlocks?.includes(type)) return "unhandled";
  return normalized.updates.length === 0 && IGNORED_PARTS.has(type) ? "ignored" : "dedicated";
}

/**
 * The tool names the renderer treats as dedicated. OpenCode's SDKs type a
 * tool name as a plain string, so the candidates are the names the product
 * itself knows — the tool-detail renderer's cases and the command-row names —
 * and each is kept only if probing confirms it renders as more than the
 * generic row.
 */
export function openCodeDedicatedTools(): Entry[] {
  const detailSource = readFileSync(path.join(REPO_ROOT, "src/chat/tool-detail.ts"), "utf8");
  const body = detailSource.slice(detailSource.indexOf("function parseToolDetail("));
  const cases = [...body.slice(0, body.indexOf("\n}\n")).matchAll(/^\s+case "([^"]+)":/gm)].map(match => match[1]!);
  return sortedUnique([...cases, ...COMMAND_TOOL_NAMES]).flatMap(name => {
    const update = normalizeToolPart({ id: PROBE, type: "tool", tool: name, state: { status: "running", input: TOOL_STUB } }, 0);
    if (update.kind === "upsert" && update.item.type === "command") return [{ name, state: "dedicated" as const, renders: "command row" }];
    const detail = describeToolDetail({ name, input: JSON.stringify(TOOL_STUB) });
    return detail.kind === "generic" ? [] : [{ name, state: "dedicated" as const, renders: `${detail.kind} row` }];
  });
}

function runControls(): void {
  assertControl("unknown Claude message", probeClaudeMessage(PROBE), "unhandled");
  assertControl("unknown Claude system subtype", probeClaudeMessage(`system/${PROBE}`), "unhandled");
  assertControl("unknown Claude block", probeClaudeBlock(PROBE), "unhandled");
  assertControl("unknown Claude user block", probeClaudeUserBlock(PROBE), "unhandled");
  assertControl("unknown Claude tool", probeClaudeTool(PROBE).state, "generic");
  for (const generation of ["1.x", "2.x"] as const) {
    assertControl(`unknown OpenCode ${generation} event`, probeOpenCodeEvent(generation, PROBE), "unhandled");
    assertControl(`unknown OpenCode ${generation} part`, probeOpenCodePart(generation, PROBE), "unhandled");
  }
}

// ---------------------------------------------------------------------------
// Reports

export type AgentReport = {
  id: "claude-code" | "opencode";
  title: string;
  // Every version that decides the vocabulary.
  versionLine: string;
  axes: Axis[];
};

/**
 * Applies annotations to observed entries. A reason key is an entry's key or
 * a family (`2.x:pty.*`, every ignored entry under the prefix); the most
 * specific key wins. Rejects any key that names nothing the SDK declares, a
 * reason for an entry that is not ignored, and an ignored entry left without
 * a reason.
 */
export function annotate(axes: Axis[], annotations: CoverageAnnotations, module: string): Axis[] {
  const byKey = new Map<string, Entry>();
  for (const axis of axes) for (const entry of axis.entries) {
    for (const key of new Set([`${axis.keyPrefix}${entry.name}`, ...(entry.declared ? [`${axis.keyPrefix}${entry.declared}`] : [])])) {
      if (byKey.has(key)) throw new Error(`agent coverage: two entries share the annotation key ${key}`);
      byKey.set(key, entry);
    }
  }
  const resolve = (key: string): Entry => {
    const entry = byKey.get(key);
    if (!entry) throw new Error(`agent coverage: ${module} annotates ${key}, which the installed SDK does not declare`);
    return entry;
  };
  // Entry → the reason from its most specific key (exact beats any family).
  const chosen = new Map<Entry, { specificity: number; reason: string }>();
  const offer = (entry: Entry, specificity: number, reason: string): void => {
    const current = chosen.get(entry);
    if (!current || specificity > current.specificity) chosen.set(entry, { specificity, reason });
  };
  for (const [key, reason] of Object.entries(annotations.reasons)) {
    if (!reason.trim()) throw new Error(`agent coverage: ${module} gives ${key} an empty reason`);
    if (key.endsWith("*")) {
      const prefix = key.slice(0, -1);
      const family = [...byKey].filter(([candidate, entry]) => candidate.startsWith(prefix) && entry.state === "ignored").map(([, entry]) => entry);
      if (family.length === 0) throw new Error(`agent coverage: ${module} annotates the family ${key}, which matches no ignored entry the installed SDK declares`);
      for (const entry of family) offer(entry, prefix.length, reason);
      continue;
    }
    const entry = resolve(key);
    if (entry.state !== "ignored") throw new Error(`agent coverage: ${module} gives a reason for ${key}, which is ${entry.state}, not ignored`);
    offer(entry, Number.POSITIVE_INFINITY, reason);
  }
  for (const [entry, { reason }] of chosen) entry.reason = reason;
  const unexplained = axes.flatMap(axis => axis.entries.filter(entry => entry.state === "ignored" && !entry.reason).map(entry => `${axis.keyPrefix}${entry.name}`));
  if (unexplained.length) throw new Error(`agent coverage: ${module} states no reason for ignored ${unexplained.join(", ")}; add one, or take the type off the product's ignore list so it reports as unhandled`);
  for (const [key, reason] of Object.entries(annotations.behaviorMissing)) {
    const entry = resolve(key);
    if (!reason.trim()) throw new Error(`agent coverage: ${module} marks ${key} behavior-missing without a reason`);
    // Behavior-missing means "renders, but does not work": an entry that is
    // not rendered at all has nothing to be missing behavior behind.
    if (entry.state !== "dedicated" && entry.state !== "generic") throw new Error(`agent coverage: ${module} marks ${key} behavior-missing, but it is ${entry.state}, not rendered`);
    entry.state = "behavior-missing";
    entry.reason = reason;
  }
  return axes;
}

export function claudeWireNames(inputName: string, toolNames: Readonly<Record<string, string | readonly string[]>> = claudeCoverageAnnotations.toolNames): string[] {
  const mapped = toolNames[inputName];
  if (mapped === undefined) return [inputName.replace(/Input$/, "")];
  return typeof mapped === "string" ? [mapped] : [...mapped];
}

export function claudeReport(vocabulary: ClaudeVocabulary = extractClaude(), annotations = claudeCoverageAnnotations): AgentReport {
  for (const key of Object.keys(annotations.toolNames)) {
    if (!vocabulary.tools.names.includes(key)) throw new Error(`agent coverage: src/chat/claude/sdk-coverage.ts maps ${key}, which sdk-tools.d.ts does not declare`);
  }
  const tools = vocabulary.tools.names.map((declared): Entry => {
    const names = claudeWireNames(declared, annotations.toolNames);
    const probes = names.map(probeClaudeTool);
    const dedicated = probes.find(probe => probe.state === "dedicated");
    return { name: names.join(" / "), declared, ...(dedicated ?? probes[0]!) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const axes = annotate([
    { id: "messages", title: "Message types", source: "`@anthropic-ai/claude-agent-sdk` `sdk.d.ts`: the `SDKMessage` union and the extra `StdoutMessage` members, as `type` or `type/subtype`", keyPrefix: "", entries: vocabulary.messages.names.map(name => ({ name, state: probeClaudeMessage(name) })) },
    { id: "blocks", title: "Assistant content blocks", source: "`@anthropic-ai/sdk` `BetaContentBlock`", keyPrefix: "", entries: vocabulary.blocks.names.map(name => ({ name, state: probeClaudeBlock(name) })) },
    { id: "user-blocks", title: "User-only content blocks", source: "`@anthropic-ai/sdk` `ContentBlockParam` (the content of `SDKUserMessage.message`) minus every type a response can contain (`ContentBlock`); blocks both sides carry, such as `text`, are listed with the assistant blocks. Annotation keys are `user:<type>`", keyPrefix: "user:", entries: vocabulary.userBlocks.names.map(name => ({ name, state: probeClaudeUserBlock(name) })) },
    { id: "tools", title: "Tools", source: "`@anthropic-ai/claude-agent-sdk` `sdk-tools.d.ts`: one `*Input` per tool, shown by wire name", keyPrefix: "", entries: tools },
  ], annotations, "src/chat/claude/sdk-coverage.ts");
  return {
    id: "claude-code",
    title: "Claude Code",
    versionLine: `\`@anthropic-ai/claude-agent-sdk\` ${vocabulary.sdkVersion} (bundled Claude Code CLI ${vocabulary.cliVersion}) · content blocks from \`@anthropic-ai/sdk\` ${vocabulary.apiSdkVersion}`,
    axes,
  };
}

export function openCodeReport(vocabulary: OpenCodeVocabulary = extractOpenCode(), annotations: CoverageAnnotations = openCodeCoverageAnnotations): AgentReport {
  const axes = annotate([
    { id: "1.x-events", title: "1.x events", source: "`@opencode-ai/sdk` `v2/gen/types.gen.d.ts` `Event` (the client the 1.x provider imports)", keyPrefix: "1.x:", entries: vocabulary.v1Events.names.map(name => ({ name, state: probeOpenCodeEvent("1.x", name) })) },
    { id: "1.x-parts", title: "1.x message parts", source: "`@opencode-ai/sdk` `v2/gen/types.gen.d.ts` `Part`", keyPrefix: "1.x:", entries: vocabulary.v1Parts.names.map(name => ({ name, state: probeOpenCodePart("1.x", name) })) },
    { id: "2.x-events", title: "2.x events", source: "`@opencode/schema` `event-manifest.d.ts` and `session-event.d.ts`", keyPrefix: "2.x:", entries: vocabulary.v2Events.names.map(name => ({ name, state: probeOpenCodeEvent("2.x", name) })) },
    { id: "2.x-parts", title: "2.x assistant content", source: "`@opencode/schema` `session-message.d.ts` `AssistantContent`", keyPrefix: "2.x:", entries: vocabulary.v2Parts.names.map(name => ({ name, state: probeOpenCodePart("2.x", name) })) },
    { id: "tools", title: "Tools", source: "not enumerated by either SDK", keyPrefix: "tool:", entries: openCodeDedicatedTools(), notEnumerated: "Neither OpenCode SDK enumerates tool names: a tool is typed as a plain string. This lists only the names uatu's renderer treats as dedicated; every other tool name renders through the generic tool row." },
  ], annotations, "src/chat/opencode/sdk-coverage.ts");
  return {
    id: "opencode",
    title: "OpenCode",
    versionLine: `1.x through \`@opencode-ai/sdk\` ${vocabulary.v1Version} · 2.x through \`@opencode/client\` ${vocabulary.v2Version} (vocabulary from \`@opencode/schema\` ${vocabulary.v2SchemaVersion})`,
    axes,
  };
}

export function gapCount(report: AgentReport): number {
  return report.axes.reduce((sum, axis) => sum + axis.entries.filter(entry => GAP_STATES.has(entry.state)).length, 0);
}

// ---------------------------------------------------------------------------
// The dashboard

/** The issue the report is published to; the README links to it and the publication workflow edits it. */
export const DASHBOARD_ISSUE = 480;
/** GitHub's limit on an issue body, in characters. */
export const ISSUE_BODY_LIMIT = 65_536;

const STATE_MARKER_PREFIX = "<!-- agent-coverage:state v1 ";
const STATE_MARKER_SUFFIX = " -->";

const STATE_MEANING: Record<CoverageState, string> = {
  dedicated: "used: uatu has purpose-built rendering or behavior for it",
  generic: "shown, but only through the generic tool row; not a gap, and a candidate for a surface of its own",
  ignored: "deliberately not shown, for the stated reason",
  unhandled: "not used yet, and no decision made: a gap",
  "behavior-missing": "shown, but uatu does not yet deliver what it does: a gap; the reason says what fails",
};

/** Runs the probe controls, then builds every agent's report from the installed SDKs: the path publication takes. */
export function buildReports(): AgentReport[] {
  runControls();
  return [claudeReport(), openCodeReport()];
}

/** What a dashboard published, per agent id: the versions it was generated against and its entry names per axis id. */
export type PublishedVocabulary = Record<string, { versionLine: string; axes: Record<string, string[]> }>;

export function vocabularyOf(reports: AgentReport[]): PublishedVocabulary {
  return Object.fromEntries(reports.map(report => [report.id, {
    versionLine: report.versionLine,
    axes: Object.fromEntries(report.axes.map(axis => [axis.id, sortedUnique(axis.entries.map(entry => entry.name))])),
  }]));
}

/**
 * The hidden marker that carries the published vocabulary. The JSON goes
 * inside an HTML comment, so no `--` may survive in it: the second hyphen of
 * each pair becomes a JSON escape, which parses back to the same string.
 */
export function renderStateMarker(vocabulary: PublishedVocabulary): string {
  return `${STATE_MARKER_PREFIX}${JSON.stringify(vocabulary).replaceAll("--", "-\\u002d")}${STATE_MARKER_SUFFIX}`;
}

/** The vocabulary a dashboard body published, or undefined when it has no marker this version can read. */
export function parseStateMarker(body: string): PublishedVocabulary | undefined {
  const line = normalizeBody(body).split("\n").findLast(candidate => candidate.startsWith(STATE_MARKER_PREFIX) && candidate.endsWith(STATE_MARKER_SUFFIX));
  if (line === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(STATE_MARKER_PREFIX.length, -STATE_MARKER_SUFFIX.length));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  for (const agent of Object.values(parsed)) {
    if (!isRecord(agent) || typeof agent.versionLine !== "string" || !isRecord(agent.axes)) return undefined;
    for (const names of Object.values(agent.axes)) {
      if (!Array.isArray(names) || !names.every(name => typeof name === "string")) return undefined;
    }
  }
  return parsed as PublishedVocabulary;
}

export type AgentChanges = { title: string; before: string; after: string; changes: Array<{ axis: string; added: string[]; removed: string[] }> };

/**
 * What each agent's vocabulary gained and lost since the published one. An
 * agent or axis the published dashboard did not have has no baseline, so it
 * reports nothing; only agents with an addition or removal are returned.
 */
export function vocabularyChanges(published: PublishedVocabulary | undefined, reports: AgentReport[]): AgentChanges[] {
  if (!published) return [];
  return reports.flatMap(report => {
    const before = published[report.id];
    if (!before) return [];
    const changes = report.axes.flatMap(axis => {
      const previous = before.axes[axis.id];
      if (!previous) return [];
      const was = new Set(previous);
      const now = new Set(axis.entries.map(entry => entry.name));
      const added = [...now].filter(name => !was.has(name)).sort();
      const removed = [...was].filter(name => !now.has(name)).sort();
      return added.length || removed.length ? [{ axis: axis.title, added, removed }] : [];
    });
    return changes.length ? [{ title: report.title, before: before.versionLine, after: report.versionLine, changes }] : [];
  });
}

export function renderComment(changes: AgentChanges[]): string | undefined {
  if (changes.length === 0) return undefined;
  const out = ["New and removed SDK vocabulary since the dashboard was last published. The dashboard above shows each entry's state."];
  for (const agent of changes) {
    out.push("", `### ${agent.title}`, "", `From ${agent.before}`, `to ${agent.after}.`, "");
    for (const { axis, added, removed } of agent.changes) {
      out.push(`- **${axis}**${added.length ? ` — added ${added.map(code).join(", ")}` : ""}${removed.length ? `${added.length ? ";" : " —"} removed ${removed.map(code).join(", ")}` : ""}`);
    }
  }
  return `${out.join("\n")}\n`;
}

function stateCounts(report: AgentReport): string {
  return STATES.map(state => `${state} ${report.axes.reduce((sum, axis) => sum + axis.entries.filter(entry => entry.state === state).length, 0)}`).join(" · ");
}

function renderAgent(report: AgentReport): string[] {
  const out = ["", `## ${report.title}`, "", `Generated against ${report.versionLine}.`, "", `**Gaps: ${gapCount(report)}** (unhandled or behavior-missing) · ${stateCounts(report)}`];
  for (const axis of report.axes) {
    out.push("", `### ${report.title}: ${axis.title}`, "", `Source: ${axis.source}.`, "");
    if (axis.notEnumerated) out.push(axis.notEnumerated, "");
    const showRenders = axis.entries.some(entry => entry.renders);
    const showDeclared = axis.entries.some(entry => entry.declared);
    out.push(
      `| Name |${showDeclared ? " Declared as |" : ""} State |${showRenders ? " Renders as |" : ""} Reason |`,
      `| --- |${showDeclared ? " --- |" : ""} --- |${showRenders ? " --- |" : ""} --- |`,
    );
    for (const entry of axis.entries) {
      out.push(`| ${code(entry.name)} |${showDeclared ? ` ${entry.declared ? code(entry.declared) : ""} |` : ""} ${entry.state} |${showRenders ? ` ${entry.renders ?? ""} |` : ""} ${cell(entry.reason ?? "")} |`);
    }
  }
  return out;
}

/** The dashboard issue body. Deterministic: no timestamp, commit, or run link. Throws rather than truncate when it outgrows an issue. */
export function renderDashboard(reports: AgentReport[]): string {
  const out = [
    "<!-- Generated by `bun run coverage:agents` and published by .github/workflows/agent-coverage.yml after every push to main. Hand edits are overwritten. -->",
    "",
    `${reports.map(report => report.title).join(" and ")} are first-class agents in uatu. The aim is to use what each SDK offers, not the subset they share. This dashboard lists every message type, content block or part, and tool each installed SDK declares, and what uatu does with each today. The gaps are the work still to do. None of them means a feature is unwanted. When a dependency bump adds or removes vocabulary, a comment on this issue names it.`,
    "",
    "| Agent | Generated against | Gaps |",
    "| --- | --- | --- |",
    ...reports.map(report => `| ${report.title} | ${cell(report.versionLine)} | ${gapCount(report)} |`),
    "",
    "Each entry is classified by running uatu's own normalizers and renderers on a stub of it, so the dashboard cannot drift from what the code does. The hand-written part is small: why a type is ignored, and which features show up but do not work yet (`src/chat/claude/sdk-coverage.ts`, `src/chat/opencode/sdk-coverage.ts`).",
    "",
    "| State | Meaning |",
    "| --- | --- |",
    ...STATES.map(state => `| ${state} | ${STATE_MEANING[state]} |`),
    ...reports.flatMap(renderAgent),
    "",
    renderStateMarker(vocabularyOf(reports)),
  ];
  const body = `${out.join("\n")}\n`;
  if (body.length > ISSUE_BODY_LIMIT) {
    throw new Error(`agent coverage: the dashboard is ${body.length} characters, over the ${ISSUE_BODY_LIMIT}-character limit of an issue body; split it into one issue per agent rather than truncate it`);
  }
  return body;
}

export type Publication = {
  body: string;
  // Whether `body` differs from the published one: when not, the issue is left unedited.
  changed: boolean;
  // Set only when the vocabulary gained or lost entries since the published body.
  comment?: string;
};

/** What publishing against `previous` (the issue's current body, if known) would post and write. */
export function publication(previous: string | undefined, reports: AgentReport[] = buildReports()): Publication {
  const body = renderDashboard(reports);
  const comment = previous === undefined ? undefined : renderComment(vocabularyChanges(parseStateMarker(previous), reports));
  return { body, changed: previous === undefined || normalizeBody(previous) !== normalizeBody(body), ...(comment === undefined ? {} : { comment }) };
}

// GitHub may hand a body back with CRLF line endings or without the final
// newline; neither is a change.
function normalizeBody(body: string): string {
  return body.replaceAll("\r\n", "\n").trimEnd();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Helpers

function code(value: string): string {
  return `\`${value}\``;
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function relative(file: string): string {
  return path.relative(REPO_ROOT, file) || file;
}

const USAGE = "usage: bun run coverage:agents [--previous <issue body file>] [--body-out <file>] [--comment-out <file>]";

/**
 * With no options, prints the dashboard body (a local preview). `--previous`
 * compares against a published body; with it, the comment a bump would post
 * goes to `--comment-out`, or to stderr. `--body-out` receives the body only
 * when it differs from `--previous`. An output that has nothing to say is
 * removed, so the workflow can test for the file.
 */
function main(argv: string[]): number {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index]!, argv[index + 1]];
    if (!["--previous", "--body-out", "--comment-out"].includes(flag) || value === undefined) {
      console.error(USAGE);
      return 2;
    }
    options.set(flag, value);
  }
  const previousFile = options.get("--previous");
  const result = publication(previousFile === undefined ? undefined : readFileSync(previousFile, "utf8"));
  const write = (file: string | undefined, content: string | undefined, fallback: (content: string) => void): void => {
    if (file === undefined) { if (content !== undefined) fallback(content); return; }
    if (content === undefined) rmSync(file, { force: true });
    else writeFileSync(file, content);
  };
  write(options.get("--body-out"), result.changed ? result.body : undefined, content => process.stdout.write(content));
  write(options.get("--comment-out"), result.comment, content => process.stderr.write(`\nThe comment publication would post:\n\n${content}`));
  if (previousFile !== undefined) {
    console.error(`agent coverage: dashboard ${result.changed ? "changed" : "unchanged"}; ${result.comment ? "a vocabulary comment" : "no comment"}`);
  }
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
