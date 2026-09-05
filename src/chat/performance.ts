// Opt-in benchmark counters. Labels are fixed; payloads and identifiers never
// enter the measurements. Normal sessions allocate no measurement records.
export type ChatPerformanceLabel = "transcript-render" | "markdown" | "item-geometry" | "claude-read" | "claude-normalize" | "opencode-read";
export type ChatPerformanceData = { counts: Partial<Record<ChatPerformanceLabel, number>>; durations: Partial<Record<ChatPerformanceLabel, number>> };
declare global { var __uatuChatPerformance: ChatPerformanceData | undefined; }

export function measureChatWork(label: ChatPerformanceLabel): () => void {
  const data = globalThis.__uatuChatPerformance;
  if (!data) return noop;
  data.counts[label] = (data.counts[label] ?? 0) + 1;
  const start = performance.now();
  return () => { data.durations[label] = (data.durations[label] ?? 0) + performance.now() - start; };
}
function noop(): void {}
