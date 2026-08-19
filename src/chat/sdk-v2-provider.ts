import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { createHash } from "node:crypto";

import { boundedSet } from "../shared/bounded-map";
import type {
  OpenCodeProvider,
  PendingPermission,
  PendingQuestion,
  ProviderEvent,
  ProviderMessage,
  ProviderPage,
  ProviderPermissionReply,
  ProviderSession,
} from "./provider";
import { normalizeQuestion, permissionDiff } from "./normalization";
import type { ChatAgent, ChatMode, ChatCommand, ChatModel, ModelSelection } from "./types";

type Result<T> = { data?: T; error?: unknown };

export function createSdkV2Provider(options: {
  endpoint: string;
  password: string;
  directory: string;
  fetch?: typeof globalThis.fetch;
}): OpenCodeProvider {
  const authorization = `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`;
  const client = createOpencodeClient({
    baseUrl: options.endpoint,
    directory: options.directory,
    headers: { authorization },
    fetch: options.fetch,
  });
  return new SdkV2Provider(client, options.directory);
}

export class SdkV2Provider implements OpenCodeProvider {
  private readonly compatibilitySessions = new Set<string>();

  constructor(
    private readonly client: OpencodeClient,
    private readonly directory: string,
    private readonly commandAdmissionMs = 1_000,
  ) {}

  async listCommands(): Promise<ChatCommand[]> {
    const response = unwrap(await this.client.command.list({ directory: this.directory })) as unknown;
    const commands = Array.isArray(response) ? response : [];
    const result: ChatCommand[] = [];
    const names = new Set<string>();
    for (const value of commands) {
      const command = value as { name?: unknown; description?: unknown; hints?: unknown; source?: unknown };
      if (typeof command.name !== "string" || !/^[^\s/]+$/.test(command.name) || names.has(command.name)) continue;
      names.add(command.name);
      result.push({
        name: command.name,
        description: typeof command.description === "string" ? command.description : "",
        argumentHint: Array.isArray(command.hints) ? command.hints.filter(hint => typeof hint === "string").join(" ") : "",
        kind: command.source === "skill" ? "skill" : "command",
      });
    }
    for (const builtin of BUILTIN_COMMANDS) {
      if (!names.has(builtin.name)) result.push(builtin);
    }
    return result;
  }

  // Everything below is implemented against a live OpenCode server, so every
  // capability is declared. A capability this codebase has not built yet is not
  // listed here: the change that builds it adds its key.
  describe(): ChatAgent {
    return {
      id: "opencode",
      name: "OpenCode",
      capabilities: ["modes", "models", "commands", "questions", "permissions", "subagents", "variants", "context"],
    };
  }

  async listModes(): Promise<ChatMode[]> {
    const payload = unwrap(await this.client.app.agents({ directory: this.directory })) as unknown;
    const response = Array.isArray(payload) ? payload : asArray(asRecord(payload).data);
    const modes: ChatMode[] = [];
    const names = new Set<string>();
    for (const value of response) {
      const entry = asRecord(value);
      const name = typeof entry.name === "string" ? entry.name : "";
      // OpenCode calls these agents on the wire; they are what this codebase
      // calls modes. Subagents are spawned by the task tool, never chosen for
      // a prompt — and OpenCode's system agents (title, compaction, summary)
      // are `mode: "primary"` but carry `hidden: true` on the wire (a field
      // the pinned SDK's type does not declare; verified against a live
      // server). Without the hidden check they all appear in the picker.
      if (!name || names.has(name) || entry.mode === "subagent" || entry.hidden === true) continue;
      names.add(name);
      modes.push({ name, description: typeof entry.description === "string" ? entry.description : "" });
    }
    return modes;
  }

