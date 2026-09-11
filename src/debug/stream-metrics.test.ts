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
  upstreamActiveGauge,
  upstreamCounter,
  UpstreamSubscriptionMetrics,
  UPSTREAM_OUTCOMES,
  UPSTREAM_TOPICS,
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

  test("the brokered client stream is a transport class of its own", () => {
    const registry = new MetricsRegistry();
    const metrics = new StreamLifecycleMetrics(registry);
    metrics.opened("hub-live");
    metrics.opened("hub-live", { reconnect: true });
    metrics.closed("hub-live", "cancelled");
    expect(registry.get(openedCounter("hub-live"))).toBe(2);
    expect(registry.get(reconnectedCounter("hub-live"))).toBe(1);
    expect(registry.get(activeGauge("hub-live"))).toBe(1);
    expect(registry.get(closedCounter("hub-live", "cancelled"))).toBe(1);
  });

  test("the counter vocabulary is closed and free of anything request-derived", () => {
    const registry = new MetricsRegistry();
    const metrics = new StreamLifecycleMetrics(registry);
    for (const transport of STREAM_TRANSPORTS) {
      metrics.opened(transport, { reconnect: true });
      for (const outcome of STREAM_OUTCOMES) metrics.closed(transport, outcome);
    }
    const upstreams = new UpstreamSubscriptionMetrics(registry);
    for (const topic of UPSTREAM_TOPICS) {
      upstreams.opened(topic);
      upstreams.failed(topic);
      upstreams.released(topic);
    }

    const names = Object.keys(registry.snapshot().counters);
    const permitted = new Set(allStreamCounterNames());
    expect(names.every(name => permitted.has(name))).toBe(true);
    // Four transports × (opened + reconnected + active + three outcomes),
    // plus four upstream topics × (active + three outcomes).
    expect(permitted.size).toBe(
      STREAM_TRANSPORTS.length * (3 + STREAM_OUTCOMES.length) + UPSTREAM_TOPICS.length * (1 + UPSTREAM_OUTCOMES.length),
    );
  });
});

describe("upstream subscription metrics", () => {
  test("opens and releases move the active gauge; failures are counted while the upstream stays active", () => {
    const registry = new MetricsRegistry();
    const metrics = new UpstreamSubscriptionMetrics(registry);
    metrics.opened("conversation");
    metrics.opened("conversation");
    metrics.failed("conversation");
    expect(registry.get(upstreamCounter("conversation", "opened"))).toBe(2);
    expect(registry.get(upstreamCounter("conversation", "failed"))).toBe(1);
    expect(registry.get(upstreamActiveGauge("conversation"))).toBe(2);
    metrics.released("conversation");
    expect(registry.get(upstreamCounter("conversation", "released"))).toBe(1);
    expect(registry.get(upstreamActiveGauge("conversation"))).toBe(1);
    metrics.released("conversation");
    metrics.released("conversation");
    expect(registry.get(upstreamActiveGauge("conversation"))).toBe(0);
  });

  test("topics keep independent counts and the names carry the topic class only", () => {
    const registry = new MetricsRegistry();
    const metrics = new UpstreamSubscriptionMetrics(registry);
    metrics.opened("document");
    metrics.opened("activity");
    expect(registry.get(upstreamActiveGauge("document"))).toBe(1);
    expect(registry.get(upstreamActiveGauge("inventory"))).toBe(0);
    for (const name of Object.keys(registry.snapshot().counters)) {
      expect(name).toMatch(/^upstream\.(document|inventory|conversation|activity)\.(opened_total|released_total|failed_total|active)$/);
    }
  });

  test("without a registry the recorder is inert", () => {
    const metrics = new UpstreamSubscriptionMetrics();
    expect(() => {
      metrics.opened("document");
      metrics.failed("document");
      metrics.released("document");
    }).not.toThrow();
  });
});
