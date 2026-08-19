import type { ToolItem } from "./types";

export type DiffLine = { sign: "-" | "+"; text: string };

export type ToolDetail =
  | { kind: "edit"; label: string; path: string; diff: DiffLine[] }
  | { kind: "write"; label: string; path: string; content: string }
  | { kind: "read"; label: string; path: string; startLine?: number }
  | { kind: "search"; label: string; query: string; where?: string }
  | { kind: "fetch"; label: string; url: string }
  | { kind: "todo"; label: string; entries: Array<{ text: string; state: "pending" | "active" | "done" }> }
  | { kind: "patch"; label: string; files: string[]; diff: DiffLine[] }
  | { kind: "question"; label: string; asked: Array<{ header: string; prompt: string }>; answer?: string }
  | { kind: "agent"; label: string; description: string; subagent?: string; prompt: string; conversationId?: string; result?: string }
  | { kind: "skill"; label: string; name: string }
  | { kind: "generic"; label: string };

export function describeToolDetail(item: Pick<ToolItem, "name" | "input" | "output" | "childConversationId">): ToolDetail {
  const label = humanizeToolName(item.name);
  const input = parseInput(item.input);
  switch (item.name.toLowerCase()) {
    // OpenCode edits files through `apply_patch`, never `edit`/`write`, so
    // those cases below are dead for it and every edit fell through to the
    // raw-JSON generic view. The patch envelope carries the +/- lines
    // already; we only need the file list for the summary.
    case "apply_patch": {
      const patch = optionalText(input.patchText);
      if (patch === undefined) break;
      return { kind: "patch", label: "Edit", files: patchFiles(patch), diff: patchDiffLines(patch) };
    }
    // A question is both an event and, on replay, a tool part. Rendering the
    // part as generic JSON is what made answered questions unreadable when
    // reopening a conversation.
    case "question": {
      const asked = Array.isArray(input.questions) ? input.questions : undefined;
      if (!asked) break;
      return {
        kind: "question",
        label: "Question",
        asked: asked.flatMap(value => {
          const entry = record(value);
          const prompt = optionalText(entry.question);
          if (prompt === undefined) return [];
          return [{ header: optionalText(entry.header) ?? "Question", prompt }];
        }),
        ...(optionalText(item.output) === undefined ? {} : { answer: text(item.output) }),
      };
    }
    case "edit": {
      const path = pathOf(input);
      if (path === undefined) break;
      return { kind: "edit", label, path, diff: naiveLineDiff(text(input.oldString ?? input.old_string), text(input.newString ?? input.new_string)) };
    }
    case "write": {
      const path = pathOf(input);
      if (path === undefined) break;
      return { kind: "write", label, path, content: text(input.content) };
    }
    case "read": {
      const path = pathOf(input);
      if (path === undefined) break;
      const offset = number(input.offset);
      return { kind: "read", label, path, ...(offset === undefined ? {} : { startLine: offset }) };
    }
    case "grep":
    case "glob":
    case "list": {
      const query = optionalText(input.pattern ?? input.query) ?? (item.name.toLowerCase() === "list" ? optionalText(input.path) : undefined);
      if (query === undefined) break;
      const where = optionalText(input.path ?? input.include);
      return { kind: "search", label, query, ...(where !== undefined && where !== query ? { where } : {}) };
    }
    case "webfetch":
    case "fetch": {
      const url = optionalText(input.url);
      if (url === undefined) break;
      return { kind: "fetch", label, url };
    }
    // A subagent row said only "Agent task running" — the one thing worth
    // knowing is which agent, doing what. Both are in the input.
    case "task": {
      const description = optionalText(input.description);
      if (description === undefined) break;
      const result = taskResultText(item.output);
      return {
        kind: "agent",
        label: "Agent",
        description,
        ...(optionalText(input.subagent_type) === undefined ? {} : { subagent: text(input.subagent_type) }),
        prompt: text(input.prompt),
        ...(item.childConversationId === undefined ? {} : { conversationId: item.childConversationId }),
        ...(result === undefined ? {} : { result }),
      };
    }
    // Loading a skill is one fact — which one. The raw JSON view buried the
    // name inside an input blob.
    case "skill": {
      const skillName = optionalText(input.name ?? input.skill);
      if (skillName === undefined) break;
      return { kind: "skill", label: "Skill", name: skillName };
    }
    case "todowrite": {
      const todos = Array.isArray(input.todos) ? input.todos : undefined;
      if (!todos) break;
      return {
        kind: "todo",
        label: "Todos",
        entries: todos.flatMap(value => {
          const todo = record(value);
          const entryText = optionalText(todo.content) ?? optionalText(todo.activeForm);
          if (entryText === undefined) return [];
          const status = optionalText(todo.status);
          return [{ text: entryText, state: status === "completed" ? "done" as const : status === "in_progress" ? "active" as const : "pending" as const }];
        }),
      };
    }
  }
  return { kind: "generic", label };
}

/**
 * The subagent's report from a task tool's output, without the machine
 * envelope: OpenCode wraps it as <task id=…><task_result>…</task_result></task>,
 * which reads as debug output when shown verbatim.
 */
export function taskResultText(output: string | undefined): string | undefined {
  if (!output) return undefined;
  const match = /<task_result>([\s\S]*?)<\/task_result>/.exec(output);
  const body = (match ? match[1]! : output).trim();
  return body || undefined;
}

