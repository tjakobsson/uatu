import { boundedSet } from "../../shared/bounded-map";
import type { NormalizedProviderEvent } from "../provider";

type Turn = NonNullable<NormalizedProviderEvent["notificationTurns"]>[number];
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const time = (value: unknown, fallback: number): number => typeof value === "number" && Number.isFinite(value) ? value : fallback;

// Native step events and compatibility message events share assistant message
// identity. Only a final stop qualifies; tool-call/model-step boundaries do not.
// This memory belongs to the provider, so reconnect does not invent new turns.
export class OpenCodeNotificationLifecycle {
  private readonly messages = new Map<string, { conversationId: string; sourceId: string; ended: boolean; startedAt: number }>();

  observe(value: unknown, normalized: NormalizedProviderEvent): Turn[] {
    const event = record(value);
    const data = record(event.data ?? event.properties);
    const info = record(data.info ?? data.message);
    const conversationId = normalized.conversationId ?? text(info.sessionID);
    if (!conversationId) return [];
    const at = time(data.timestamp, Date.now());
    if (event.type === "session.error") return this.cancel(conversationId, at);
    const nativeStart = event.type === "session.next.step.started";
    const nativeEnd = event.type === "session.next.step.ended" || event.type === "session.next.step.failed";
    const message = event.type === "message.updated" && (info.role === "assistant" || info.type === "assistant");
    if (!nativeStart && !nativeEnd && !message) return [];
    const id = text(message ? info.id : data.assistantMessageID);
    if (!id) return [];
    const key = JSON.stringify([conversationId, id]);
    const existing = this.messages.get(key);
    if (existing?.ended) return [];
    const completedAt = record(info.time).completed ?? record(info.time).end;
    const ending = nativeEnd || message && typeof completedAt === "number";
    if (!ending) {
      if (existing) return [];
      const startedAt = time(message ? record(info.time).created : data.timestamp, at);
      boundedSet(this.messages, key, { conversationId, sourceId: id, ended: false, startedAt }, 8192);
      return [{ sourceId: id, phase: "started", createdAt: startedAt }];
    }
    // A terminal record alone could be old history replayed when connecting.
    // Remember it to prevent a later duplicate start from fabricating activity.
    boundedSet(this.messages, key, { conversationId, sourceId: id, ended: true, startedAt: existing?.startedAt ?? at }, 8192);
    if (!existing) return [];
    const finish = message ? info.finish : data.finish;
    const failed = event.type === "session.next.step.failed" || Boolean(info.error);
    return [{ sourceId: id, phase: !failed && finish === "stop" ? "completed" : "failed", createdAt: time(completedAt, at) }];
  }

  cancel(conversationId: string, createdAt = Date.now()): Turn[] {
    const turns: Turn[] = [];
    for (const value of this.messages.values()) {
      if (value.conversationId !== conversationId || value.ended) continue;
      value.ended = true;
      turns.push({ sourceId: value.sourceId, phase: "interrupted", createdAt });
    }
    return turns;
  }
}
