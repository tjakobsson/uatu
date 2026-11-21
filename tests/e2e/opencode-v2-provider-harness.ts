// Unit-test harness for the OpenCode 2.x provider against the native fake:
// one owner for the fake, the provider and its event streams, plus whole-frame
// injection into the fake's event stream.
import { createOpenCodeV2Provider } from "../../src/chat/opencode/v2/provider";
import { startOpenCodeV2Fake } from "./opencode-v2-fake";
import type { NormalizedProviderEvent } from "../../src/chat/provider";
import type { BackgroundTaskItem } from "../../src/chat/types";

/** Consume a provider's event stream into `events`, waking each matching
 * waiter. The returned pump rejects with the stream's own error (awaiting it
 * propagates that error); it is pre-marked handled so nothing goes unobserved. */
export function eventPump(provider: { events(signal: AbortSignal): AsyncIterable<NormalizedProviderEvent> }, signal: AbortSignal) {
  const events: NormalizedProviderEvent[] = [];
  const waiting = new Set<{ matches: (event: NormalizedProviderEvent) => boolean; resolve: () => void }>();
  const pump = (async () => {
    for await (const event of provider.events(signal)) {
      events.push(event);
      for (const waiter of waiting) if (waiter.matches(event)) { waiting.delete(waiter); waiter.resolve(); }
    }
  })();
  void pump.catch(() => undefined);
  const seen = (matches: (event: NormalizedProviderEvent) => boolean) =>
    events.some(matches) ? Promise.resolve() : new Promise<void>(resolve => waiting.add({ matches, resolve }));
  return { events, pump, seen };
}

export type Stream = ReturnType<typeof stream>;

export function stream(provider: ReturnType<typeof createOpenCodeV2Provider>) {
  const lifetime = new AbortController(), { events, pump, seen: seenEvent } = eventPump(provider, lifetime.signal);
  // Matches the stream state, not one event, so a condition already met resolves.
  const seen = (matches: () => boolean) => matches() ? Promise.resolve() : seenEvent(() => matches());
  const row = (taskId: string) => events.flatMap(event => event.updates)
    .flatMap(update => update.kind === "upsert" && update.item.type === "background_task" && update.item.taskId === taskId ? [update.item as BackgroundTaskItem] : []).at(-1);
  // Retire this subscription; idempotent, so the harness can always call it.
  const close = async () => { lifetime.abort(); await pump; };
  return { lifetime, events, seen, row, close };
}

/** The fake, the provider and every stream it opens, closed by one owner. */
export async function withProvider(run: (context: { fake: ReturnType<typeof startOpenCodeV2Fake>; provider: ReturnType<typeof createOpenCodeV2Provider>;
  subscribe(): Promise<Stream> }) => Promise<void>, fetch?: typeof globalThis.fetch) {
  const directory = process.cwd(), fake = startOpenCodeV2Fake({ directory });
  const provider = createOpenCodeV2Provider({ endpoint: fake.url, password: fake.password, directory, ...(fetch ? { fetch } : {}) });
  const streams: Stream[] = [];
  const subscribe = async () => {
    const opened = stream(provider); streams.push(opened);
    await provider.waitForEventStream!(opened.lifetime.signal);
    return opened;
  };
  try { await run({ fake, provider, subscribe }); }
  finally { for (const opened of streams) await opened.close(); await provider.dispose!(); await fake.stop(); }
}

// The native fake's event stream, re-framed so a test can inject whole frames
// between upstream frames without splitting either.
export function injectableEvents() {
  const injectors = new Set<(frame: string) => void>();
  const fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname !== "/api/event") return globalThis.fetch(request);
    const upstream = await globalThis.fetch(request), reader = upstream.body!.getReader(), decoder = new TextDecoder(), encoder = new TextEncoder();
    let inject: ((frame: string) => void) | undefined;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        inject = frame => controller.enqueue(encoder.encode(frame));
        injectors.add(inject);
        void (async () => {
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
              controller.enqueue(encoder.encode(buffer.slice(0, end + 2))); buffer = buffer.slice(end + 2);
            }
          }
          injectors.delete(inject!); controller.close();
        })().catch(() => { injectors.delete(inject!); });
      },
      cancel() { injectors.delete(inject!); void reader.cancel(); },
    }), { headers: upstream.headers });
  }) as typeof globalThis.fetch;
  const frame = (type: string, data: unknown, directory: string) => {
    const text = `data: ${JSON.stringify({ id: `injected-${crypto.randomUUID()}`, type, data, created: Date.now(), location: { directory } })}\n\n`;
    for (const inject of injectors) inject(text);
  };
  return { fetch, frame };
}