export function toolSubject(detail: ToolDetail): string | undefined {
  switch (detail.kind) {
    case "edit":
    case "write":
    case "read":
      return detail.path;
    case "search":
      return detail.query;
    case "fetch":
      return detail.url;
    case "patch":
      return detail.files.length === 1 ? detail.files[0] : detail.files.length > 1 ? `${detail.files.length} files` : undefined;
    case "question":
      return detail.asked[0]?.header;
    case "agent":
      return detail.subagent ? `${detail.subagent} · ${detail.description}` : detail.description;
    case "skill":
      return detail.name;
    default:
      return undefined;
  }
}

export type TodoEntry = { text: string; state: "pending" | "active" | "done" };

export type TodoActivity =
  | { type: "created"; count: number }
  | { type: "added" | "started" | "completed" | "reopened"; task: string };

/**
 * The change between two successive todo snapshots. Each `todowrite` call
 * carries the whole list, so rendering them verbatim reprints the same list
 * on every tool call; what the reader wants is what moved.
 */
export function deriveTodoActivities(previous: readonly TodoEntry[], current: readonly TodoEntry[]): TodoActivity[] {
  if (previous.length === 0) return current.length > 0 ? [{ type: "created", count: current.length }] : [];
  const priorByKey = new Map(previous.map((task, index) => [`${index}:${task.text}`, task]));
  const activities: TodoActivity[] = [];
  for (const [index, task] of current.entries()) {
    const prior = priorByKey.get(`${index}:${task.text}`);
    if (!prior) {
      activities.push({ type: "added", task: task.text });
      continue;
    }
    if (prior.state === task.state) continue;
    if (task.state === "done") activities.push({ type: "completed", task: task.text });
    else if (prior.state === "done") activities.push({ type: "reopened", task: task.text });
    else if (task.state === "active") activities.push({ type: "started", task: task.text });
  }
  return activities;
}

export type TodoSummary = { label: string; task?: string };

/**
 * One-line summary of a todo update, shown in place of the whole list: the
 * activity as the label and the task it happened to beside it. The task
 * text is the point — "Completed" alone says nothing about what moved.
 */
export function todoActivitySummary(activities: readonly TodoActivity[], entries: readonly TodoEntry[]): TodoSummary {
  const first = activities[0];
  if (!first) {
    const done = entries.filter(entry => entry.state === "done").length;
    return { label: `Todos ${done}/${entries.length}` };
  }
  if (first.type === "created") return { label: `Added ${first.count} todo${first.count === 1 ? "" : "s"}` };
  const verb = { added: "Added", started: "Started", completed: "Completed", reopened: "Reopened" }[first.type];
  // Several tasks can move in one write (finishing one usually starts the
  // next). One item maps to one summary row, so the first activity is named
  // and the rest are counted rather than dropped.
  const extra = activities.length > 1 ? ` +${activities.length - 1}` : "";
  return { label: `${verb}${extra}`, task: first.task };
}

/** File paths named by an apply_patch envelope's `*** <verb> File:` headers. */
export function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1]!.trim());
}

/**
 * The +/- body of an apply_patch envelope. Envelope markers and hunk headers
 * are dropped; a leading space marks unchanged context, which is not a diff
 * line and would otherwise render as an addition.
 */
export function patchDiffLines(patch: string): DiffLine[] {
  // `--- ` and `+++ ` are file markers only in a unified diff's header — from
  // git's `diff `/`index ` preamble to that file's first `@@` hunk. Everywhere
  // else they are ordinary changed lines: deleting `-- security check`
  // produces exactly `--- security check`, and dropping it by prefix alone
  // meant someone could approve an edit without having been shown every line
  // of it. The apply_patch envelope has no such markers at all — after a
  // `*** <verb> File:` header every +/- line is a change, whether or not an
  // `@@` context marker ever appears — so an envelope verb opens content, not
  // another header. Position decides; the one thing tracked is which of the
  // two zones a line sits in.
  let inContent = false;
  return patch.split("\n").flatMap((line): DiffLine[] => {
    if (line.startsWith("@@") || line.startsWith("***")) {
      inContent = true;
      return [];
    }
    // Git's preamble: header again until this file section's first hunk.
    if (line.startsWith("diff ") || line.startsWith("index ")) {
      inContent = false;
      return [];
    }
    if (!inContent && (line.startsWith("--- ") || line.startsWith("+++ "))) return [];
    if (line.startsWith("+")) return [{ sign: "+", text: line.slice(1) }];
    if (line.startsWith("-")) return [{ sign: "-", text: line.slice(1) }];
    return [];
  });
}

export function humanizeToolName(name: string): string {
  const known: Record<string, string> = { webfetch: "Fetch", todowrite: "Todos", todoread: "Todos", task: "Agent task" };
  const lower = name.toLowerCase();
  if (known[lower]) return known[lower];
  if (!/^[a-z0-9_-]+$/i.test(name) || name.includes("__")) return name;
  return name
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word, index) => index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)
    .join(" ") || name;
}

export function naiveLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText ? oldText.split("\n") : [];
  const newLines = newText ? newText.split("\n") : [];
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;
  return [
    ...oldLines.slice(prefix, oldLines.length - suffix).map(line => ({ sign: "-" as const, text: line })),
    ...newLines.slice(prefix, newLines.length - suffix).map(line => ({ sign: "+" as const, text: line })),
  ];
}

function parseInput(input: string | undefined): Record<string, unknown> {
  if (!input) return {};
  try {
    return record(JSON.parse(input));
  } catch {
    return {};
  }
}

function pathOf(input: Record<string, unknown>): string | undefined {
  return optionalText(input.filePath ?? input.file_path ?? input.path);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