  async listModels(): Promise<ChatModel[]> {
    const response = unwrap(await this.client.provider.list({ directory: this.directory }));
    const connected = new Set(response.connected);
    return response.all
      .filter(provider => connected.has(provider.id))
      .flatMap(provider => Object.values(provider.models).map(model => {
        // OpenCode reports variants as a keyed map; the ids are its keys.
        const variants = Object.keys(model.variants ?? {});
        return {
          selection: { providerId: provider.id, modelId: model.id },
          provider: provider.name,
          name: model.name,
          ...(variants.length ? { variants } : {}),
          ...(model.limit?.context ? { contextLimit: model.limit.context } : {}),
        };
      }))
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name));
  }

  async switchModel(sessionId: string, selection: ModelSelection, variant?: string): Promise<void> {
    ensureSuccess(await this.client.v2.session.switchModel({
      sessionID: sessionId,
      // On the v2 path a reasoning variant is not a prompt field — it rides on
      // the model reference here. The UI re-sends the model every prompt, so
      // this runs every turn and the variant is reapplied every turn.
      model: { providerID: selection.providerId, id: selection.modelId, ...(variant ? { variant } : {}) },
    }));
  }

  async renameSession(sessionId: string, title: string): Promise<ProviderSession> {
    unwrap(await this.client.session.update({ sessionID: sessionId, directory: this.directory, title }));
    const session = await this.getSession(sessionId);
    if (!session) throw new Error("OpenCode session disappeared after rename");
    return session;
  }

  async listSessions(): Promise<ProviderSession[]> {
    const sessions = new Map<string, ProviderSession>();
    const classic = await this.client.session.list({ directory: this.directory }) as Result<unknown>;
    if (Array.isArray(classic.data)) {
      for (const value of classic.data) {
        const session = toSession(value);
        sessions.set(session.id, session);
        if (isCompatibilitySession(value)) this.compatibilitySessions.add(session.id);
      }
    }
    let cursor: string | undefined;
    do {
      const page = unwrap(await this.client.v2.session.list({ directory: this.directory, order: "desc", limit: 100, cursor }));
      for (const value of page.data) {
        const session = toSession(value);
        if (!sessions.has(session.id)) sessions.set(session.id, session);
      }
      cursor = page.cursor.next;
    } while (cursor);
    // Children may list before their parents, so inheritance runs to a
    // fixpoint over the whole inventory rather than per row.
    let flagged = true;
    while (flagged) {
      flagged = false;
      for (const session of sessions.values()) {
        if (this.inheritTransport(session)) flagged = true;
      }
    }
    return [...sessions.values()];
  }

  async createSession(_id: string): Promise<ProviderSession> {
    const session = toSession(unwrap(await this.client.session.create({
      directory: this.directory,
      metadata: { "uatu.transport": "compatibility" },
    })));
    this.compatibilitySessions.add(session.id);
    return session;
  }

  async getSession(id: string): Promise<ProviderSession | null> {
    const classic = await this.client.session.get({ sessionID: id, directory: this.directory }) as Result<unknown>;
    if (classic.data) {
      if (isCompatibilitySession(classic.data)) this.compatibilitySessions.add(id);
      const session = toSession(classic.data);
      this.inheritTransport(session);
      return session;
    }
    // Only a store miss falls through — a transient 401/5xx must surface as a
    // failure, or the pump misreads it as "conversation gone" and silently
    // drops frames like completion and permission requests.
    ensureLookupMiss(classic);
    const result = await this.client.v2.session.get({ sessionID: id }) as Result<unknown>;
    if (result.error !== undefined) {
      ensureLookupMiss(result);
      return null;
    }
    if (!result.data) return null;
    const response = result.data as { data?: unknown };
    const session = toSession(response.data ?? response);
    this.inheritTransport(session);
    return session;
  }

  /**
   * A subagent child is created by OpenCode itself, never through
   * `createSession`, so it carries no compatibility metadata — but it lives in
   * whichever store its parent lives in. Without inheriting the flag, a child
   * of a compatibility session is routed to the v2 endpoints (permission
   * replies, prompts, interrupts), which fail against the classic store; that
   * is exactly the path taken when a subagent's permission is answered from
   * the parent conversation, where the child's transcript was never loaded.
   */
  private inheritTransport(session: ProviderSession): boolean {
    if (!session.parentId || this.compatibilitySessions.has(session.id)) return false;
    if (!this.compatibilitySessions.has(session.parentId)) return false;
    this.compatibilitySessions.add(session.id);
    return true;
  }

  /**
   * OpenCode keeps two message stores: the v2 store holds sessions prompted
   * through the v2 API, while sessions started in the CLI/TUI live in the
   * classic store and read back empty from v2 (and vice versa). Reading only
   * one shows an empty transcript for half the user's conversations, so both
   * are merged, deduplicated by message id, and paged locally.
   */
  async listMessages(sessionId: string, options: { cursor?: string; limit: number }): Promise<ProviderPage<ProviderMessage>> {
    const merged = await this.allMessages(sessionId);
    const end = clampIndex(options.cursor, merged.length);
    const start = Math.max(0, end - Math.max(1, options.limit));
    return {
      items: merged.slice(start, end),
      nextCursor: start > 0 ? String(start) : undefined,
    };
  }

  private async allMessages(sessionId: string): Promise<ProviderMessage[]> {
    const byId = new Map<string, ProviderMessage>();
    let cursor: string | undefined;
    do {
      // OpenCode rejects `order` combined with `cursor` — the cursor already
      // encodes the direction, so it is only sent for the first page.
      const page = unwrap(await this.client.v2.session.messages(
        cursor ? { sessionID: sessionId, limit: 100, cursor } : { sessionID: sessionId, order: "asc", limit: 100 },
      ));
      for (const item of page.data as ProviderMessage[]) byId.set(messageIdentity(item), item);
      cursor = page.data.length > 0 ? page.cursor.next ?? undefined : undefined;
    } while (cursor);

    for (const item of await this.legacyMessages(sessionId)) {
      const id = messageIdentity(item);
      if (!byId.has(id)) byId.set(id, item);
    }

    return [...byId.values()].sort((left, right) =>
      messageCreatedAt(left) - messageCreatedAt(right) || messageIdentity(left).localeCompare(messageIdentity(right)));
  }

  private async legacyMessages(sessionId: string): Promise<ProviderMessage[]> {
    const legacy = this.client as unknown as {
      session?: { messages?: (input: { sessionID: string; directory: string }) => Promise<Result<unknown>> };
    };
    if (typeof legacy.session?.messages !== "function") return [];
    const result = await legacy.session.messages({ sessionID: sessionId, directory: this.directory });
    // A store miss (404, or a build whose classic route rejects the id) means
    // the v2 store is the only store; a transient 401/5xx must propagate, or
    // a compatibility session's whole transcript silently reads as empty.
    if (result.error !== undefined) {
      ensureLookupMiss(result);
      return [];
    }
    const messages = Array.isArray(result.data) ? result.data as ProviderMessage[] : [];
    if (messages.length > 0) this.compatibilitySessions.add(sessionId);
    return messages;
  }

  async *events(signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const [native, classic] = await Promise.all([
      this.client.v2.event.subscribe({ signal }),
      this.client.event.subscribe({ directory: this.directory }, { signal }),
    ]);
    yield* mergeProviderEvents([native.stream, classic.stream], signal);
  }

  async prompt(sessionId: string, input: { id: string; text: string; delivery: "steer" | "queue"; model?: ModelSelection; mode?: string; variant?: string }): Promise<{ messageId: string }> {
    const messageId = stableProviderId("msg", input.id);
    if (this.compatibilitySessions.has(sessionId)) {
      ensureSuccess(await this.client.session.promptAsync({
        sessionID: sessionId,
        directory: this.directory,
        messageID: messageId,
        parts: [{ type: "text", text: input.text }],
        ...(input.model ? { model: { providerID: input.model.providerId, modelID: input.model.modelId } } : {}),
        ...(input.mode ? { agent: input.mode } : {}),
        // The classic path DOES take a body variant, unlike the v2 path below.
        ...(input.variant ? { variant: input.variant } : {}),
      }));
      return { messageId };
    }
    if (input.model) await this.switchModel(sessionId, input.model, input.variant);
    // Session-level, not a prompt field: the generated v2 prompt serializer
    // passes through only id/prompt/delivery/resume, so an `agent` property
    // there is silently dropped — the selection would look accepted while the
    // session kept its previous agent.
    if (input.mode) ensureSuccess(await this.client.v2.session.switchAgent({ sessionID: sessionId, agent: input.mode }));
    const admitted = unwrap(await this.client.v2.session.prompt({
      sessionID: sessionId,
      id: messageId,
      prompt: { text: input.text },
      delivery: input.delivery,
      resume: true,
    }));
    return { messageId: admitted.data.id };
  }

  /**
   * The classic command/summarize routes resolve only when the whole turn
   * finishes, so admission cannot be awaited to completion. Instead the
   * dispatch races a short window: an invalid command or unavailable provider
   * rejects immediately and reaches the caller's draft-restoration path,
   * while a healthy turn outlives the window, detaches, and reports failures
   * through the event stream like any running turn.
   */
  async command(sessionId: string, input: { id: string; name: string; arguments: string; model?: ModelSelection; mode?: string; variant?: string }): Promise<{ messageId: string }> {
    const messageId = stableProviderId("msg", input.id);
    // A command is a turn like any other, so it runs at the reasoning effort
    // the user picked. On the v2 path the variant is not a body field — it
    // rides on the model reference — so the model is re-sent exactly as
    // `prompt` does: with the variant when one is chosen, and WITHOUT one
    // when the picker says default, which resets whatever an earlier turn
    // applied. Unconditional on purpose: any gate that trusts this process's
    // memory of the session's variant (an `input.variant` check, a local
    // applied-variant map) goes stale the moment the provider is recreated
    // over a session that still carries one. A compatibility session exists
    // only in the classic store, where the v2 switchModel lookup fails —
    // there the variant is a body field on the dispatch itself, as the
    // classic prompt path already sends it.
    const compatibility = this.compatibilitySessions.has(sessionId);
    if (!compatibility && input.model) await this.switchModel(sessionId, input.model, input.variant);
    const dispatch = input.name === "compact" || input.name === "summarize"
      ? (async () => ensureSuccess(await this.client.session.summarize({
          sessionID: sessionId,
          directory: this.directory,
          providerID: input.model?.providerId,
          modelID: input.model?.modelId,
        })))()
      : (async () => { unwrap(await this.client.session.command({
          sessionID: sessionId,
          directory: this.directory,
          messageID: messageId,
          command: input.name,
          arguments: input.arguments,
          ...(input.model ? { model: `${input.model.providerId}/${input.model.modelId}` } : {}),
          ...(input.mode ? { agent: input.mode } : {}),
          ...(compatibility && input.variant ? { variant: input.variant } : {}),
        })); })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([dispatch, new Promise<void>(resolve => { timer = setTimeout(resolve, this.commandAdmissionMs); })]);
    } finally {
      clearTimeout(timer);
      dispatch.catch(() => undefined);
    }
    return { messageId };
  }

  async interrupt(sessionId: string): Promise<void> {
    if (this.compatibilitySessions.has(sessionId)) {
      ensureSuccess(await this.client.session.abort({ sessionID: sessionId, directory: this.directory }));
      return;
    }
    unwrap(await this.client.v2.session.interrupt({ sessionID: sessionId }));
  }

  async replyPermission(sessionId: string, requestId: string, reply: ProviderPermissionReply): Promise<void> {
    if (this.compatibilitySessions.has(sessionId)) {
      ensureSuccess(await this.client.permission.reply({ requestID: requestId, directory: this.directory, reply }));
      return;
    }
    unwrap(await this.client.v2.session.permission.reply({ sessionID: sessionId, requestID: requestId, reply }));
  }

  async listPermissions(): Promise<PendingPermission[]> {
    // Same route choice and reasoning as listQuestions below: the global list
    // filtered here. Tolerates either envelope, and either naming generation's
    // field names, because the classic bridge renames action/resources to
    // permission/patterns.
    const payload = unwrap(await this.client.permission.list({ directory: this.directory })) as unknown;
    const response = Array.isArray(payload) ? payload : asArray(asRecord(payload).data);
    return response.flatMap(value => {
      const request = asRecord(value);
      const requestId = typeof request.id === "string" ? request.id : undefined;
      const owner = typeof request.sessionID === "string" ? request.sessionID : undefined;
      if (!requestId || !owner) return [];
      const action = typeof request.action === "string" ? request.action
        : typeof request.permission === "string" ? request.permission : "permission";
      const raw = Array.isArray(request.resources) ? request.resources
        : Array.isArray(request.patterns) ? request.patterns : [];
      return [{
        requestId,
        conversationId: owner,
        action,
        resources: raw.filter((item): item is string => typeof item === "string"),
        // The same metadata.diff the live event carries — recovery is the
        // path for a user who missed that event, and they are the one reader
        // who must not approve an edit without being shown it.
        ...permissionDiff(request),
      }];
    });
  }

  async listQuestions(): Promise<PendingQuestion[]> {
    // Deliberately the global list, rather than the session-scoped
    // `v2.session.question.list`: on OpenCode 1.18 the session-scoped route
    // answers `{"data":[]}` for a session that the global route reports a
    // live pending question for. Verified against a running server. Both
    // envelopes are tolerated so this keeps working if that route starts
    // answering. Filtering is the adapter's job — the owner rides along, the
    // same shape as listPermissions, so a parent can find its children's.
    const payload = unwrap(await this.client.question.list({ directory: this.directory })) as unknown;
    const response = Array.isArray(payload) ? payload : asArray(asRecord(payload).data);
    return response.flatMap(value => {
      const request = asRecord(value);
      const requestId = typeof request.id === "string" ? request.id : undefined;
      const owner = typeof request.sessionID === "string" ? request.sessionID : undefined;
      if (!requestId || !owner) return [];
      return [{ requestId, conversationId: owner, questions: asArray(request.questions).map(normalizeQuestion) }];
    });
  }

  // Reply and reject go through the global routes for every session, matching
  // listQuestions: the `que_` request id comes from the global list, and the
  // session-scoped pair is not trustworthy on OpenCode 1.18 (its list reports
  // nothing for a session with a live pending question). Verified end to end
  // against a running server: POST /question/{requestID}/reply returns 200 and
  // the agent resumes.
  async replyQuestion(_sessionId: string, requestId: string, answers: string[][]): Promise<void> {
    ensureSuccess(await this.client.question.reply({ requestID: requestId, directory: this.directory, answers }));
  }

  async rejectQuestion(_sessionId: string, requestId: string): Promise<void> {
    ensureSuccess(await this.client.question.reject({ requestID: requestId, directory: this.directory }));
  }
}

