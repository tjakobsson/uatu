import type { BackgroundTaskItem } from "../../types";
import type { NormalizedProviderUpdate } from "../../provider";
import { createHash } from "node:crypto";
import { array, number, optionalString, record, text, normalizeToolPart, type RecordValue } from "../normalization";
import type { V2Evidence } from "./normalization";

export type NativeProof = Readonly<{ id: string; created?: number; aggregate?: string; seq?: number; version?: number; fingerprint: string }>;
export type LauncherEvidence = Readonly<{
  call: string; child?: string; reportedChild?: string; requestedChild?: string; requestedSelectedOnly?: boolean; background?: boolean; selectedOnly?: boolean; workerType?: "agent" | "shell";
  phase: "snapshot" | "called" | "progress" | "success" | "failed";
  executed?: boolean;
  // Part clocks and a typed terminal event's native clock stay distinguishable
  // from each other and from the display-only `at` fallback.
  message?: string; created?: number; ran?: number; completed?: number; reportedCompletion?: number; inputFingerprint?: string; commandFingerprint?: string;
  proof?: NativeProof; historical?: boolean;
  conflicted?: boolean;
}>;
export type WorkerOccurrenceEvidence = Readonly<{ key: string; parent: string; worker: string; kind?: "agent" | "shell"; taskId: string; launches: readonly LauncherEvidence[]; executionStart?: NativeProof; executionEnd?: NativeProof; uncertain?: boolean }>;
export type WorkerRequestSource = Readonly<{ message: string; tool: string }>;
type WorkerTask = { parent: string; worker: string; item: BackgroundTaskItem; evidence: WorkerOccurrenceEvidence;
  requestTools?: readonly { source: WorkerRequestSource; proof: NativeProof; execution: NativeProof }[];
  resolvedRequests?: readonly { id: string; kind: "permission" | "question" }[]; requestsClosed?: true;
  request?: { id: string; kind: "permission" | "question"; source: WorkerRequestSource; execution: NativeProof; proof: NativeProof } };

export function workerExecutionId(occurrence?: WorkerOccurrenceEvidence): string | undefined {
  return workerExecutionIds(occurrence)[0];
}

/** Each immutable launch anchors only its positively proven occurrence. A
 * complete alias set bridges primary changes without a child-only identity.
 * Oversized sets expose no identity rather than silently losing old aliases. */
export function workerExecutionIds(occurrence?: WorkerOccurrenceEvidence): string[] {
  if (!occurrence?.kind) return [];
  const ids = [...new Set(occurrence.launches.flatMap(launch => !launch.conflicted && launch.message && launch.inputFingerprint
    && launch.created !== undefined && launch.ran !== undefined && launch.workerType === occurrence.kind
    ? [`v1:${digest(JSON.stringify([occurrence.parent, occurrence.worker, occurrence.kind, launch.call,
      launch.message, launch.created, launch.ran, launch.inputFingerprint]))}`] : []))].sort();
  return ids.length <= 64 ? ids : [];
}
export type PreparedTool = { fact: LauncherEvidence; update: NormalizedProviderUpdate; name: string; description?: string; prompt?: string; agent?: string };
export type PreparedNotification = Readonly<{ source: "subagent" | "shell"; worker?: string; status?: "completed" | "failed" | "stopped"; summary: string; description?: string; valid: boolean; userShell?: true }>;

