import type { BackgroundTaskItem } from "../../types";
import type { NormalizedProviderUpdate } from "../../provider";
import { array, number, optionalString, record, text } from "../normalization";

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

/** V2 worker facts, separate from the successful tool which launched them.
 * Session parentage is established by a scoped session record, never by text.
 * This projection is disposable; complete provider history reconstructs it.
 */
export class BackgroundWorkers {
  private recoveryOnly = false;
  constructor(private readonly budget: { entries?: number; bytes?: number } = {}) {}
  private readonly parents = new Map<string, string>();
  private readonly tasks = new Map<string, { parent: string; worker: string; item: BackgroundTaskItem }>();
  private readonly notices = new Set<string>();
  private readonly unmatched = new Map<string, { parent: string; worker: string; item: BackgroundTaskItem; correlatable: boolean }>();
  private readonly ended = new Map<string, number[]>();
  private readonly aliases = new Map<string, string>();
  // Empty outer array and six collections. Each retained entry adds its
  // serialized tuple (or notice string) plus a conservative comma allowance.
  private bytes = 38;
  private boundaries = 0;
  private readonly sizes = new Map<object, Map<string, number>>();

  private get unlimited(): boolean {
    return this.budget.entries === Infinity && this.budget.bytes === Infinity;
  }

  private set<T>(map: Map<string, T>, key: string, value: T): void {
    if (!this.unlimited) this.account(map, key, JSON.stringify([key, value]).length * 2 + 2);
    map.set(key, value);
  }

  private account(collection: object, key: string, size: number): void {
    let sizes = this.sizes.get(collection);
    if (!sizes) this.sizes.set(collection, sizes = new Map());
    this.bytes += size - (sizes.get(key) ?? 0);
    if (size) sizes.set(key, size);
    else sizes.delete(key);
  }

  private notice(key: string): void {
    if (!this.unlimited) this.account(this.notices, key, JSON.stringify(key).length * 2 + 2);
    this.notices.add(key);
  }

  verifyChild(child: string, parent: string): void {
    if (this.recoveryOnly || !identity(child) || !identity(parent)) return;
    this.set(this.parents, child, parent);
    this.bound();
  }

  executionEnded(child: string, at: number): void {
    if (this.recoveryOnly || !this.parents.has(child)) return;
    const boundaries = this.ended.get(child) ?? [];
    if (boundaries.includes(at)) return;
    boundaries.push(at);
    this.boundaries++;
    this.set(this.ended, child, boundaries);
    this.bound();
  }

  launch(parent: string, value: unknown, at: number): NormalizedProviderUpdate[] {
    if (this.recoveryOnly) return [];
    const result = this.foldLaunch(parent, value, at);
    this.bound();
    return result;
  }

  private foldLaunch(parent: string, value: unknown, at: number): NormalizedProviderUpdate[] {
    const part = record(value);
    const state = record(part.state);
    const metadata = record(state.metadata);
    const input = record(state.input);
    const call = optionalString(part.id);
    const shell = part.name === "shell";
    const child = optionalString(shell ? metadata.shellID : metadata.sessionID);
    if ((!shell && part.name !== "subagent") || !identity(call) || !identity(child) || !identity(parent) || (!shell && this.parents.get(child) !== parent)
      || state.status !== "completed" || metadata.status !== "running") return [];
    const callKey = `v2:${parent}:${call}`;
    if (!identity(`task:${callKey}`)) return [];
    const taskId = this.aliases.get(callKey) ?? callKey;
    const known = this.tasks.get(taskId);
    if (known) return [{ kind: "upsert", item: known.item }];
    const startedAt = number(record(part.time).created) ?? at;
    const shared = [...this.tasks.values()].find(task => task.parent === parent && task.worker === child && task.item.status === "running"
      && !this.ended.get(child)?.some(end => end >= task.item.createdAt && end < startedAt));
    if (shared) {
      this.set(this.aliases, callKey, shared.item.taskId);
      shared.item = { ...shared.item, toolUseIds: [...(shared.item.toolUseIds ?? [shared.item.toolUseId!]), call] };
      this.set(this.tasks, shared.item.taskId, shared);
      return [{ kind: "upsert", item: shared.item }];
    }
    const item: BackgroundTaskItem = {
      id: `task:${taskId}`, type: "background_task", taskId,
      createdAt: startedAt,
      toolUseId: call, ...(shell ? { outputFile: `shell:${child}` } : { childConversationId: child }), taskType: shell ? "shell" : "agent",
      description: optionalString(shell ? input.command : input.description) ?? "Background worker",
      ...(optionalString(input.agent) ? { subagentType: text(input.agent) } : {}),
      ...(optionalString(input.prompt) ? { prompt: text(input.prompt) } : {}),
      status: "running",
      ...(this.ended.get(child)?.some(end => end >= startedAt) ? { stateUncertain: true } : {}),
    };
    const superseded: NormalizedProviderUpdate[] = [];
    for (const previous of this.tasks.values()) {
      if (previous.parent !== parent || previous.worker !== child || previous.item.status !== "running") continue;
      previous.item = { ...previous.item, stateUncertain: true };
      this.set(this.tasks, previous.item.taskId, previous);
      superseded.push({ kind: "upsert", item: previous.item });
    }
    this.set(this.tasks, taskId, { parent, worker: child, item });
    const pending = [...this.unmatched.entries()].filter(([, result]) => result.correlatable && result.parent === parent && result.worker === child && result.item.createdAt >= item.createdAt);
    if (pending.length === 1) {
      const [key, result] = pending[0]!;
      this.unmatched.delete(key);
      if (!this.unlimited) this.account(this.unmatched, key, 0);
      const settled = { ...item, status: result.item.status, summary: result.item.summary, resultId: result.item.resultId,
        ...(result.item.terminalReportedAt === undefined ? {} : { terminalReportedAt: result.item.terminalReportedAt }) };
      this.set(this.tasks, taskId, { parent, worker: child, item: settled });
      return [{ kind: "remove", itemId: result.item.id }, { kind: "upsert", item: settled }];
    }
    return [...superseded, { kind: "upsert", item }];
  }