const BUILTIN_COMMANDS: ChatCommand[] = [
  { name: "compact", description: "Compact the conversation context", argumentHint: "", kind: "command" },
  { name: "summarize", description: "Summarize and compact the conversation context", argumentHint: "", kind: "command" },
];

export function stableProviderId(prefix: "msg", identity: string): string {
  if (identity.startsWith(`${prefix}_`)) return identity;
  return `${prefix}_${createHash("sha256").update(identity).digest("hex").slice(0, 26)}`;
}

function unwrap<T>(result: Result<T>): T {
  if (result.error !== undefined) throw new Error(`OpenCode request failed: ${stringify(result.error)}`);
  if (result.data === undefined) throw new Error("OpenCode returned no data");
  return result.data;
}

function ensureSuccess(result: Result<unknown>): void {
  if (result.error !== undefined) throw new Error(`OpenCode request failed: ${stringify(result.error)}`);
}

/**
 * A session lookup answering 404 (or 400 for an id the store rejects) means
 * "not in this store" and may fall through; any other error — expired auth,
 * a restarting server — is a provider failure and must propagate.
 */
function ensureLookupMiss(result: Result<unknown>): void {
  if (result.error === undefined) return;
  const status = (result as { response?: { status?: number } }).response?.status;
  if (status === 404 || status === 400) return;
  throw new Error(`OpenCode session lookup failed: ${stringify(result.error)}`);
}