export function prepareNotification(payload: unknown): PreparedNotification | undefined {
  const value = record(payload), metadata = record(value.metadata);
  if (metadata.source !== "subagent" && metadata.source !== "shell") return;
  const shell = metadata.source === "shell";
  const valid = !shell || !(metadata.exit != null && (typeof metadata.exit !== "number" || !Number.isFinite(metadata.exit))
    || metadata.signal != null && typeof metadata.signal !== "string" || metadata.timeout != null && typeof metadata.timeout !== "boolean");
  const status = metadata.state === "completed" ? (shell && (metadata.timeout === true || typeof metadata.signal === "string" || typeof metadata.exit === "number" && metadata.exit !== 0) ? "failed" : "completed")
    : metadata.state === "error" ? "failed" : metadata.state === "cancelled" ? "stopped" : undefined;
  const body = text(value.text);
  return Object.freeze({ source: metadata.source, worker: optionalString(shell ? metadata.shellID : metadata.childID), status, valid,
    description: optionalString(value.description), summary: shell ? body.replace(/^<shell\b[^\n]*>\n/, "").replace(/\n<\/shell>$/, "") : body.replace(/^<subagent\b[^\n]*>\n/, "").replace(/\n<\/subagent>$/, "") });
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
/** Exact native command association, without retaining another command body.
 * No trimming, shell parsing or guessed equivalence supplies missing proof.
 */
export function shellCommandFingerprint(command: unknown): string | undefined {
  return typeof command === "string" ? digest(JSON.stringify(["shell-command", command])) : undefined;
}
export function nativeProof(event: RecordValue, semantic: unknown): NativeProof | undefined {
  const id = optionalString(event.id);
  if (!identity(id) || event.created !== undefined && (number(event.created) === undefined || Number(event.created) < 0)) return;
  const durable = record(event.durable);
  if (event.durable !== undefined && (!identity(durable.aggregateID) || !Number.isSafeInteger(durable.seq) || Number(durable.seq) < 0 || !Number.isSafeInteger(durable.version) || Number(durable.version) < 1)) return;
  return Object.freeze({ id, created: number(event.created), aggregate: optionalString(durable.aggregateID), seq: number(durable.seq), version: number(durable.version), fingerprint: digest(JSON.stringify(semantic)) });
}
function sameProof(left?: NativeProof, right?: NativeProof): boolean {
  return !!left && !!right && JSON.stringify(left) === JSON.stringify(right);
}

/** One canonical tool read for timeline, worker projection, and authorization. */
export function prepareTool(value: unknown, at: number, phase: LauncherEvidence["phase"] = "snapshot", message?: string, event?: RecordValue, rememberedInput?: unknown): PreparedTool {
  const part = record(value), state = record(part.state), metadata = record(state.metadata), time = record(part.time);
  const update = normalizeToolPart(part, at);
  const name = update.kind === "upsert" && update.item.type === "tool" ? update.item.name : text(part.name ?? part.tool) || "tool";
  const child = update.kind === "upsert" && update.item.type === "tool" ? update.item.childConversationId : name === "shell" ? optionalString(metadata.shellID) : undefined;
  const input = record(state.input ?? rememberedInput);
  const requestedChild = phase === "called" || phase === "snapshot" && !child && (state.status === "running" || state.status === "pending") ? optionalString(input.sessionID) : undefined;
  const background = name !== "subagent" && name !== "tool" && name !== "shell" ? false : phase === "called" ? false
    : phase === "snapshot" && state.status !== undefined ? state.status === "completed" && metadata.status === "running"
      : phase === "success" && metadata.status === "running" ? true : undefined;
  const serializedInput = update.kind === "upsert" && update.item.type === "tool" ? update.item.input : state.input === undefined ? undefined : JSON.stringify(state.input);
  const fact: LauncherEvidence = { call: optionalString(part.id) ?? "", child, reportedChild: name === "shell" ? undefined : child, requestedChild, requestedSelectedOnly: requestedChild && name !== "subagent" ? true : undefined, background,
    selectedOnly: name === "subagent" || name === "tool" ? undefined : true, phase, message,
    ...(name === "subagent" ? { workerType: "agent" as const } : name === "shell" ? { workerType: "shell" as const } : {}),
    ...(typeof state.executed === "boolean" ? { executed: state.executed } : {}),
    ...(number(time.created) === undefined ? {} : { created: number(time.created) }),
    ...(number(time.ran) === undefined ? {} : { ran: number(time.ran) }),
    ...(number(time.completed) === undefined ? {} : { completed: number(time.completed) }),
    ...(event && (phase === "success" || phase === "failed") && number(event.created) !== undefined && Number(event.created) >= 0 ? { reportedCompletion: Number(event.created) } : {}),
    inputFingerprint: serializedInput === undefined ? undefined : digest(serializedInput),
    ...(name === "shell" ? { commandFingerprint: shellCommandFingerprint(input.command) } : {}) };
  return { fact: Object.freeze({ ...fact, ...(event ? { proof: nativeProof(event, fact) } : {}) }), update, name,
    description: optionalString(name === "shell" ? input.command : input.description), prompt: optionalString(input.prompt), agent: optionalString(input.agent) };
}

export function launcherChanged(fact: LauncherEvidence, occurrence?: WorkerOccurrenceEvidence): boolean {
  if (fact.historical) return false;
  const prior = occurrence?.launches.find(launch => launch.call === fact.call);
  if (!prior) return false;
  if (fact.conflicted) return true;
  // These are native identities, not display labels. An alias has its own
  // owning message; a reused call cannot acquire a different owner or kind.
  const kind = prior.workerType ?? occurrence?.kind;
  if (fact.workerType !== undefined && kind !== undefined && fact.workerType !== kind
    || fact.message !== undefined && prior.message !== undefined && fact.message !== prior.message
    || fact.commandFingerprint !== undefined && prior.commandFingerprint !== undefined && fact.commandFingerprint !== prior.commandFingerprint) return true;
  if (fact.child && fact.child !== occurrence!.worker || fact.requestedChild && fact.requestedChild !== occurrence!.worker || fact.background === false) return true;
  // A part's creation and run clocks are independent native evidence. A later
  // run cannot hide behind the unchanged creation of a reused tool record.
  const completed = prior.completed ?? prior.reportedCompletion;
  return fact.phase === "snapshot" && (fact.inputFingerprint !== undefined && prior.inputFingerprint !== undefined && fact.inputFingerprint !== prior.inputFingerprint
    || fact.created !== undefined && (prior.created !== undefined ? fact.created !== prior.created : completed !== undefined && fact.created > completed)
    || fact.ran !== undefined && (prior.ran !== undefined ? fact.ran !== prior.ran : completed !== undefined && fact.ran > completed)
    || fact.completed !== undefined && prior.completed !== undefined && fact.completed !== prior.completed);
}

/** Positive invocation identity for initial classification, not a replay test.
 * Optional native clocks may enrich, but conflicting clocks never bind.
 */
export function sameLauncherIdentity(left: LauncherEvidence, right: LauncherEvidence): boolean {
  return !left.conflicted && !right.conflicted && (["call", "child", "message", "workerType", "created", "inputFingerprint"] as const)
    .every(key => left[key] !== undefined && left[key] === right[key])
    && (["ran", "completed", "reportedCompletion", "commandFingerprint"] as const).every(key => left[key] === undefined || right[key] === undefined || left[key] === right[key]);
}

/** Retain provisional invocation evidence until an authoritative occurrence
 * can classify it. Sparse progress may enrich, never erase, a native fact.
 * A merged summary is not itself a native event or replay proof.
 */
export function retainLauncherEvidence(previous: LauncherEvidence | undefined, next: LauncherEvidence): LauncherEvidence {
  if (!previous) return next;
  if (next.historical) return previous;
  const conflict = (["message", "workerType", "created", "ran", "completed", "inputFingerprint", "commandFingerprint"] as const).some(key => previous[key] !== undefined && next[key] !== undefined && previous[key] !== next[key]);
  return Object.freeze({ ...previous, phase: previous.phase === "snapshot" || next.phase === "snapshot" ? "snapshot" : previous.phase,
    message: previous.message ?? next.message, workerType: previous.workerType ?? next.workerType, created: previous.created ?? next.created, ran: previous.ran ?? next.ran,
    completed: previous.completed ?? next.completed, reportedCompletion: previous.reportedCompletion ?? next.reportedCompletion,
    inputFingerprint: previous.inputFingerprint ?? next.inputFingerprint, commandFingerprint: previous.commandFingerprint ?? next.commandFingerprint,
    ...(previous.conflicted || next.conflicted || conflict ? { conflicted: true } : {}), proof: undefined, historical: undefined });
}

export type ControlWitness = Readonly<{ kind: "called" | "started" | "ended" | "notification" | "created"; proof: NativeProof }>;
export type ControlRead = { id: number; parent: string; start: number; failed: boolean; inventory: boolean; initialInventory?: boolean; incomplete?: true };
type ControlRecord = { parent: string; taskId: string; unavailable?: true; pending?: true; pendingCalls?: readonly string[]; aliases?: readonly string[]; kind?: "agent" | "shell"; item?: BackgroundTaskItem; evidence?: WorkerOccurrenceEvidence; witnesses?: readonly ControlWitness[]; changed?: number };
type ControlObservation = { parent?: string; child?: string; launch?: LauncherEvidence; calledAt?: number; witness?: ControlWitness;
  lifecycle?: { kind: string; parent?: string; directory?: string; own: boolean }; backgroundObserved?: true; seen?: number; commandFingerprint?: string };

/** Provider-lifetime control evidence. Correlation may be discarded, but a
 * published identity's revocation is never evicted or readmitted from history.
 * All maps, aliases, witnesses and discovery observations share this budget.
 */
export class BackgroundControls {
  private closed = false;
  private projectionLost = false;
  private gapSequence: number | null = null;
  private sequence = 0;
  private nextRead = 0;
  private readonly scopes = new Map<string, "retained" | "partial" | "inventoried" | "gap">();
  private readonly records = new Map<string, ControlRecord>();
  private readonly reads = new Map<number, ControlRead>();
  private readonly observations = new Map<string, ControlObservation>();
  private readonly sizes = new Map<object, Map<string | number, { bytes: number; entries: number }>>();
  private tupleBytes = 0;
  private entryCount = 0;
  constructor(private readonly budget: { bytes?: number; entries?: number; changed?: () => void } = {}) {}

  // A full ledger must still admit fresh reads for its retained targets.
  // Leave room for sixteen guards, each with a <=512-code-unit parent and
  // safe-integer counters (including worst-case JSON escaping). Tiny injected
  // test budgets scale this reservation down; production reserves 128 KiB /
  // sixteen entries inside, not in addition to, the 1 MiB / 2,048-entry cap.
  private get readCapacity(): number {
    return Math.min(16, Math.floor((this.budget.entries ?? 2_048) / 8), Math.floor((this.budget.bytes ?? 1024 * 1024) / (8 * 8_192)));
  }

  get usage(): { bytes: number; entries: number } {
    const separators = [this.scopes, this.records, this.reads, this.observations].reduce((sum, map) => sum + Math.max(0, map.size - 1) * 2, 0);
    return { bytes: JSON.stringify([this.closed, this.projectionLost, this.gapSequence, [], [], [], []]).length * 2 + this.tupleBytes + separators, entries: this.entryCount };
  }
  get activeReads(): number { return this.reads.size; }
  basis(taskId: string): WorkerOccurrenceEvidence | undefined { return this.records.get(taskId)?.evidence; }
  unavailable(taskId: string): boolean { return this.records.get(taskId)?.unavailable === true
    || [...this.records.values()].some(record => record.unavailable && record.aliases?.some(call => `v2:${record.parent}:${call}` === taskId)); }
  proof(taskId: string): { basis: WorkerOccurrenceEvidence; revision: number } | undefined {
    const record = this.records.get(taskId);
    return record?.evidence && !record.unavailable && !record.pending ? { basis: record.evidence, revision: record.changed ?? 0 } : undefined;
  }
  current(taskId: string): boolean { return !!this.proof(taskId); }

  private cost(value: unknown): number {
    const record = value as ControlRecord;
    return 1 + (record.evidence?.launches.length ?? 0) + (record.witnesses?.length ?? 0) + (record.aliases?.length ?? 0) + (record.pendingCalls?.length ?? 0)
      + (record.item ? 1 + (record.item.toolUseIds?.length ?? 0) : 0) + ((value as ControlObservation).witness ? 1 : 0);
  }
  private fits<K extends string | number, T>(map: Map<K, T>, key: K, value: T): boolean {
    const old = this.sizes.get(map)?.get(key), usage = this.usage;
    const bytes = usage.bytes + JSON.stringify([key, value]).length * 2 - (old?.bytes ?? 0) + (!map.has(key) && map.size ? 2 : 0);
    const entries = usage.entries + this.cost(value) - (old?.entries ?? 0);
    if (map === this.reads) return bytes <= (this.budget.bytes ?? 1024 * 1024) && entries <= (this.budget.entries ?? 2_048);
    const readBytes = [...(this.sizes.get(this.reads)?.values() ?? [])].reduce((sum, size) => sum + size.bytes, 0) + Math.max(0, this.reads.size - 1) * 2;
    // Account the permanent pool independently of guards' current string
    // lengths, so short active guards cannot consume future guards' headroom.
    return bytes - readBytes <= (this.budget.bytes ?? 1024 * 1024) - this.readCapacity * 8_192
      && entries - this.reads.size <= (this.budget.entries ?? 2_048) - this.readCapacity;
  }
  private write<K extends string | number, T>(map: Map<K, T>, key: K, value: T): void {
    let sizes = this.sizes.get(map);
    if (!sizes) this.sizes.set(map, sizes = new Map());
    const old = sizes.get(key), next = { bytes: JSON.stringify([key, value]).length * 2, entries: this.cost(value) };
    this.tupleBytes += next.bytes - (old?.bytes ?? 0); this.entryCount += next.entries - (old?.entries ?? 0);
    sizes.set(key, next); map.set(key, value);
    this.budget.changed?.();
  }
  private remove<K extends string | number, T>(map: Map<K, T>, key: K): void {
    const old = this.sizes.get(map)?.get(key);
    if (old) { this.tupleBytes -= old.bytes; this.entryCount -= old.entries; this.sizes.get(map)!.delete(key); }
    map.delete(key);
  }
  private gap(parent: string): void {
    if (this.scopes.has(parent) || this.fits(this.scopes, parent, "gap")) this.write(this.scopes, parent, "gap");
    else this.closed = true;
  }
  private put(record: ControlRecord): void {
    const old = this.records.get(record.taskId);
    if (old?.unavailable) return;
    if (!this.scopes.has(record.parent)) {
      if (!this.fits(this.scopes, record.parent, "retained")) { this.closed = true; return; }
      this.write(this.scopes, record.parent, "retained");
    }
    if (this.fits(this.records, record.taskId, record)) { this.write(this.records, record.taskId, record); return; }
    // A full basis is always larger than this identity-only stub. Reserve it
    // before publication; growth failure never erases an admitted identity.
    const aliases = old?.evidence?.launches.map(launch => launch.call) ?? old?.aliases ?? record.aliases;
    const stub: ControlRecord = { parent: record.parent, taskId: record.taskId, unavailable: true, ...(aliases?.length ? { aliases } : {}) };
    if (this.fits(this.records, record.taskId, stub)) this.write(this.records, record.taskId, stub);
    else this.gap(record.parent);
    // The failed growth may contain additional aliases for this wire identity.
    // Without space for their tombstones, never admit them as unrelated tasks.
    this.gap(record.parent);
    if (old?.evidence) for (const other of this.records.values()) if (!other.unavailable && other.parent === old.parent
      && other.evidence?.launches.some(launch => old.evidence!.launches.some(prior => prior.call === launch.call))) this.retire(other);
  }
  private retire(record: ControlRecord, witness?: ControlWitness): void {
    if (record.unavailable || this.records.get(record.taskId)?.unavailable) return;
    if (witness?.kind === "ended" || witness?.kind === "notification") for (const [key, observation] of this.observations) {
      if (observation.parent === record.parent && record.evidence?.launches.some(launch => launch.call === observation.launch?.call)) this.remove(this.observations, key);
    }
    const witnesses = witness ? [...(record.witnesses ?? []), witness] : record.witnesses;
    const aliases = record.evidence?.launches.map(launch => launch.call) ?? record.aliases;
    const stub: ControlRecord = { parent: record.parent, taskId: record.taskId, unavailable: true, ...(aliases?.length ? { aliases } : {}), ...(witnesses?.length ? { witnesses } : {}) };
    if (this.fits(this.records, record.taskId, stub)) this.write(this.records, record.taskId, stub);
    else {
      this.write(this.records, record.taskId, { parent: record.parent, taskId: record.taskId, unavailable: true });
      this.gap(record.parent);
    }
    // A cold live alias can acquire a different canonical id in complete
    // history. Every published identity sharing that proven occurrence must
    // retain the same revocation, including when only one row is restated.
    if (aliases) for (const other of this.records.values()) if (!other.unavailable && other.parent === record.parent
      && other.evidence?.launches.some(launch => aliases.includes(launch.call))) this.retire(other, witness);
  }
  historical(kind: ControlWitness["kind"], proof?: NativeProof): boolean {
    return !!proof && [...this.records.values()].some(record => record.witnesses?.some(witness => witness.kind === kind && sameProof(witness.proof, proof)));
  }
  projectionSaturated(): void { this.projectionLost = true; }
  observationGap(): void {
    // Transport loss retires the covered cohort, not all future cohorts.
    // Capacity closure remains sticky and is never reset by reconnect.
    this.gapSequence = this.sequence;
    for (const record of this.records.values()) this.retire(record);
    for (const read of this.reads.values()) { read.failed = true; this.write(this.reads, read.id, read); }
  }
  beginRead(parent: string, admitted = true, classifyLive = false, inventory = false): ControlRead {
    const read = { id: ++this.nextRead, parent, start: this.sequence, failed: !admitted, inventory,
      ...(classifyLive ? { initialInventory: !this.scopes.has(parent) || this.scopes.get(parent) === "retained" || this.scopes.get(parent) === "partial" } : {}) };
    if (!admitted || parent.length > 512 || this.reads.size >= this.readCapacity || !this.fits(this.reads, read.id, read)) {
      read.failed = true;
      this.incompleteRead(read);
      return read;
    }
    this.write(this.reads, read.id, read); return read;
  }
  incompleteRead(read: ControlRead): void {
    if (read.incomplete) return;
    // Partial evidence can still admit healthy siblings. Unlike `failed`,
    // this only prevents callers from closing the first inventory opportunity.
    read.incomplete = true;
    if (this.reads.get(read.id) === read) this.write(this.reads, read.id, read);
    // Negative coverage survives even a rejected guard. Keep it in the bounded
    // scope ledger; an unrepresentable scope closes new admission, not retained
    // healthy proof. Transcript reads cannot replace outstanding inventory.
    if (read.parent.length > 512) this.closed = true;
    else if (this.scopes.get(read.parent) !== "gap" && this.scopes.get(read.parent) !== "inventoried") {
      if (this.fits(this.scopes, read.parent, "partial")) this.write(this.scopes, read.parent, "partial");
      else this.gap(read.parent);
    }
  }
  endRead(read: ControlRead, complete = false): void {
    if (!complete || read.failed) this.incompleteRead(read);
    this.remove(this.reads, read.id);
    // The first complete cold inventory is different from a later discovery
    // racing buffered startup frames. Reuse the accounted scope, not a cache
    // or time window; a gap survives for the provider's lifetime.
    const partial = this.scopes.get(read.parent) === "partial";
    const closesInventory = complete && !read.failed && !read.incomplete && (read.initialInventory !== undefined || partial) && (!partial || read.inventory)
      && this.scopes.get(read.parent) !== "gap" && this.scopes.get(read.parent) !== "inventoried";
    if (closesInventory) {
      const scope = read.initialInventory !== undefined ? "inventoried" : "retained";
      if (this.fits(this.scopes, read.parent, scope)) this.write(this.scopes, read.parent, scope);
      else this.gap(read.parent);
    }
  }
  private note(key: string, observation: ControlObservation): Array<{ parent: string; item: BackgroundTaskItem }> {
    const prior = this.observations.get(key);
    let launch = observation.launch ? retainLauncherEvidence(prior?.launch, observation.launch) : prior?.launch;
    if (prior?.launch && observation.launch && this.initialDetachment(prior, observation.launch)) launch = Object.freeze({ ...launch!, background: true });
    if (prior?.backgroundObserved && observation.launch?.background === false && launch) launch = Object.freeze({ ...launch, conflicted: true });
    const next = { ...prior, ...observation, launch, calledAt: observation.calledAt ?? prior?.calledAt, seen: prior?.seen ?? this.sequence,
      ...(prior?.backgroundObserved || observation.launch?.background === true ? { backgroundObserved: true as const } : {}) };
    if (this.fits(this.observations, key, next)) { this.write(this.observations, key, next); return []; }
    const updates: Array<{ parent: string; item: BackgroundTaskItem }> = [];
    // A known target must reserve its sticky unavailable stub before losing
    // relevant ephemeral evidence. A scope gap alone only blocks admission;
    // it cannot justify clearing a retained target's unresolved invocation.
    for (const record of this.records.values()) {
      const basis = record.evidence, fact = next.launch;
      if (record.unavailable || !basis) continue;
      const related = next.child === basis.worker || next.child === basis.parent || next.parent === basis.parent && fact && (
        basis.launches.some(launch => launch.call === fact.call) || record.pendingCalls?.includes(fact.call)
        || !fact.selectedOnly && fact.child === basis.worker || !fact.requestedSelectedOnly && fact.requestedChild === basis.worker
        || !fact.child && !fact.requestedChild && fact.message !== undefined && basis.launches.some(launch => launch.message === fact.message)
          && (fact.workerType === basis.kind || !fact.selectedOnly));
      if (!related) continue;
      if (record.item) updates.push({ parent: record.parent, item: { ...structuredClone(record.item), stateUncertain: true } });
      this.retire(record);
    }
    if (observation.parent) this.gap(observation.parent); else this.closed = true;
    return updates;
  }
  private initialDetachment(observation: ControlObservation, next: LauncherEvidence): boolean {
    const previous = observation.launch, parent = observation.parent;
    return !!previous && !!parent && !this.closed && !this.projectionLost && this.scopes.get(parent) !== "gap" && !observation.backgroundObserved
      && previous.phase === "snapshot" && previous.background === false && next.phase === "snapshot" && next.background === true
      && sameLauncherIdentity(previous, next) && ![...this.records.values()].some(record => record.parent === parent
        && (record.taskId === `v2:${parent}:${previous.call}` || record.aliases?.includes(previous.call) || record.evidence?.launches.some(launch => launch.call === previous.call)));
  }
  observe(event: V2Evidence, own: boolean, report?: PreparedNotification, reportProof?: NativeProof): Array<{ parent: string; item: BackgroundTaskItem }> {
    this.sequence++;
    const updates: Array<{ parent: string; item: BackgroundTaskItem }> = [];
    const lifecycle = event.lifecycle?.id;
    for (const record of this.records.values()) {
      if (record.unavailable || !record.evidence) continue;
      const basis = record.evidence;
      const birthReplay = event.lifecycle?.kind === "session.created" && record.witnesses?.some(witness => witness.kind === "created" && sameProof(witness.proof, event.lifecycle?.proof));
      if (own && event.shutdown || lifecycle && !birthReplay && (lifecycle === record.parent || lifecycle === basis.worker)) this.retire(record);
      // A shell birth is also a known execution contradiction, even when its
      // new scope is foreign. Only this occurrence's consumed canonical proof
      // (identity, stamp and semantic fingerprint) establishes an exact replay.
      else if (record.kind === "shell" && event.shellBirth?.id === basis.worker && (!own || event.shellBirth.parent !== record.parent
        || !record.witnesses?.some(witness => witness.kind === "created" && sameProof(witness.proof, event.shellBirth?.proof)))) this.retire(record);
      else if (own && event.userShell?.id === basis.worker && event.userShell.parent === record.parent && record.kind === "shell") this.retire(record);
      else if (own && event.execution && !event.execution.historical && event.session === basis.worker && record.kind === "agent") this.retire(record, event.execution.proof ? { kind: event.execution.phase, proof: event.execution.proof } : undefined);
      else if (own && event.session === record.parent) {
        if (event.launchers.some(fact => launcherChanged(fact, basis))) this.retire(record);
        else {
          const pending = event.launchers.filter(fact => !fact.historical && !basis.launches.some(launch => launch.call === fact.call)
            && (!fact.selectedOnly && fact.child === basis.worker || !fact.requestedSelectedOnly && fact.requestedChild === basis.worker));
          if (pending.length) this.put({ ...record, pending: true, pendingCalls: Object.freeze([...new Set([...(record.pendingCalls ?? []), ...pending.map(fact => fact.call)])]), changed: this.sequence });
        }
        if (report?.valid && report.status && report.worker === basis.worker && record.kind === (report.source === "shell" ? "shell" : "agent") && !this.historical("notification", reportProof)) this.retire(record, reportProof ? { kind: "notification", proof: reportProof } : undefined);
      }
      if (record.item && !this.current(record.taskId)) updates.push({ parent: record.parent, item: { ...structuredClone(record.item), stateUncertain: true } });
    }
    if (event.shutdown && own) for (const read of this.reads.values()) { read.failed = true; this.write(this.reads, read.id, read); }
    if (lifecycle) {
      const { proof, kind, parent, directory } = event.lifecycle!;
      updates.push(...this.note(JSON.stringify(["change", lifecycle, kind, proof]), { child: lifecycle, lifecycle: { kind, parent, directory, own },
        ...(proof ? { witness: { kind: "created", proof } } : {}) }));
    }
    if (!own) return updates;
    if (event.userShell) for (const [key, observation] of this.observations) {
      // A positive user-command transcript classifies this shell birth as
      // non-worker evidence. Do not accumulate one control entry per command.
      if (observation.lifecycle?.kind === "shell.created" && observation.child === event.userShell.id
        && observation.lifecycle.parent === event.userShell.parent) this.remove(this.observations, key);
    }
    if (event.shellBirth) updates.push(...this.note(JSON.stringify(["shell-birth", event.shellBirth.id, event.shellBirth.proof]), {
      child: event.shellBirth.id, lifecycle: { kind: "shell.created", parent: event.shellBirth.parent, directory: event.directory, own },
      commandFingerprint: event.shellBirth.commandFingerprint,
      ...(event.shellBirth.proof ? { witness: { kind: "created", proof: event.shellBirth.proof } } : {}),
    }));
    if (event.execution && !event.execution.historical && event.session) updates.push(...this.note(JSON.stringify(["change", event.session, event.execution.proof]), { child: event.session,
      ...(event.execution.proof ? { witness: { kind: event.execution.phase, proof: event.execution.proof } } : {}) }));
    if (event.session && report?.valid && report.status && report.worker && !report.userShell && !this.historical("notification", reportProof)) updates.push(...this.note(JSON.stringify(["report", event.session, report.worker, reportProof]), { parent: event.session, child: report.worker,
      ...(reportProof ? { witness: { kind: "notification", proof: reportProof } } : {}) }));
    if (event.session) for (const fact of event.launchers) if (!fact.historical) updates.push(...this.note(JSON.stringify([fact.phase === "called" ? "invocation" : "launch", event.session, fact.call, fact.child ?? fact.requestedChild ?? ""]), { parent: event.session, launch: fact, ...(fact.phase === "called" ? { calledAt: this.sequence } : {}) }));
    return updates;
  }
  private compatible(basis: WorkerOccurrenceEvidence, candidate: WorkerOccurrenceEvidence): boolean {
    return basis.parent === candidate.parent && basis.worker === candidate.worker && basis.taskId === candidate.taskId && !candidate.uncertain
      && !(basis.kind !== undefined && candidate.kind !== undefined && basis.kind !== candidate.kind)
      && !candidate.launches.some(fact => launcherChanged(fact, basis));
  }
  private identityAvailable(candidate: WorkerOccurrenceEvidence): boolean {
    return candidate.kind !== undefined && candidate.launches.length > 0
      && candidate.launches.every(launch => launch.workerType === candidate.kind && identity(launch.message)
        && launch.created !== undefined && launch.inputFingerprint !== undefined);
  }
  private matchesShellCommand(candidate: WorkerOccurrenceEvidence, command: string | undefined): boolean {
    return command !== undefined && candidate.launches.every(launch => launch.workerType === "shell" && launch.commandFingerprint !== undefined && launch.commandFingerprint === command);
  }
  private consumed(fact: LauncherEvidence, candidate: WorkerOccurrenceEvidence, witnesses: readonly ControlWitness[]): boolean {
    // Association proves a replay only while the invocation's immutable fields
    // agree. A stale snapshot must not launder contradictory input or clocks.
    return fact.phase === "called" && !!fact.proof && candidate.launches.some(launch => launch.call === fact.call)
      && !launcherChanged({ ...fact, phase: "snapshot", background: undefined }, candidate)
      && witnesses.some(witness => witness.kind === "called" && sameProof(witness.proof, fact.proof));
  }
  project(item: BackgroundTaskItem, candidate: WorkerOccurrenceEvidence | undefined, read?: ControlRead, witnesses: readonly ControlWitness[] = []): BackgroundTaskItem {
    const projected = this.projectEvidence(item, candidate, read, witnesses);
    return { ...projected, control: { available: projected.status === "running" && projected.stateUncertain !== true,
      ...(projected.stateUncertain ? { reason: "Worker control is unverified" } : {}) } };
  }
  private projectEvidence(item: BackgroundTaskItem, candidate: WorkerOccurrenceEvidence | undefined, read?: ControlRead, witnesses: readonly ControlWitness[] = []): BackgroundTaskItem {
    let record = this.records.get(item.taskId);
    if (item.status !== "running") {
      if (record) this.retire(record);
      else this.put({ parent: candidate?.parent ?? read?.parent ?? "", taskId: item.taskId, unavailable: true, aliases: candidate?.launches.map(launch => launch.call) });
      return { ...item, stateUncertain: false };
    }
    if (record?.unavailable) return { ...item, stateUncertain: true };
    if (this.gapSequence !== null && candidate?.kind === "shell" && candidate.launches.some(launch => launch.commandFingerprint === undefined)) return { ...item, stateUncertain: true };
    // Bind every alias to the native command before admission or enrichment.
    // A current same-ID shell and a live restatement of an old launcher are
    // insufficient when their canonical immutable commands contradict.
    if (candidate?.kind === "shell" && [...this.observations.values()].some(observation => observation.child === candidate.worker
      && observation.lifecycle?.kind === "shell.created" && observation.lifecycle.own && observation.lifecycle.parent === candidate.parent
      && observation.commandFingerprint !== undefined && candidate.launches.some(launch => launch.commandFingerprint !== undefined && launch.commandFingerprint !== observation.commandFingerprint))) {
      if (record) this.retire(record);
      else this.put({ parent: candidate.parent, taskId: item.taskId, unavailable: true, aliases: candidate.launches.map(launch => launch.call) });
      return { ...item, stateUncertain: true };
    }
    if (candidate) for (const other of this.records.values()) {
      if (other.taskId === item.taskId || other.parent !== candidate.parent
        || !candidate.launches.some(launch => other.aliases?.includes(launch.call) || other.evidence?.launches.some(prior => prior.call === launch.call))) continue;
      if (other.unavailable || !other.evidence) return { ...item, stateUncertain: true };
      if (other.evidence.worker !== candidate.worker || other.evidence.kind !== undefined && candidate.kind !== undefined && other.evidence.kind !== candidate.kind
        || candidate.launches.some(fact => launcherChanged(fact, other.evidence))) {
        this.retire(other);
        if (record) this.retire(record);
        else this.put({ parent: candidate.parent, taskId: item.taskId, unavailable: true, aliases: candidate.launches.map(launch => launch.call) });
        return { ...item, stateUncertain: true };
      }
      // Do not enrich another retained basis from a candidate whose own
      // identity is still unproven. Otherwise a missing alias owner becomes
      // frozen before later authoritative recovery can bind that owner.
      if (candidate.uncertain || !this.identityAvailable(candidate) || candidate.kind !== item.taskType) return { ...item, stateUncertain: true };
      const additional = candidate.launches.filter(fact => !other.evidence!.launches.some(prior => prior.call === fact.call));
      if (additional.length && (this.closed || this.scopes.get(other.parent) === "gap")) {
        this.retire(other);
        if (record) this.retire(record);
        return { ...item, stateUncertain: true };
      }
      if (additional.length) this.put({ ...other, evidence: Object.freeze({ ...other.evidence, launches: Object.freeze([...other.evidence.launches, ...additional]) }) });
      if (this.unavailable(other.taskId)) return { ...item, stateUncertain: true };
    }
    if (record?.evidence && candidate && !this.compatible(record.evidence, candidate)) { this.retire(record); return { ...item, stateUncertain: true }; }
    const uncertain = !candidate || !this.identityAvailable(candidate) || candidate.kind !== item.taskType || candidate.uncertain === true || item.stateUncertain === true || read?.failed === true;
    let unresolved = !record && read?.inventory === false && this.scopes.get(candidate?.parent ?? read.parent) === "partial";
    if (!record && candidate && this.gapSequence !== null) {
      // The native feed is live-only. A consumed birth in this covered cohort,
      // plus its exact live launcher, can prove a distinct future occurrence.
      // History, a snapshot alone and a pre-gap/replayed birth cannot do so.
      const born = [...this.observations.values()].some(observation => observation.seen! > this.gapSequence!
        && observation.child === candidate.worker && observation.lifecycle?.own && observation.lifecycle.parent === candidate.parent
        && observation.lifecycle.kind === (candidate.kind === "shell" ? "shell.created" : "session.created") && !!observation.witness
        && (candidate.kind !== "shell" || this.matchesShellCommand(candidate, observation.commandFingerprint)));
      const launched = candidate.launches.every(launch => [...this.observations.values()].some(observation => observation.seen! > this.gapSequence!
        && observation.parent === candidate.parent && observation.launch?.background === true && sameLauncherIdentity(observation.launch, launch)));
      unresolved = !born || !launched;
    }
    if (!record && candidate && read?.initialInventory !== undefined) {
      const startup = [...this.observations.values()].some(observation => observation.lifecycle?.kind === "session.created"
        && (observation.child === candidate.parent || observation.child === candidate.worker));
      if (!read.initialInventory || startup) unresolved ||= !candidate.launches.every(launch => [...this.observations.values()].some(observation => observation.parent === candidate.parent
        && observation.launch?.background === true && sameLauncherIdentity(observation.launch, launch)));
    }
    // Facts observed before Stop are just as binding as facts seen during its
    // reads. Compatible restatements cannot clear an unclassified invocation.
    if (candidate) for (const observation of this.observations.values()) {
      const fact = observation.launch;
      if (!fact || observation.parent !== candidate.parent) continue;
      if (this.consumed(fact, candidate, [...witnesses, ...(record?.witnesses ?? [])])) continue;
      const selected = candidate.launches.some(launch => launch.call === fact.call);
      if (!record && selected && candidate.launches.some(launch => this.initialDetachment(observation, launch))) { unresolved = true; continue; }
      if (selected && launcherChanged(fact, candidate)) {
        if (record) this.retire(record);
        else this.put({ parent: candidate.parent, taskId: item.taskId, unavailable: true, aliases: candidate.launches.map(launch => launch.call) });
        return { ...item, stateUncertain: true };
      }
      if (!selected && (!fact.selectedOnly && fact.child === candidate.worker || !fact.requestedSelectedOnly && fact.requestedChild === candidate.worker)) unresolved = true;
    }
    if (!record) {
      let revoked = candidate?.uncertain === true || this.closed || this.projectionLost || this.scopes.get(candidate?.parent ?? read?.parent ?? "") === "gap";
      const births: ControlWitness[] = [];
      const initialChild = candidate && [...this.observations.values()].some(observation => observation.child === candidate.worker
        && observation.lifecycle?.kind === "session.created" && observation.lifecycle.own && observation.lifecycle.parent === candidate.parent);
      if (candidate && !revoked) for (const observation of this.observations.values()) {
        if (observation.witness && observation.witness.kind !== "created" && (this.historical(observation.witness.kind, observation.witness.proof)
          || witnesses.some(witness => witness.kind === observation.witness!.kind && sameProof(witness.proof, observation.witness!.proof)))) continue;
        if (observation.child === candidate.worker || observation.child === candidate.parent) {
          if (observation.lifecycle?.kind === "shell.created" && observation.lifecycle.own && candidate.kind === "shell") {
            // Shell metadata associates the birth, never authorizes it. The
            // complete launcher and fresh owned shell inventory are required too.
            if (observation.lifecycle.parent !== candidate.parent || !observation.witness) unresolved = true;
            else if (this.gapSequence === null || observation.seen! > this.gapSequence && this.matchesShellCommand(candidate, observation.commandFingerprint)) births.push(observation.witness);
          } else if (observation.lifecycle?.kind === "session.created" && observation.lifecycle.own) {
            const birth = observation.witness?.proof;
            if (!observation.lifecycle.directory || birth?.created === undefined || candidate.launches.some(launch => launch.created === undefined)) unresolved = true;
            else if (candidate.launches.some(launch => launch.created! < birth.created! && (observation.child === candidate.parent
                || (launch.completed ?? launch.reportedCompletion) === undefined || birth.created! > (launch.completed ?? launch.reportedCompletion)!))
              || observation.child === candidate.worker && observation.lifecycle.parent !== candidate.parent) revoked = true;
            else if (observation.witness) {
              births.push(observation.witness);
              if (observation.child === candidate.worker && (!candidate.launches.every(launch => sameLauncherIdentity(launch, launch))
                || candidate.executionStart?.created === undefined || candidate.executionStart.created < birth.created!
                || !witnesses.some(witness => witness.kind === "started" && sameProof(witness.proof, candidate.executionStart)))) unresolved = true;
            }
          } else if (!observation.lifecycle && observation.child === candidate.parent) {
            // The parent's turn is not this independently running worker's execution.
          } else if (!observation.lifecycle && initialChild && observation.witness?.kind === "started") {
            // A history fold may overtake the initial live launch. Keep its
            // classification pending until that exact start binds the occurrence.
            unresolved = true;
          } else revoked = true;
        }
        const fact = observation.launch;
        if (fact && observation.parent === candidate.parent) {
          if (this.consumed(fact, candidate, witnesses)) continue;
          const selected = candidate.launches.some(launch => launch.call === fact.call);
          if (selected && candidate.launches.some(launch => this.initialDetachment(observation, launch))) { unresolved = true; continue; }
          if (selected && (launcherChanged(fact, candidate) || read && (observation.calledAt ?? -1) > read.start)) revoked = true;
          if (!selected && (!fact.selectedOnly && fact.child === candidate.worker || !fact.requestedSelectedOnly && fact.requestedChild === candidate.worker)) unresolved = true;
        }
      }
      if (revoked) this.put({ parent: candidate?.parent ?? read?.parent ?? "", taskId: item.taskId, unavailable: true, aliases: candidate?.launches.map(launch => launch.call) });
      else if (candidate && !uncertain && !unresolved) this.put({ parent: candidate.parent, taskId: item.taskId, kind: item.taskType === "shell" ? "shell" : "agent", item: structuredClone(item), evidence: candidate, witnesses: [...witnesses, ...births], changed: this.sequence });
    } else if (candidate && !uncertain) {
      const additional = candidate.launches.filter(fact => !record!.evidence!.launches.some(prior => prior.call === fact.call));
      // Additional aliases need coverage of their own. Space freed by terminal
      // compaction cannot prove a discarded invocation never referred to them.
      if (additional.length && (this.closed || this.scopes.get(record.parent) === "gap")) {
        this.retire(record);
        return { ...item, stateUncertain: true };
      }
      const unique = witnesses.filter(witness => !record!.witnesses?.some(prior => prior.kind === witness.kind && sameProof(prior.proof, witness.proof)));
      const resolved = record.pendingCalls?.length && record.pendingCalls.every(call => candidate.launches.some(launch => launch.call === call));
      this.put({ ...record, item: structuredClone(item), ...(record.pending && resolved && !unresolved ? { pending: undefined, pendingCalls: undefined, changed: this.sequence } : {}),
        evidence: additional.length ? Object.freeze({ ...record.evidence!, launches: Object.freeze([...record.evidence!.launches, ...additional]) }) : record.evidence,
        witnesses: unique.length ? [...(record.witnesses ?? []), ...unique] : record.witnesses });
    }
    record = this.records.get(item.taskId);
    return { ...item, stateUncertain: uncertain || unresolved || !record || !!record.unavailable || !!record.pending };
  }
  clear(): void {
    this.scopes.clear(); this.records.clear(); this.reads.clear(); this.observations.clear(); this.sizes.clear(); this.tupleBytes = this.entryCount = 0;
    this.closed = this.projectionLost = false;
    this.gapSequence = null;
  }
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

/** V2 worker facts, separate from the successful tool which launched them.
 * Session parentage is established by a scoped session record, never by text.
 * This projection is disposable; complete provider history reconstructs it.
 */
export class BackgroundWorkers {
  private recoveryOnly = false;
  constructor(private readonly budget: { entries?: number; bytes?: number; retained?: () => { bytes: number; entries: number }; onSaturation?: () => void;
    /** Complete, verified child execution history for a transient history fold.
     * Group occurrences before later idle boundaries revoke unresolved work.
     * Boundary order is irrelevant: consumers scan predicates, not positions. */
    executionHistory?: ReadonlyMap<string, readonly number[]>;
  } = {}) {}
  private readonly parents = new Map<string, string>();
  private readonly births = new Map<string, { parent: string; proof: NativeProof; shellCommand?: string; shellEnd?: NativeProof }>();
  private readonly tasks = new Map<string, WorkerTask>();
  private readonly notices = new Map<string, { proof?: NativeProof; occurrence?: string; discarded?: { parent: string; worker: string; at?: number } }>();
  private readonly invocations = new Map<string, { fact: LauncherEvidence; occurrence?: string }>();
  private readonly terminalProofs = new Map<string, { proof?: NativeProof; shellExit?: NativeProof; occurrences: readonly string[]; started?: { proof: NativeProof; occurrence?: string; pending?: string } }>();
  private readonly unmatched = new Map<string, { parent: string; worker: string; item: BackgroundTaskItem; correlatable: boolean; published: boolean }>();
  private readonly ended = new Map<string, number[]>();
  private readonly aliases = new Map<string, string>();
  private readonly userShells = new Map<string, true>();
  // Empty outer array and ten collections. Each retained entry adds its
  // complete serialized tuple plus a conservative comma allowance.
  private bytes = 62;
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

  private notice(key: string, proof?: NativeProof, occurrence?: string): void {
    this.set(this.notices, key, { proof, occurrence });
  }

  /** Typed session.shell.* describes a user command, never a worker birth.
   * The small classification pool is disposable, not Stop authorization.
   */
  observeUserShell(parent: string, worker: string): void {
    if (!identity(parent) || !identity(worker)) return;
    this.set(this.userShells, JSON.stringify([parent, worker]), true);
    while (this.userShells.size > 128 || [...(this.sizes.get(this.userShells)?.values() ?? [])].reduce((sum, bytes) => sum + bytes, 0) > 64 * 1024) {
      const key = this.userShells.keys().next().value!;
      this.userShells.delete(key);
      if (!this.unlimited) this.account(this.userShells, key, 0);
    }
    this.bound();
  }

  isUserShell(parent: string, worker: string): boolean {
    return this.userShells.has(JSON.stringify([parent, worker]))
      && ![...this.tasks.values()].some(task => task.parent === parent && task.worker === worker && task.item.taskType === "shell");
  }

  private trimUnpublished(): void {
    if (this.unlimited) return;
    const pending = [...this.unmatched].filter(([, report]) => !report.published && report.item.taskType === "shell");
    let bytes = pending.reduce((sum, [key]) => sum + (this.sizes.get(this.unmatched)?.get(key) ?? 0), 0);
    let count = pending.length;
    for (const [key, report] of pending) {
      if (count <= 128 && bytes <= 256 * 1024) break;
      bytes -= this.sizes.get(this.unmatched)?.get(key) ?? 0; count--;
      this.unmatched.delete(key); this.account(this.unmatched, key, 0);
      // Drop only presentation. Keep the native replay tombstone and enough
      // negative evidence to prevent this result authorizing/settling a run.
      this.set(this.notices, key, { ...this.notices.get(key), discarded: { parent: report.parent, worker: report.worker,
        ...(report.item.terminalReportedAt === undefined ? {} : { at: report.item.terminalReportedAt }) } });
    }
  }

  evidenceSnapshot(): ReadonlyMap<string, WorkerOccurrenceEvidence> {
    return new Map([...this.tasks].map(([id, task]) => [id, task.evidence]));
  }

  private retainedTask(taskId: string): WorkerTask | undefined {
    return this.tasks.get(taskId) ?? this.tasks.get(this.aliases.get(taskId) ?? "");
  }

  private matchingTask(candidate: WorkerOccurrenceEvidence): WorkerTask | undefined {
    if (!candidate.launches.some(launch => candidate.taskId === `v2:${candidate.parent}:${launch.call}`)) return;
    const direct = this.retainedTask(candidate.taskId);
    if (direct?.evidence === candidate) return direct;
    const related = new Map<string, WorkerTask>();
    for (const launch of candidate.launches) {
      const task = this.retainedTask(`v2:${candidate.parent}:${launch.call}`);
      if (task && task.parent === candidate.parent && task.worker === candidate.worker && task.evidence.kind === candidate.kind) related.set(task.item.taskId, task);
    }
    if (related.size !== 1) return;
    const task = related.values().next().value!;
    const launches = new Map(candidate.launches.map(launch => [launch.call, launch]));
    // Transferring occurrence evidence requires the complete compatible native
    // alias set, not one surviving anchor among contradictory or missing ones.
    // Confidence/ownership may be lost without changing this historical identity.
    if (launches.size !== candidate.launches.length || launches.size !== task.evidence.launches.length
      || !task.evidence.launches.every(retained => {
        const launch = launches.get(retained.call);
        return launch !== undefined && sameLauncherIdentity(retained, launch);
      }) || candidate.executionStart && task.evidence.executionStart && !sameProof(candidate.executionStart, task.evidence.executionStart)
      || candidate.executionEnd && task.evidence.executionEnd && !sameProof(candidate.executionEnd, task.evidence.executionEnd)) return;
    return task;
  }

  /** A retained native call reference also fences cold admission when its
   * immutable facts contradict. It supplies no positive activity or clocks. */
  hasRetainedReference(candidate: WorkerOccurrenceEvidence): boolean {
    return candidate.launches.some(launch => {
      const task = this.retainedTask(`v2:${candidate.parent}:${launch.call}`);
      return task?.parent === candidate.parent;
    });
  }

  // Control projection retains its canonical-ID semantics. Activity lookups
  // below resolve proven aliases separately, without substituting Stop bases.
  occurrence(taskId: string): WorkerOccurrenceEvidence | undefined { return this.tasks.get(taskId)?.evidence; }

  /** Activity uses the scoped projection, never the Stop ledger. */
  activityEvidence(candidate: WorkerOccurrenceEvidence): WorkerOccurrenceEvidence | undefined {
    const live = this.matchingTask(candidate)?.evidence;
    if (this.recoveryOnly || !live || live.kind !== "shell" && this.parents.get(live.worker) !== live.parent
      || live.parent !== candidate.parent || live.worker !== candidate.worker || live.kind !== candidate.kind) return;
    if ([...this.invocations.values()].some(invocation => invocation.occurrence !== live.key
      && (!invocation.fact.requestedSelectedOnly && invocation.fact.requestedChild === live.worker
        || !invocation.fact.child && !invocation.fact.requestedChild && invocation.fact.workerType === live.kind
          && live.launches.some(launch => launch.message !== undefined && launch.message === invocation.fact.message)))) return;
    const birth = this.births.get(live.worker);
    if (live.kind === "shell" && this.terminalProofs.get(live.worker)?.shellExit) return;
    if (birth?.shellCommand && !live.launches.every(launch => launch.commandFingerprint === birth.shellCommand)) return;
    if (live.kind === "agent" && birth && !live.launches.every(launch => launch.created !== undefined && birth.proof.created !== undefined
      && ((launch.completed ?? launch.reportedCompletion) === undefined
        || birth.proof.created <= (launch.completed ?? launch.reportedCompletion)!))) return;
    if (live.executionStart) {
      const start = live.executionStart.created;
      if (start === undefined || !live.launches.every(launch => {
        const accepted = launch.completed ?? launch.reportedCompletion;
        return launch.created !== undefined && start >= launch.created
          && (birth ? birth.parent === live.parent && birth.proof.created !== undefined
            && (accepted === undefined || birth.proof.created <= accepted) && start >= birth.proof.created
            : accepted === undefined || start <= accepted);
      })) return;
    }
    return live;
  }

  childTasks(child: string): Array<{ parent: string; item: BackgroundTaskItem }> {
    return [...this.tasks.values()].filter(task => task.worker === child).map(task => ({ parent: task.parent, item: task.item }));
  }

  rememberActivity(taskId: string, activity: NonNullable<BackgroundTaskItem["activity"]>, candidate?: WorkerOccurrenceEvidence): void {
    const task = candidate ? this.matchingTask(candidate) : this.retainedTask(taskId);
    if (!task || this.recoveryOnly) return;
    this.set(this.tasks, task.item.taskId, { ...task, item: { ...task.item, activity } });
    this.bound();
  }

  lastActivity(taskId: string, candidate?: WorkerOccurrenceEvidence): BackgroundTaskItem["activity"] {
    return (candidate ? this.matchingTask(candidate) : this.retainedTask(taskId))?.item.activity;
  }

  observeRequestTool(child: string, source: WorkerRequestSource, proof?: NativeProof): void {
    if (this.recoveryOnly || !identity(source.message) || !identity(source.tool) || !proof || proof.aggregate !== child || proof.seq === undefined) return;
    const tasks = [...this.tasks.values()].filter(task => task.worker === child && task.item.status === "running" && task.item.taskType === "agent"
      && !task.evidence.uncertain && !task.evidence.executionEnd && task.evidence.executionStart && this.activityEvidence(task.evidence));
    const task = tasks.length === 1 ? tasks[0] : undefined;
    const start = task?.evidence.executionStart;
    if (!task || !start || start.aggregate !== child || start.seq === undefined || proof.seq <= start.seq
      || task.evidence.uncertain || task.evidence.executionEnd || !this.activityEvidence(task.evidence)) return;
    const tools = task.requestTools ?? [];
    if (tools.some(tool => tool.source.message === source.message && tool.source.tool === source.tool)) return;
    // A bounded proof window, not a session-wide request index. Older tools can
    // remain canonical cards but cannot acquire a new worker association.
    this.set(this.tasks, task.item.taskId, { ...task, requestTools: [...tools.slice(-7), { source, proof, execution: start }] });
    this.bound();
  }

  linkRequest(child: string, id: string, kind: "permission" | "question", source: WorkerRequestSource): boolean {
    if (this.recoveryOnly || !identity(id) || !identity(source.message) || !identity(source.tool)) return false;
    const tasks = [...this.tasks.values()].filter(task => task.worker === child && task.item.status === "running" && task.item.taskType === "agent"
      && !task.evidence.uncertain && !task.evidence.executionEnd && task.evidence.executionStart && this.activityEvidence(task.evidence));
    const task = tasks.length === 1 ? tasks[0] : undefined;
    const start = task?.evidence.executionStart;
    const tool = task?.requestTools?.find(tool => tool.source.message === source.message && tool.source.tool === source.tool && sameProof(tool.execution, start));
    if (!task || !start || !tool || task.requestsClosed || task.resolvedRequests?.some(request => request.id === id && request.kind === kind)
      || task.evidence.uncertain || task.evidence.executionEnd || !this.activityEvidence(task.evidence)
      || task.request && (task.request.id !== id || task.request.kind !== kind)) return false;
    this.set(this.tasks, task.item.taskId, { ...task, request: { id, kind, source, execution: start, proof: tool.proof } });
    this.bound();
    return !this.recoveryOnly;
  }

  linkedRequest(taskId: string, candidate?: WorkerOccurrenceEvidence): { id: string; kind: "permission" | "question" } | undefined {
    const task = candidate ? this.matchingTask(candidate) : this.retainedTask(taskId), request = task?.request;
    if (candidate && !this.activityEvidence(candidate)) return;
    if (!task || !request || task.item.status !== "running" || task.evidence.uncertain || task.evidence.executionEnd
      || !sameProof(request.execution, task.evidence.executionStart) || !this.activityEvidence(task.evidence)) return;
    if (request.proof.aggregate !== task.worker || request.proof.seq === undefined || request.execution.seq === undefined
      || request.proof.seq <= request.execution.seq) return;
    return { id: request.id, kind: request.kind };
  }

  resolveRequest(id: string, kind: "permission" | "question", child?: string): string[] {
    const changed: string[] = [];
    for (const task of this.tasks.values()) if (task.worker === child && task.request?.id === id && task.request.kind === kind) {
      const resolved = task.resolvedRequests ?? [];
      this.set(this.tasks, task.item.taskId, { ...task, request: undefined,
        ...(resolved.length >= 16 ? { requestsClosed: true as const } : { resolvedRequests: [...resolved, { id, kind }] }) });
      changed.push(task.worker);
    }
    return changed;
  }

  invalidateActivity(worker?: string): void {
    for (const task of this.tasks.values()) if (worker === undefined || task.worker === worker || task.parent === worker) this.uncertain(task);
  }

  shellActivity(occurrence: WorkerOccurrenceEvidence): boolean {
    const birth = this.births.get(occurrence.worker);
    return occurrence.kind === "shell" && !occurrence.uncertain && !birth?.shellEnd && !occurrence.executionEnd && !!birth?.shellCommand
      && birth.parent === occurrence.parent && occurrence.launches.every(launch => launch.commandFingerprint === birth.shellCommand);
  }

  shellEnded(worker: string, proof?: NativeProof): void {
    if (this.recoveryOnly || !identity(worker) || !proof) return;
    const tasks = [...this.tasks.values()].filter(task => task.worker === worker && task.item.taskType === "shell");
    const task = tasks.length === 1 ? tasks[0] : undefined;
    const birth = this.births.get(worker);
    if (birth && proof.created !== undefined && birth.proof.created !== undefined && proof.created >= birth.proof.created) {
      const matched = task && this.shellActivity(task.evidence);
      if (!birth.shellEnd) this.set(this.births, worker, { ...birth, shellEnd: proof });
      if (matched) this.set(this.tasks, task.item.taskId, { ...task, evidence: Object.freeze({ ...task.evidence, executionEnd: proof }) });
    } else if (!birth) {
      this.set(this.terminalProofs, worker, { ...(this.terminalProofs.get(worker) ?? { occurrences: [] }), shellExit: proof });
    }
    this.bound();
  }

  controlWitnesses(taskId: string): ControlWitness[] {
    const evidence = this.tasks.get(taskId)?.evidence;
    if (!evidence) return [];
    const witnesses: ControlWitness[] = [];
    for (const invocation of this.invocations.values()) if (invocation.occurrence === evidence.key && invocation.fact.proof) witnesses.push({ kind: "called", proof: invocation.fact.proof });
    if (evidence.executionStart) witnesses.push({ kind: "started", proof: evidence.executionStart });
    if (evidence.executionEnd) witnesses.push({ kind: "ended", proof: evidence.executionEnd });
    for (const notice of this.notices.values()) if (notice.occurrence === evidence.key && notice.proof) witnesses.push({ kind: "notification", proof: notice.proof });
    return witnesses;
  }

  enforceBudget(): void { this.bound(); }

  // Recovery can rebuild presentation after saturation, but cannot prove that
  // a discarded contradiction never referred to the requested old identity.
  get controlEvidenceAvailable(): boolean { return !this.recoveryOnly; }

  /** Negative facts revoke a known occurrence without proving a new target's
   * ownership or requiring a successful background launch/projection update.
   */
  observeLauncher(parent: string, fact: LauncherEvidence): void {
    if (this.recoveryOnly || !identity(parent) || !identity(fact.call)) return;
    const callKey = `v2:${parent}:${fact.call}`;
    const known = this.tasks.get(this.aliases.get(callKey) ?? callKey);
    if (known && launcherChanged(fact, known.evidence)) this.uncertain(known);
    this.bound();
  }

  invocationReplay(parent: string, fact: LauncherEvidence): boolean {
    const prior = this.invocations.get(`${parent}:${fact.call}`);
    return !!prior?.occurrence && sameProof(prior.fact.proof, fact.proof);
  }

  invocation(parent: string, fact: LauncherEvidence): void {
    if (this.recoveryOnly || !identity(parent) || !identity(fact.call) || this.invocationReplay(parent, fact)) return;
    if (fact.selectedOnly && fact.workerType !== "shell") return;
    for (const task of this.tasks.values()) if (task.parent === parent && task.evidence.launches.some(launch => launch.call === fact.call)) this.uncertain(task);
    this.set(this.invocations, `${parent}:${fact.call}`, { fact });
    this.bound();
  }

  terminalReplay(child: string, proof?: NativeProof): boolean {
    const previous = this.terminalProofs.get(child);
    return !!previous?.occurrences.length && sameProof(previous.proof, proof)
      || [...this.tasks.values()].some(task => task.worker === child && sameProof(task.evidence.executionEnd, proof));
  }

  startReplay(child: string, proof?: NativeProof): boolean {
    const previous = this.terminalProofs.get(child)?.started;
    return !!(previous?.occurrence || previous?.pending) && sameProof(previous.proof, proof)
      || [...this.tasks.values()].some(task => task.worker === child && sameProof(task.evidence.executionStart, proof));
  }

  executionStarted(child: string, proof?: NativeProof): void {
    if (this.recoveryOnly || !identity(child) || this.startReplay(child, proof)) return;
    const birth = this.births.get(child), previous = this.terminalProofs.get(child);
    const candidates = [...this.tasks.values()].filter(task => task.worker === child && task.item.taskType === "agent");
    const initial = candidates.length === 1 ? candidates[0] : undefined;
    // Only a covered newborn's first execution can enrich a pending launch.
    // A reused session, competing invocation or prior boundary remains a veto.
    if (initial && birth && proof?.created !== undefined && birth.proof.created !== undefined
      && !previous && !initial.evidence.uncertain && this.parents.get(child) === birth.parent && initial.parent === birth.parent
      && proof.created >= birth.proof.created && initial.evidence.launches.every(launch => (launch.created === undefined || launch.created <= birth.proof.created!)
        && (launch.completed ?? launch.reportedCompletion) !== undefined && birth.proof.created! <= (launch.completed ?? launch.reportedCompletion)!)
      && ![...this.invocations.values()].some(invocation => invocation.fact.requestedChild === child && invocation.occurrence !== initial.evidence.key)) {
      this.set(this.terminalProofs, child, { occurrences: [], started: { proof, pending: initial.evidence.key } });
      this.bindInitialStart(initial);
      this.bound();
      return;
    }
    if (proof) this.set(this.terminalProofs, child, { ...(this.terminalProofs.get(child) ?? { occurrences: [] }), started: { proof } });
    for (const task of this.tasks.values()) if (task.worker === child && task.item.taskType === "agent" && task.item.status === "running") this.uncertain(task, false);
    this.bound();
  }

  private bindInitialStart(task: { parent: string; worker: string; item: BackgroundTaskItem; evidence: WorkerOccurrenceEvidence }): void {
    const boundary = this.terminalProofs.get(task.worker), start = boundary?.started, birth = this.births.get(task.worker);
    if (!start?.pending || start.pending !== task.evidence.key || boundary?.proof || this.ended.has(task.worker)
      || task.evidence.uncertain || task.item.status !== "running" || !birth || birth.parent !== task.parent
      || this.parents.get(task.worker) !== task.parent || birth.proof.created === undefined || start.proof.created === undefined
      || start.proof.created < birth.proof.created
      || [...this.tasks.values()].filter(other => other.worker === task.worker && other.item.taskType === "agent").length !== 1
      || !task.evidence.launches.every(launch => launch.created !== undefined && launch.created <= birth.proof.created!
        && (launch.completed ?? launch.reportedCompletion) !== undefined && birth.proof.created! <= (launch.completed ?? launch.reportedCompletion)!)
      || [...this.invocations.values()].some(invocation => invocation.occurrence !== task.evidence.key
        && (!invocation.fact.requestedSelectedOnly && invocation.fact.requestedChild === task.worker
          || !invocation.fact.child && !invocation.fact.requestedChild && invocation.fact.workerType === task.evidence.kind
            && task.evidence.launches.some(launch => launch.message !== undefined && launch.message === invocation.fact.message)))) return;
    task.evidence = Object.freeze({ ...task.evidence, executionStart: start.proof });
    this.set(this.tasks, task.item.taskId, task);
    this.set(this.terminalProofs, task.worker, { ...boundary!, started: { proof: start.proof, occurrence: task.evidence.key } });
  }

  notificationReplay(parent: string, id: string, proof?: NativeProof): boolean {
    const previous = this.notices.get(`${parent}:${id}`);
    return !!previous?.occurrence && sameProof(previous.proof, proof);
  }

  observeNotification(parent: string, id: string, prepared: PreparedNotification | undefined, proof?: NativeProof): void {
    if (this.recoveryOnly || !prepared?.valid || !prepared.status || this.notificationReplay(parent, id, proof)) return;
    for (const task of this.tasks.values()) if (task.parent === parent && task.worker === prepared.worker
      && task.item.taskType === (prepared.source === "shell" ? "shell" : "agent") && task.item.status === "running") this.uncertain(task, false);
    this.bound();
  }

  private uncertain(task: { parent: string; worker: string; item: BackgroundTaskItem; evidence: WorkerOccurrenceEvidence }, publish = true): void {
    if (publish) task.item = { ...task.item, stateUncertain: true };
    task.evidence = Object.freeze({ ...task.evidence, uncertain: true });
    this.set(this.tasks, task.item.taskId, task);
  }

  /** Revoke verified edges touching this child or parent, or all edges when
   * omitted. Retain occurrence evidence and the recovery-only latch; callers
   * must verify current ownership again before trusting subsequent agent facts.
   */
  invalidateOwnership(sessionId?: string): void {
    for (const [child, parent] of this.parents) {
      if (sessionId !== undefined && child !== sessionId && parent !== sessionId) continue;
      this.parents.delete(child);
      if (!this.unlimited) this.account(this.parents, child, 0);
    }
  }

  verifyChild(child: string, parent: string): void {
    if (this.recoveryOnly || !identity(child) || !identity(parent)) return;
    this.set(this.parents, child, parent);
    this.bound();
  }

  observeBirth(child: string, parent: string, proof?: NativeProof, shellCommand?: string): void {
    if (this.recoveryOnly || !identity(child) || !identity(parent) || !proof) return;
    if (sameProof(this.births.get(child)?.proof, proof)) return;
    for (const task of this.tasks.values()) if (task.worker === child) this.uncertain(task);
    if (!this.births.has(child) && !this.terminalProofs.has(child) && ![...this.tasks.values()].some(task => task.worker === child)) {
      this.set(this.births, child, { parent, proof, shellCommand });
      this.bound();
    }
  }

  executionEnded(child: string, at: number, proof?: NativeProof): void {
    if (this.recoveryOnly || !this.parents.has(child)) return;
    if (this.terminalReplay(child, proof)) return;
    if (proof) this.set(this.terminalProofs, child, { ...this.terminalProofs.get(child), proof, occurrences: Object.freeze([...this.tasks.values()].filter(task => task.worker === child && task.item.taskType === "agent").map(task => task.evidence.key)) });
    for (const task of this.tasks.values()) if (task.worker === child && task.item.taskType === "agent" && task.item.status === "running") {
      if (proof && !task.evidence.uncertain && task.evidence.executionStart && !task.evidence.executionEnd) task.evidence = Object.freeze({ ...task.evidence, executionEnd: proof });
      this.uncertain(task, false);
    }
    const boundaries = this.ended.get(child) ?? [];
    if (boundaries.includes(at)) { this.bound(); return; }
    boundaries.push(at);
    this.boundaries++;
    this.set(this.ended, child, boundaries);
    this.bound();
  }

  /** End the transient history fold without treating an idle as a result. */
  finishHistory(): NormalizedProviderUpdate[] {
    if (!this.budget.executionHistory) return [];
    const updates: NormalizedProviderUpdate[] = [];
    for (const task of this.tasks.values()) if (task.item.taskType === "agent" && task.item.status === "running"
      && this.ended.get(task.worker)?.some(end => end >= task.item.createdAt)) {
      this.uncertain(task);
      updates.push({ kind: "upsert", item: task.item });
    }
    return updates;
  }

  private admissionWindow(launch: LauncherEvidence): { start: number; end: number } | undefined {
    const start = launch.ran ?? launch.created, end = launch.completed ?? launch.reportedCompletion;
    // tool.called precedes permission approval; tool success bounds admission
    // from above. Neither clock is an exact child job-start timestamp.
    if (start !== undefined && end !== undefined && start >= 0 && end > start) return { start, end };
  }

  private historicalAdmission(child: string, launch: LauncherEvidence): { start: number; end: number } | undefined {
    const ends = this.budget.executionHistory?.get(child), window = this.admissionWindow(launch);
    return ends !== undefined && window && !ends.some(end => end >= window.start && end <= window.end) ? window : undefined;
  }

  private sameHistoricalInterval(child: string, previous: LauncherEvidence, next: LauncherEvidence): boolean {
    if (!this.budget.executionHistory) return true;
    const ends = this.budget.executionHistory.get(child), left = this.historicalAdmission(child, previous), right = this.historicalAdmission(child, next);
    return ends !== undefined && left !== undefined && right !== undefined && left.start !== right.start
      && !ends.some(end => end >= Math.min(left.start, right.start) && end <= Math.max(left.end, right.end));
  }

  private separateHistoricalIntervals(child: string, previous: LauncherEvidence, next: LauncherEvidence): boolean {
    const ends = this.budget.executionHistory?.get(child), left = this.historicalAdmission(child, previous), right = this.historicalAdmission(child, next);
    return ends !== undefined && left !== undefined && right !== undefined
      && ends.some(end => end > left.end && end < right.start || end > right.end && end < left.start);
  }

  private historicalReportCompatible(child: string, launches: readonly LauncherEvidence[], at?: number): boolean {
    if (!this.budget.executionHistory) return true;
    return at !== undefined && launches.every(launch => {
      // A unique explicit report can settle a legacy clock-sparse launch, but
      // cannot contradict a known acceptance bound or an ambiguous window.
      // Missing bounds never supply the separate positive proof for aliasing.
      if (launch.completed === undefined && launch.reportedCompletion === undefined) return true;
      const window = this.admissionWindow(launch);
      return window !== undefined && at > window.end
        && !this.ended.get(child)?.some(end => end >= window.start && end <= window.end);
    });
  }

  launch(parent: string, value: unknown, at: number): NormalizedProviderUpdate[] {
    return this.launchPrepared(parent, prepareTool(value, at), at);
  }

  launchPrepared(parent: string, prepared: PreparedTool, at: number): NormalizedProviderUpdate[] {
    if (this.recoveryOnly) return [];
    this.observeLauncher(parent, prepared.fact);
    if (this.recoveryOnly) return [];
    const result = this.foldLaunch(parent, prepared, at);
    this.bound();
    return result;
  }

  private foldLaunch(parent: string, prepared: PreparedTool, at: number): NormalizedProviderUpdate[] {
    const { fact, name } = prepared;
    const call = fact.call, child = fact.child, shell = name === "shell";
    if ((!shell && name !== "subagent") || !identity(call) || !identity(child) || !identity(parent) || (!shell && this.parents.get(child) !== parent) || fact.background !== true) return [];
    const callKey = `v2:${parent}:${call}`;
    if (!identity(`task:${callKey}`)) return [];
    const taskId = this.aliases.get(callKey) ?? callKey;
    const known = this.tasks.get(taskId);
    if (known) {
      if (!launcherChanged(fact, known.evidence)) {
        known.evidence = Object.freeze({ ...known.evidence, launches: Object.freeze(known.evidence.launches.map(launch =>
          launch.call === fact.call ? retainLauncherEvidence(launch, fact) : launch)) });
        this.set(this.tasks, taskId, known);
        this.bindInitialStart(known);
      }
      return [{ kind: "upsert", item: known.item }];
    }
    const invocation = this.invocations.get(`${parent}:${call}`);
    const startedAt = fact.ran ?? fact.created ?? at;
    const shared = [...this.tasks.values()].find(task => {
      const sameWorkerScope = task.parent === parent && task.worker === child && task.item.taskType === (shell ? "shell" : "agent");
      if (!sameWorkerScope) return false;
      const certainRunningOccurrence = task.item.status === "running" && !task.evidence.uncertain;
      if (!certainRunningOccurrence) return false;
      const sameInterval = shell || task.evidence.launches.every(launch => this.sameHistoricalInterval(child, launch, fact));
      if (!sameInterval) return false;
      const interveningIdle = this.ended.get(child)?.some(end => end >= task.item.createdAt && end < startedAt);
      return !interveningIdle;
    });
    if (shared) {
      if (invocation) this.set(this.invocations, `${parent}:${call}`, { ...invocation, occurrence: shared.evidence.key });
      this.set(this.aliases, callKey, shared.item.taskId);
      shared.item = { ...shared.item, toolUseIds: [...(shared.item.toolUseIds ?? [shared.item.toolUseId!]), call] };
      shared.evidence = Object.freeze({ ...shared.evidence, launches: Object.freeze([...shared.evidence.launches, fact]) });
      this.set(this.tasks, shared.item.taskId, shared);
      return [{ kind: "upsert", item: shared.item }];
    }
    const item: BackgroundTaskItem = {
      id: `task:${taskId}`, type: "background_task", taskId,
      createdAt: startedAt,
      toolUseId: call, ...(shell ? { outputFile: `shell:${child}` } : { childConversationId: child }), taskType: shell ? "shell" : "agent",
      description: prepared.description ?? "Background worker",
      ...(prepared.agent ? { subagentType: prepared.agent } : {}),
      ...(prepared.prompt ? { prompt: prepared.prompt } : {}),
      status: "running",
      ...(!this.budget.executionHistory?.has(child) && this.ended.get(child)?.some(end => end >= startedAt) || [...this.notices.values()].some(notice => notice.discarded?.parent === parent
        && notice.discarded.worker === child && (notice.discarded.at === undefined || notice.discarded.at >= startedAt)) ? { stateUncertain: true } : {}),
    };
    const superseded: NormalizedProviderUpdate[] = [];
    for (const previous of this.tasks.values()) {
      if (previous.parent !== parent || previous.worker !== child || previous.item.taskType !== item.taskType || previous.item.status !== "running") continue;
      // Content can interleave executions. Preserve a proven other interval
      // so its later aliases can still join it before explicit results arrive.
      const provenSeparateInterval = !shell && previous.evidence.launches.every(launch => this.separateHistoricalIntervals(child, launch, fact));
      if (provenSeparateInterval) continue;
      this.uncertain(previous);
      superseded.push({ kind: "upsert", item: previous.item });
    }
    const started = !shell ? this.terminalProofs.get(child)?.started : undefined;
    const evidence: WorkerOccurrenceEvidence = Object.freeze({ key: digest(JSON.stringify([parent, child, taskId, fact.workerType, fact.message, fact.created, fact.ran, fact.completed, fact.reportedCompletion])), parent, worker: child, kind: fact.workerType, taskId, launches: Object.freeze([fact]),
      ...(started && !started.occurrence ? { executionStart: started.proof } : {}), ...(item.stateUncertain ? { uncertain: true } : {}) });
    if (started && !started.occurrence) this.set(this.terminalProofs, child, { ...this.terminalProofs.get(child)!, started: { ...started, occurrence: evidence.key } });
    if (invocation) this.set(this.invocations, `${parent}:${call}`, { ...invocation, occurrence: evidence.key });
    this.set(this.tasks, taskId, { parent, worker: child, item, evidence });
    if (shell && this.births.get(child)?.shellEnd) {
      const birth = this.births.get(child)!;
      if (birth.parent === parent && fact.commandFingerprint === birth.shellCommand) this.set(this.tasks, taskId,
        { parent, worker: child, item, evidence: Object.freeze({ ...evidence, executionEnd: birth.shellEnd }) });
    }
    const reports = [...this.unmatched.entries()].filter(([, result]) => result.parent === parent && result.worker === child && result.item.taskType === item.taskType);
    const pending = reports.filter(([, result]) => result.correlatable && result.item.createdAt >= item.createdAt
      && (shell || this.historicalReportCompatible(child, [fact], result.item.terminalReportedAt)));
    // Shell reports alone cannot establish background membership. Once a
    // scoped launch proves it, reveal any reports which cannot safely join it.
    const revealed: NormalizedProviderUpdate[] = [];
    for (const [key, result] of reports) {
      if (result.published || pending.length === 1 && pending[0]![0] === key) continue;
      this.set(this.unmatched, key, { ...result, published: true });
      revealed.push({ kind: "upsert", item: result.item });
    }
    if (pending.length === 1) {
      const [key, result] = pending[0]!;
      this.unmatched.delete(key);
      if (!this.unlimited) this.account(this.unmatched, key, 0);
      const settled = { ...item, status: result.item.status, summary: result.item.summary, resultId: result.item.resultId,
        ...(result.item.terminalReportedAt === undefined ? {} : { terminalReportedAt: result.item.terminalReportedAt }) };
      this.set(this.tasks, taskId, { parent, worker: child, item: settled, evidence });
      return [...superseded, ...revealed, ...(result.published ? [{ kind: "remove" as const, itemId: result.item.id }] : []), { kind: "upsert", item: settled }];
    }
    return [...superseded, ...revealed, { kind: "upsert", item }];
  }

  content(parent: string, content: unknown, at: number): NormalizedProviderUpdate[] {
    return array(content).flatMap(part => this.launch(parent, part, at));
  }

  // `at` also positions/correlates a row. Pass null when it is only a display
  // fallback, not a provider report clock (including stored missing-time 0).
  notification(parent: string, id: string, payload: unknown, at: number, terminalReportedAt: number | null = at, proof?: NativeProof): NormalizedProviderUpdate[] | undefined {
    return this.notificationPrepared(parent, id, prepareNotification(payload), at, terminalReportedAt, proof);
  }

  notificationPrepared(parent: string, id: string, prepared: PreparedNotification | undefined, at: number, terminalReportedAt: number | null = at, proof?: NativeProof): NormalizedProviderUpdate[] | undefined {
    if (this.recoveryOnly) {
      return prepared ? [] : undefined;
    }
    this.observeNotification(parent, id, prepared, proof);
    if (this.recoveryOnly) return prepared ? [] : undefined;
    if (prepared?.userShell && prepared.worker && this.isUserShell(parent, prepared.worker)) return [];
    const result = prepared ? this.foldNotification(parent, id, prepared, at, terminalReportedAt, proof) : undefined;
    this.bound();
    return result;
  }

  private foldNotification(parent: string, id: string, prepared: PreparedNotification, at: number, terminalReportedAt: number | null, proof?: NativeProof): NormalizedProviderUpdate[] | undefined {
    const shell = prepared.source === "shell", child = prepared.worker;
    if (!prepared.valid || !identity(child) || !identity(parent) || !identity(id) || !identity(`task:v2:${parent}:notification:${id}`) || (!shell && this.parents.get(child) !== parent)) return;
    // Unclassified shell notes wait silently for a matching background launch.
    // Their presentation has its own bound; negative/replay facts keep the
    // aggregate cap and cannot be evicted to restore control trust.
    const published = !shell || [...this.tasks.values()].some(task => task.parent === parent && task.worker === child && task.item.taskType === "shell");
    const { status, summary } = prepared;
    if (!status) return;
    const reportClock = terminalReportedAt !== null && Number.isFinite(terminalReportedAt) && terminalReportedAt >= 0 ? { terminalReportedAt } : {};
    const key = `${parent}:${id}`;
    if (this.notices.has(key)) return [];
    const occurrences = [...this.tasks.values()].filter(task => task.parent === parent && task.worker === child && task.item.taskType === (shell ? "shell" : "agent"));
    const undatedReuse = shell && reportClock.terminalReportedAt === undefined && occurrences.length > 1;
    const candidates = occurrences.filter(task => task.item.status === "running" && (undatedReuse || task.item.createdAt <= at));
    const ambiguousAdmission = !shell && candidates.some(task => !this.historicalReportCompatible(child, task.evidence.launches, reportClock.terminalReportedAt));
    if (candidates.length !== 1 || undatedReuse || ambiguousAdmission) {
      const taskId = `v2:${parent}:notification:${id}`;
      const item: BackgroundTaskItem = {
        id: `task:${taskId}`, type: "background_task", taskId, createdAt: at,
        description: prepared.description ?? "Background worker result",
        ...(shell ? { outputFile: `shell:${child}` } : { childConversationId: child }), taskType: shell ? "shell" : "agent", status, summary, resultId: id, ...reportClock,
      };
      // Background membership permits display, not occurrence assignment:
      // an undated shell report's fallback clock cannot settle a later run.
      this.set(this.unmatched, key, { parent, worker: child, item, correlatable: candidates.length === 0 && (!shell || reportClock.terminalReportedAt !== undefined), published });
      this.notice(key, proof);
      if (!published) { this.trimUnpublished(); return []; }
      return [...candidates.map((task): NormalizedProviderUpdate => {
        task.item = { ...task.item, stateUncertain: true };
        this.set(this.tasks, task.item.taskId, task);
        return { kind: "upsert", item: task.item };
      }), { kind: "upsert", item }];
    }
    const task = candidates[0]!;
    task.item = { ...task.item, status, summary, resultId: id, ...reportClock };
    this.set(this.tasks, task.item.taskId, task);
    this.notice(key, proof, task.evidence.key);
    return [{ kind: "upsert", item: task.item }];
  }

  private bound(): void {
    const retained = this.budget.retained?.() ?? { entries: 0, bytes: 0 };
    const maxEntries = (this.budget.entries ?? 8_192) - retained.entries;
    const maxBytes = (this.budget.bytes ?? 4 * 1024 * 1024) - retained.bytes;
    if (maxEntries === Infinity && maxBytes === Infinity) return;
    const collections = [this.parents, this.births, this.tasks, this.notices, this.unmatched, this.ended, this.aliases, this.invocations, this.terminalProofs, this.userShells];
    const entries = collections.reduce((sum, values) => sum + values.size, 0) + this.boundaries
      + [...this.tasks.values()].reduce((sum, task) => sum + (task.requestTools?.length ?? 0) + (task.resolvedRequests?.length ?? 0) + (task.request ? 1 : 0), 0);
    if (entries <= maxEntries && this.bytes <= maxBytes) return;
    // Never evict only an old occurrence or its notice tombstone: the next
    // delayed result could then settle a newer run. On saturation the stream
    // becomes a trigger for scoped authoritative recovery until reconnect.
    // No provider mutation or polling is introduced by this fallback.
    collections.forEach(values => values.clear());
    this.sizes.clear();
    this.bytes = 62;
    this.boundaries = 0;
    this.recoveryOnly = true;
    this.budget.onSaturation?.();
  }
}
