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
 * Writes `docs/agents/<agent>.md` (the matrix), `docs/agents/<agent>.svg`
 * (the badge), and the README block between the `agent-coverage` markers.
 * Output is deterministic: no timestamps, sorted entries, versions only.
 * `scripts/agent-coverage.test.ts` regenerates in memory and fails when the
 * committed files differ.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { makeBadge } from "badge-maker";

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
  claudeTools: 30,
  openCodeV1Events: 80,
  openCodeV1Parts: 8,
  openCodeV2Events: 80,
  openCodeV2Parts: 3,
} as const;

/**
 * Claude Code's vocabulary: the `SDKMessage` union plus the extra message
 * types the CLI's stdout carries (`StdoutMessage`'s `coreTypes.*` members),
 * as `type` or `type/subtype`; the assistant content blocks the API SDK
 * declares; one tool per `*Input` in `sdk-tools.d.ts`.
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
    tools: requireFloor({ names: tools, file: toolsFile, pattern: "the ToolInputSchemas union's *Input members" }, FLOORS.claudeTools),
  };
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
  // Every version that decides the vocabulary: the "since" baseline key.
  versionLine: string;
  badgeVersion: string;
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
    { id: "tools", title: "Tools", source: "`@anthropic-ai/claude-agent-sdk` `sdk-tools.d.ts`: one `*Input` per tool, shown by wire name", keyPrefix: "", entries: tools },
  ], annotations, "src/chat/claude/sdk-coverage.ts");
  return {
    id: "claude-code",
    title: "Claude Code",
    versionLine: `\`@anthropic-ai/claude-agent-sdk\` ${vocabulary.sdkVersion} (bundled Claude Code CLI ${vocabulary.cliVersion}) · content blocks from \`@anthropic-ai/sdk\` ${vocabulary.apiSdkVersion}`,
    badgeVersion: `SDK ${vocabulary.sdkVersion}`,
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
    badgeVersion: `${vocabulary.v1Version} · ${vocabulary.v2Version}`,
    axes,
  };
}

export function gapCount(report: AgentReport): number {
  return report.axes.reduce((sum, axis) => sum + axis.entries.filter(entry => GAP_STATES.has(entry.state)).length, 0);
}

// ---------------------------------------------------------------------------
// Rendering

export const MATRIX_DIR = "docs/agents";
const SINCE_START = "<!-- agent-coverage:since:start -->";
const SINCE_END = "<!-- agent-coverage:since:end -->";
const VERSION_PREFIX = "Generated against ";

const STATE_MEANING: Record<CoverageState, string> = {
  dedicated: "used: uatu has purpose-built rendering or behavior for it",
  generic: "shown, but only through the generic tool row; not a gap, and a candidate for a surface of its own",
  ignored: "deliberately not shown, for the stated reason",
  unhandled: "not used yet, and no decision made: a gap",
  "behavior-missing": "shown, but uatu does not yet deliver what it does: a gap; the reason says what fails",
};

export type Since = { previous?: string; changes: Array<{ axis: string; added: string[]; removed: string[] }> };

/** The previous matrix's version line, its entry names per axis, and its "since" record, parsed from the committed file. */
export function parseMatrix(markdown: string): { versionLine?: string; axes: Map<string, Set<string>>; since?: Since } {
  const lines = markdown.split("\n");
  const versionLine = lines.find(line => line.startsWith(VERSION_PREFIX))?.slice(VERSION_PREFIX.length).replace(/\.$/, "");
  const axes = new Map<string, Set<string>>();
  let axis: Set<string> | undefined;
  for (const line of lines) {
    const heading = /^## .+ <a id="axis-([^"]+)"><\/a>$/.exec(line);
    if (heading) { axis = new Set(); axes.set(heading[1]!, axis); continue; }
    if (line.startsWith("## ")) { axis = undefined; continue; }
    const cell = /^\| `([^`]+)` \|/.exec(line);
    if (axis && cell) axis.add(cell[1]!);
  }
  const since = parseSince(lines);
  return { versionLine, axes, ...(since === undefined ? {} : { since }) };
}

// The "since" block back into data, so carrying it forward re-renders it
// rather than copying text a hand edit could have changed.
function parseSince(lines: string[]): Since | undefined {
  const start = lines.indexOf(SINCE_START);
  const end = lines.indexOf(SINCE_END);
  if (start < 0 || end < start) return undefined;
  const block = lines.slice(start + 1, end).filter(Boolean);
  const heading = block.shift();
  if (heading === "## Since the previous generation") return { changes: [] };
  if (!heading?.startsWith("## Since ")) return undefined;
  const names = (list: string | undefined): string[] => [...(list ?? "").matchAll(/`([^`]+)`/g)].map(match => match[1]!);
  const changes = block.flatMap(line => {
    const change = /^- \*\*(.+?)\*\*(?: — added (.+?))?(?:(?:;| —) removed (.+))?$/.exec(line);
    return change ? [{ axis: change[1]!, added: names(change[2]), removed: names(change[3]) }] : [];
  });
  return { previous: heading.slice("## Since ".length), changes };
}

function renderSince(since: Since): string {
  const body = since.previous === undefined
    ? ["## Since the previous generation", "", "First generation: there is no previous matrix to compare against."]
    : [
      `## Since ${since.previous}`,
      "",
      ...(since.changes.length === 0 ? ["No vocabulary was added or removed."] : since.changes.map(({ axis, added, removed }) =>
        `- **${axis}**${added.length ? ` — added ${added.map(code).join(", ")}` : ""}${removed.length ? `${added.length ? ";" : " —"} removed ${removed.map(code).join(", ")}` : ""}`)),
    ];
  return [SINCE_START, ...body, SINCE_END].join("\n");
}