/** Message identity across both stores: flat `id` (v2) or `info.id` (classic). */
function messageIdentity(value: unknown): string {
  const message = value as { id?: unknown; info?: { id?: unknown } };
  if (typeof message?.id === "string") return message.id;
  if (typeof message?.info?.id === "string") return message.info.id;
  return "";
}

function messageCreatedAt(value: unknown): number {
  const message = value as { time?: { created?: unknown }; info?: { time?: { created?: unknown } } };
  const created = message?.time?.created ?? message?.info?.time?.created;
  return typeof created === "number" && Number.isFinite(created) ? created : 0;
}

function clampIndex(cursor: string | undefined, length: number): number {
  if (!cursor) return length;
  const parsed = Number(cursor);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= length ? parsed : length;
}

function toSession(value: unknown): ProviderSession {
  const session = value as {
    id: string;
    title: string;
    directory?: string;
    location?: { directory: string };
    parentID?: string;
    time: { created: number; updated: number };
  };
  return {
    id: session.id,
    title: session.title,
    directory: session.directory ?? session.location?.directory ?? "",
    createdAt: session.time.created,
    updatedAt: session.time.updated,
    ...(typeof session.parentID === "string" && session.parentID ? { parentId: session.parentID } : {}),
  };
}

function isCompatibilitySession(value: unknown): boolean {
  const metadata = (value as { metadata?: Record<string, unknown> })?.metadata;
  return metadata?.["uatu.transport"] === "compatibility";
}

