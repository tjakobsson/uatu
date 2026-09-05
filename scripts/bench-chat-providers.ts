import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { ClaudeProvider } from "../src/chat/claude/provider";
import { claudeProjectDir, sessionTranscriptPath } from "../src/chat/claude/transcript";
import { SdkV2Provider } from "../src/chat/opencode/sdk-v2-provider";
import { CHAT_WORKLOAD_SIZES, claudeHistoryWorkload, opencodeHistoryWorkload } from "../tests/fixtures/chat-performance";

export async function measureProviderHistory(root: string) {
  const workspace = path.join(root, "native-workspace");
  const configDir = path.join(root, "native-config");
  await mkdir(workspace, { recursive: true });
  await mkdir(claudeProjectDir(workspace, configDir), { recursive: true });
  const results: unknown[] = [];
  for (const count of CHAT_WORKLOAD_SIZES) {
    const file = sessionTranscriptPath(workspace, "fixture", configDir);
    await writeFile(file, claudeHistoryWorkload(count));
    const claude = new ClaudeProvider({ workspacePath: workspace, configDir, stateFile: path.join(workspace, "state.json"),
      executable: "fixture", catalogProbe: false, queryFactory: () => { throw new Error("History must not start a turn"); } });
    const stores = opencodeHistoryWorkload(count);
    const calls = { native: 0, legacy: 0, session: 0 };
    const opencode = new SdkV2Provider({
      v2: { session: { messages: async ({ cursor, limit }: { cursor?: string; limit: number }) => {
        calls.native++;
        const start = Number(cursor ?? 0);
        const end = Math.min(start + limit, stores.v2.length);
        return { data: { data: stores.v2.slice(start, end), cursor: { next: end < stores.v2.length ? String(end) : null } } };
      } } },
      session: {
        get: async () => { calls.session++; return { data: { id: "fixture", directory: workspace, time: { updated: 1 } } }; },
        messages: async () => { calls.legacy++; return { data: stores.legacy }; },
      },
    } as unknown as OpencodeClient, workspace);
    for (const [agent, provider] of [["claude", claude], ["opencode", opencode]] as const) {
      globalThis.__uatuChatPerformance = { counts: {}, durations: {} };
      const pages = [];
      let cursor: string | undefined;
      for (let read = 0; read < 3; read++) {
        const start = performance.now();
        const page = await provider.listMessages("fixture", { limit: 20, cursor });
        pages.push({ durationMs: performance.now() - start, items: page.items.length });
        cursor = page.nextCursor;
      }
      results.push({ agent, count, pages, work: structuredClone(globalThis.__uatuChatPerformance), ...(agent === "opencode" ? { calls: { ...calls } } : {}) });
      if ("dispose" in provider) await provider.dispose();
    }
  }
  globalThis.__uatuChatPerformance = undefined;
  return results;
}