/**
 * What changed since the previous generation: computed against the committed
 * matrix when the versions moved, carried forward while they stand still (the
 * vocabulary is a function of the versions, so there is nothing new to say).
 */
export function sinceSection(report: AgentReport, previous: string | undefined): string {
  const parsed = previous === undefined ? undefined : parseMatrix(previous);
  if (parsed?.since && parsed.versionLine === report.versionLine) return renderSince(parsed.since);
  if (!parsed?.versionLine) return renderSince({ changes: [] });
  const changes = report.axes.flatMap(axis => {
    const before = parsed.axes.get(axis.id) ?? new Set<string>();
    const now = new Set(axis.entries.map(entry => entry.name));
    const added = [...now].filter(name => !before.has(name)).sort();
    const removed = [...before].filter(name => !now.has(name)).sort();
    return added.length || removed.length ? [{ axis: axis.title, added, removed }] : [];
  });
  return renderSince({ previous: parsed.versionLine, changes });
}

export function renderMatrix(report: AgentReport, previous: string | undefined): string {
  const counts = STATES.map(state => `${state} ${report.axes.reduce((sum, axis) => sum + axis.entries.filter(entry => entry.state === state).length, 0)}`);
  const out: string[] = [
    `# ${report.title} SDK coverage`,
    "",
    "<!-- Generated by `bun run coverage:agents`. Do not edit: the freshness test in scripts/agent-coverage.test.ts rejects hand edits. -->",
    "",
    `uatu treats ${report.title} as a first-class agent. The aim is to use what its SDK offers, not the subset every agent has in common. This page lists every message type, content block or part, and tool the installed SDK declares, and what uatu does with each today. The gaps are the work still to do. None of them means a feature is unwanted.`,
    "",
    `${VERSION_PREFIX}${report.versionLine}.`,
    "",
    `**Gaps: ${gapCount(report)}** (unhandled or behavior-missing) · ${counts.join(" · ")}`,
    "",
    "Each entry is classified by running uatu's own normalizers and renderers on a stub of it, so the page cannot drift from what the code does. The hand-written part is small: why a type is ignored, and which features show up but do not work yet.",
    "",
    "| State | Meaning |",
    "| --- | --- |",
    ...STATES.map(state => `| ${state} | ${STATE_MEANING[state]} |`),
    "",
    sinceSection(report, previous),
  ];
  for (const axis of report.axes) {
    out.push("", `## ${axis.title} <a id="axis-${axis.id}"></a>`, "", `Source: ${axis.source}.`, "");
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
  return `${out.join("\n")}\n`;
}

export function renderBadge(report: AgentReport): string {
  const gaps = gapCount(report);
  return `${makeBadge({ label: report.title, message: `${report.badgeVersion} · ${gaps} ${gaps === 1 ? "gap" : "gaps"}`, color: gaps === 0 ? "brightgreen" : "yellow" })}\n`;
}

export const README_START = "<!-- agent-coverage:start -->";
export const README_END = "<!-- agent-coverage:end -->";

export function renderReadmeBlock(reports: AgentReport[]): string {
  return [
    README_START,
    "<!-- Generated by `bun run coverage:agents`; edits between these markers are overwritten and fail the freshness test. -->",
    `${reports.map(report => report.title).join(" and ")} are first-class agents in uatu: the aim is to use what each SDK offers, not the subset they share. Each badge opens a page listing everything the installed SDK declares and what uatu does with it; the gap count is the work still to do.`,
    "",
    "<p>",
    ...reports.map(report => `  <a href="./${MATRIX_DIR}/${report.id}.md"><img src="./${MATRIX_DIR}/${report.id}.svg" alt="${report.title} SDK coverage: ${report.badgeVersion}, ${gapCount(report)} gaps" /></a>`),
    "</p>",
    README_END,
  ].join("\n");
}

export function replaceReadmeBlock(readme: string, block: string): string {
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END);
  if (start < 0 || end < start) throw new Error(`agent coverage: README.md has no ${README_START} … ${README_END} block`);
  return `${readme.slice(0, start)}${block}${readme.slice(end + README_END.length)}`;
}

export type GeneratedFile = { path: string; content: string };

/** Every output, in memory, against the committed files under `root`. */
export function generate(root = REPO_ROOT): GeneratedFile[] {
  runControls();
  const reports = [claudeReport(), openCodeReport()];
  const read = (file: string): string | undefined => existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), "utf8") : undefined;
  const files: GeneratedFile[] = reports.flatMap(report => {
    const matrix = `${MATRIX_DIR}/${report.id}.md`;
    return [
      { path: matrix, content: renderMatrix(report, read(matrix)) },
      { path: `${MATRIX_DIR}/${report.id}.svg`, content: renderBadge(report) },
    ];
  });
  files.push({ path: "README.md", content: replaceReadmeBlock(read("README.md") ?? "", renderReadmeBlock(reports)) });
  return files;
}

/** The committed outputs under `root` that differ from what the generator produces now. */
export function staleOutputs(root = REPO_ROOT, files: GeneratedFile[] = generate(root)): string[] {
  return files.flatMap(file => {
    const target = path.join(root, file.path);
    return existsSync(target) && readFileSync(target, "utf8") === file.content ? [] : [file.path];
  });
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

if (import.meta.main) {
  for (const file of generate()) {
    const target = path.join(REPO_ROOT, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content);
    console.log(`wrote ${file.path}`);
  }
}
