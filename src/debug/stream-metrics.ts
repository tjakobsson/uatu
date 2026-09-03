// Lifecycle counters for the browser-facing live streams.
//
// The vocabulary is closed on purpose. Counter names are built from a fixed
// transport class and a fixed outcome and nothing else — never a URL, a
// query value, a conversation id, or anything derived from a payload. That
// keeps cardinality bounded no matter how many clients, conversations, or
// reconnects a workspace sees, and makes it impossible for a diagnostic to
// carry content or credentials (design D6).

import type { MetricsRegistry } from "./metrics";

// The three streams a browser holds open against a workspace.
export const STREAM_TRANSPORTS = ["document", "chat-conversation", "chat-inventory"] as const;
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

// Every counter this module can ever produce. Exported so a test — or a
// reader — can see the whole surface at once and confirm it does not grow
// with traffic.
export function allStreamCounterNames(): string[] {
  const names: string[] = [];
  for (const transport of STREAM_TRANSPORTS) {
    names.push(openedCounter(transport), reconnectedCounter(transport), activeGauge(transport));
    for (const outcome of STREAM_OUTCOMES) names.push(closedCounter(transport, outcome));
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