async function* mergeProviderEvents(streams: AsyncIterable<unknown>[], signal: AbortSignal): AsyncIterable<ProviderEvent> {
  const queued: ProviderEvent[] = [];
  const seen = new Set<string>();
  let active = streams.length;
  const failures: unknown[] = [];
  let wake: (() => void) | null = null;
  const notify = () => { wake?.(); wake = null; };
  for (const stream of streams) {
    void (async () => {
      // Id-less events dedupe by payload, which would also swallow a
      // legitimate repeat from the same stream (two identical " " deltas).
      // Numbering occurrences per stream keeps cross-stream duplicates
      // aligned (a mirrored stream repeats the same payloads in the same
      // order) while same-stream repeats stay distinct.
      const occurrences = new Map<string, number>();
      try {
        for await (const value of stream) {
          const event = value as ProviderEvent;
          let identity = providerEventIdentity(event);
          if (typeof event.id !== "string") {
            const occurrence = (occurrences.get(identity) ?? 0) + 1;
            boundedSet(occurrences, identity, occurrence, 2_048);
            identity = `${identity}#${occurrence}`;
          }
          if (seen.has(identity)) continue;
          seen.add(identity);
          if (seen.size > 2_048) seen.delete(seen.values().next().value!);
          queued.push(event);
          notify();
        }
      } catch (error) {
        // A mid-stream death must surface to the consumer — swallowing it here
        // would leave the merged stream half-alive with no way for the event
        // pump's supervisor to notice and reconnect.
        failures.push(error);
      } finally {
        active -= 1;
        notify();
      }
    })();
  }
  while (!signal.aborted && (active > 0 || queued.length > 0)) {
    const event = queued.shift();
    if (event) { yield event; continue; }
    if (failures.length > 0) throw failures[0];
    await new Promise<void>(resolve => { wake = resolve; });
  }
  if (failures.length > 0 && !signal.aborted) throw failures[0];
}

function providerEventIdentity(event: ProviderEvent): string {
  if (typeof event.id === "string") return event.id;
  const data = event.data ?? event.properties;
  return `${String(event.type)}:${stringify(data)}`;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringify(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
