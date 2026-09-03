import { describe, expect, test } from "bun:test";

import { MetricsRegistry } from "./metrics";
import {
  activeGauge,
  allStreamCounterNames,
  closedCounter,
  openedCounter,
  reconnectedCounter,
  StreamLifecycleMetrics,
  STREAM_OUTCOMES,
  STREAM_TRANSPORTS,
} from "./stream-metrics";

describe("stream lifecycle metrics", () => {
  test("an open raises the active gauge and the cumulative open count", () => {
    const registry = new MetricsRegistry();
    const metrics = new StreamLifecycleMetrics(registry);

    metrics.opened("document");
    expect(registry.get(openedCounter("document"))).toBe(1);
    expect(registry.get(activeGauge("document"))).toBe(1);
    expect(registry.get(reconnectedCounter("document"))).toBe(0);

    metrics.opened("document");
    expect(registry.get(activeGauge("document"))).toBe(2);
  });

  test("a reconnect is counted separately from a first connect", () => {
    const registry = new MetricsRegistry();
    const metrics = new StreamLifecycleMetrics(registry);

    metrics.opened("chat-conversation");
    metrics.opened("chat-conversation", { reconnect: true });

    expect(registry.get(openedCounter("chat-conversation"))).toBe(2);
    expect(registry.get(reconnectedCounter("chat-conversation"))).toBe(1);
  });

  test("each ending has its own counter and lowers the active gauge", () => {
    const registry = new MetricsRegistry();
    const metrics = new StreamLifecycleMetrics(registry);

    metrics.opened("document");
    metrics.opened("document");
    metrics.opened("document");
    metrics.closed("document", "cancelled");
    metrics.closed("document", "completed");
    metrics.closed("document", "failed");

    expect(registry.get(closedCounter("document", "cancelled"))).toBe(1);
    expect(registry.get(closedCounter("document", "completed"))).toBe(1);
    expect(registry.get(closedCounter("document", "failed"))).toBe(1);
    expect(registry.get(activeGauge("document"))).toBe(0);
  });

  test("the active gauge never goes negative on an unmatched close", () => {
    const registry = new MetricsRegistry();
    const metrics = new StreamLifecycleMetrics(registry);
    metrics.closed("chat-inventory", "cancelled");
    expect(registry.get(activeGauge("chat-inventory"))).toBe(0);
  });

  test("transports keep independent counts", () => {
    const registry = new MetricsRegistry();
    const metrics = new StreamLifecycleMetrics(registry);

    metrics.opened("document");
    metrics.opened("chat-inventory");
    metrics.closed("document", "cancelled");

    expect(registry.get(activeGauge("document"))).toBe(0);
    expect(registry.get(activeGauge("chat-inventory"))).toBe(1);
  });

  test("without a registry the recorder is inert", () => {
    const metrics = new StreamLifecycleMetrics();
    expect(() => {
      metrics.opened("document");
      metrics.closed("document", "completed");
    }).not.toThrow();
  });

  test("the counter vocabulary is closed and free of anything request-derived", () => {
    const registry = new MetricsRegistry();
    const metrics = new StreamLifecycleMetrics(registry);
    for (const transport of STREAM_TRANSPORTS) {
      metrics.opened(transport, { reconnect: true });
      for (const outcome of STREAM_OUTCOMES) metrics.closed(transport, outcome);
    }

    const names = Object.keys(registry.snapshot().counters);
    const permitted = new Set(allStreamCounterNames());
    expect(names.every(name => permitted.has(name))).toBe(true);
    // Three transports × (opened + reconnected + active + three outcomes).
    expect(permitted.size).toBe(STREAM_TRANSPORTS.length * (3 + STREAM_OUTCOMES.length));
  });
});