  content(parent: string, content: unknown, at: number): NormalizedProviderUpdate[] {
    return array(content).flatMap(part => this.launch(parent, part, at));
  }

  // `at` also positions/correlates a row. Pass null when it is only a display
  // fallback, not a provider report clock (including stored missing-time 0).
  notification(parent: string, id: string, payload: unknown, at: number, terminalReportedAt: number | null = at): NormalizedProviderUpdate[] | undefined {
    if (this.recoveryOnly) {
      const source = record(record(payload).metadata).source;
      return source === "subagent" || source === "shell" ? [] : undefined;
    }
    const result = this.foldNotification(parent, id, payload, at, terminalReportedAt);
    this.bound();
    return result;
  }

  private foldNotification(parent: string, id: string, payload: unknown, at: number, terminalReportedAt: number | null): NormalizedProviderUpdate[] | undefined {
    const value = record(payload);
    const metadata = record(value.metadata);
    const shell = metadata.source === "shell";
    const child = optionalString(shell ? metadata.shellID : metadata.childID);
    if ((!shell && metadata.source !== "subagent") || !identity(child) || !identity(parent) || !identity(id) || !identity(`task:v2:${parent}:notification:${id}`) || (!shell && this.parents.get(child) !== parent)) return;
    if (shell && (metadata.exit != null && (typeof metadata.exit !== "number" || !Number.isFinite(metadata.exit))
      || metadata.signal != null && typeof metadata.signal !== "string"
      || metadata.timeout != null && typeof metadata.timeout !== "boolean")) return;
    // User-shell notes use the same source, but have no tool background launch.
    if (shell && ![...this.tasks.values()].some(task => task.parent === parent && task.worker === child)) return;
    const status = metadata.state === "completed" ? (shell && (metadata.timeout === true || typeof metadata.signal === "string" || typeof metadata.exit === "number" && metadata.exit !== 0) ? "failed" : "completed")
      : metadata.state === "error" ? "failed" : metadata.state === "cancelled" ? "stopped" : undefined;
    if (!status) return;
    const reportClock = terminalReportedAt !== null && Number.isFinite(terminalReportedAt) && terminalReportedAt >= 0 ? { terminalReportedAt } : {};
    const key = `${parent}:${id}`;
    if (this.notices.has(key)) return [];
    const candidates = [...this.tasks.values()].filter(task => task.parent === parent && task.worker === child && task.item.status === "running" && task.item.createdAt <= at);
    // Only validated metadata classifies a notification. Remove the provider's
    // outer presentation envelope, not arbitrary markup in the report itself.
    const body = text(value.text);
    const summary = shell ? body.replace(/^<shell\b[^\n]*>\n/, "").replace(/\n<\/shell>$/, "")
      : body.replace(/^<subagent\b[^\n]*>\n/, "").replace(/\n<\/subagent>$/, "");
    if (candidates.length !== 1) {
      const taskId = `v2:${parent}:notification:${id}`;
      const item: BackgroundTaskItem = {
        id: `task:${taskId}`, type: "background_task", taskId, createdAt: at,
        description: optionalString(value.description) ?? "Background worker result",
        childConversationId: child, taskType: "agent", status, summary, resultId: id, ...reportClock,
      };
      this.set(this.unmatched, key, { parent, worker: child, item, correlatable: candidates.length === 0 });
      this.notice(key);
      return [...candidates.map((task): NormalizedProviderUpdate => {
        task.item = { ...task.item, stateUncertain: true };
        this.set(this.tasks, task.item.taskId, task);
        return { kind: "upsert", item: task.item };
      }), { kind: "upsert", item }];
    }
    const task = candidates[0]!;
    task.item = { ...task.item, status, summary, resultId: id, ...reportClock };
    this.set(this.tasks, task.item.taskId, task);
    this.notice(key);
    return [{ kind: "upsert", item: task.item }];
  }

  private bound(): void {
    const maxEntries = this.budget.entries ?? 8_192;
    const maxBytes = this.budget.bytes ?? 4 * 1024 * 1024;
    if (maxEntries === Infinity && maxBytes === Infinity) return;
    const collections = [this.parents, this.tasks, this.notices, this.unmatched, this.ended, this.aliases];
    const entries = collections.reduce((sum, values) => sum + values.size, 0) + this.boundaries;
    if (entries <= maxEntries && this.bytes <= maxBytes) return;
    // Never evict only an old occurrence or its notice tombstone: the next
    // delayed result could then settle a newer run. On saturation the stream
    // becomes a trigger for scoped authoritative recovery until reconnect.
    // No provider mutation or polling is introduced by this fallback.
    collections.forEach(values => values.clear());
    this.sizes.clear();
    this.bytes = 38;
    this.boundaries = 0;
    this.recoveryOnly = true;
  }
}
