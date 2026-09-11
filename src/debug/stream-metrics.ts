// Lifecycle counters for live streams — the workspace child's own SSE
// routes (now the internal hub↔child protocol) and the hub's brokered
// client stream.
//
// The vocabulary is closed on purpose. Counter names are built from a fixed
// transport class and a fixed outcome and nothing else — never a URL, a
// query value, a workspace or conversation id, a cursor, or anything derived
// from a payload. That keeps cardinality bounded no matter how many clients,
// conversations, or reconnects a workspace sees, and makes it impossible for
// a diagnostic to carry content or credentials (design D6).

import type { MetricsRegistry } from "./metrics";

// The child's three internal streams, plus the one stream a browser holds
// against the hub (`hub-live`, the brokered multiplex). A child never records
// `hub-live`; a hub never records the other three — the set is shared so the
// permitted vocabulary is one list.
export const STREAM_TRANSPORTS = ["document", "chat-conversation", "chat-inventory", "hub-live"] as const;
export type StreamTransport = (typeof STREAM_TRANSPORTS)[number];

// How a stream ended. `completed` is the upstream closing normally,
// `cancelled` is the client going away, `failed` is an upstream error —
// the three cases a reader has to tell apart to diagnose a report of "it
// stopped updating".
export const STREAM_OUTCOMES = ["completed", "cancelled", "failed"] as const;
export type StreamOutcome = (typeof STREAM_OUTCOMES)[number];

export function openedCounter(transport: StreamTransport): string {
  return `stream.${transport}.opened_total`;
}

// Opens that resumed an earlier connection — the client said so, either with
// a replay cursor or with the document channel's reconnect marker. This is
// the "recovery succeeded" signal: it only increments once the replacement
// request actually reached the workspace.
export function reconnectedCounter(transport: StreamTransport): string {
  return `stream.${transport}.reconnected_total`;
}

export function activeGauge(transport: StreamTransport): string {
  return `stream.${transport}.active`;
}

export function closedCounter(transport: StreamTransport, outcome: StreamOutcome): string {
  return `stream.${transport}.closed_total.${outcome}`;
}

// The hub's upstream subscriptions to a child, by topic class. `opened`
// counts every (re)open of an upstream, `released` the hub letting one go
// after its last subscriber left, `failed` an upstream that rejected,
// answered non-2xx, or ended unexpectedly. The topic is the whole identity:
// never the workspace, the conversation, or the cursor.
export const UPSTREAM_TOPICS = ["document", "inventory", "conversation", "activity"] as const;
export type UpstreamTopic = (typeof UPSTREAM_TOPICS)[number];
export const UPSTREAM_OUTCOMES = ["opened", "released", "failed"] as const;
export type UpstreamOutcome = (typeof UPSTREAM_OUTCOMES)[number];

export function upstreamCounter(topic: UpstreamTopic, outcome: UpstreamOutcome): string {
  return `upstream.${topic}.${outcome}_total`;
}

export function upstreamActiveGauge(topic: UpstreamTopic): string {
  return `upstream.${topic}.active`;
}

// Every counter this module can ever produce. Exported so a test — or a
// reader — can see the whole surface at once and confirm it does not grow
// with traffic.
export function allStreamCounterNames(): string[] {
  const names: string[] = [];
  for (const transport of STREAM_TRANSPORTS) {
    names.push(openedCounter(transport), reconnectedCounter(transport), activeGauge(transport));
    for (const outcome of STREAM_OUTCOMES) names.push(closedCounter(transport, outcome));
  }
  for (const topic of UPSTREAM_TOPICS) {
    names.push(upstreamActiveGauge(topic));
    for (const outcome of UPSTREAM_OUTCOMES) names.push(upstreamCounter(topic, outcome));
  }
  return names;
}

// Records one stream's lifecycle. Holding the count locally (rather than
// reading the gauge back) keeps the active gauge correct when two workspaces
// share a registry, and makes a double close a no-op.
export class StreamLifecycleMetrics {
  private readonly active = new Map<StreamTransport, number>();

  constructor(private readonly registry?: MetricsRegistry) {}

  opened(transport: StreamTransport, options: { reconnect?: boolean } = {}): void {
    if (!this.registry) return;
    this.registry.inc(openedCounter(transport));
    if (options.reconnect) this.registry.inc(reconnectedCounter(transport));
    const next = (this.active.get(transport) ?? 0) + 1;
    this.active.set(transport, next);
    this.registry.set(activeGauge(transport), next);
  }

  closed(transport: StreamTransport, outcome: StreamOutcome): void {
    if (!this.registry) return;
    this.registry.inc(closedCounter(transport, outcome));
    const next = Math.max(0, (this.active.get(transport) ?? 0) - 1);
    this.active.set(transport, next);
    this.registry.set(activeGauge(transport), next);
  }
}

// Records the hub's upstream subscriptions. Opens and releases move the
// active gauge; a failure is a counter only — the upstream stays "active"
// while the broker retries it, and is released when its subscribers leave.
export class UpstreamSubscriptionMetrics {
  private readonly active = new Map<UpstreamTopic, number>();

  constructor(private readonly registry?: MetricsRegistry) {}

  opened(topic: UpstreamTopic): void {
    if (!this.registry) return;
    this.registry.inc(upstreamCounter(topic, "opened"));
    const next = (this.active.get(topic) ?? 0) + 1;
    this.active.set(topic, next);
    this.registry.set(upstreamActiveGauge(topic), next);
  }

  released(topic: UpstreamTopic): void {
    if (!this.registry) return;
    this.registry.inc(upstreamCounter(topic, "released"));
    const next = Math.max(0, (this.active.get(topic) ?? 0) - 1);
    this.active.set(topic, next);
    this.registry.set(upstreamActiveGauge(topic), next);
  }

  failed(topic: UpstreamTopic): void {
    if (!this.registry) return;
    this.registry.inc(upstreamCounter(topic, "failed"));
  }
}
