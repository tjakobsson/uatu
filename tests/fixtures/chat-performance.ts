import type { ConversationItem } from "../../src/chat/types";

export const CHAT_WORKLOAD_SIZES = [50, 500, 2_000] as const;
const epoch = Date.parse("2026-09-01T12:00:00Z");
const prose = "A retained conversation should keep its reading position while new output arrives. ".repeat(8);
const code = "```ts\n" + Array.from({ length: 24 }, (_, i) => `const value${i} = ${i};`).join("\n") + "\n```\n[Workspace file](src/chat/ui.ts)";
const output = Array.from({ length: 400 }, (_, i) => `fixture output line ${i}: checked source and tests`).join("\n");
const image = { name: "fixture.png", mimeType: "image/png" };

/** Identical normalized workloads for both agents, with stable IDs and bytes. */
export function chatWorkload(count: number, prefix = "bench", startIndex = 0): ConversationItem[] {
  return Array.from({ length: count }, (_, index): ConversationItem => {
    const base = { id: `${prefix}:${index}`, createdAt: epoch + (startIndex + index) * 1_000 };
    if (index === count - 1) return {
      ...base, type: "question", requestId: `${prefix}-question`, status: "pending",
      questions: [{ header: "Validation", prompt: "Which checks should run?", multiple: false, allowFreeForm: true,
        options: [{ label: "Browser tests", description: "Exercise navigation and reading" }] }],
    };
    switch (index % 10) {
      case 0: return { ...base, type: "user_message", text: `Review step ${index}. ${prose}` };
      case 1: return { ...base, type: "assistant_message", markdown: prose };
      case 2: return { ...base, type: "assistant_message", markdown: code };
      case 3: return { ...base, type: "tool", name: "read", status: "completed", input: '{"path":"src/chat/ui.ts"}', output };
      case 4: return { ...base, type: "reasoning", status: "completed", text: prose };
      case 5: return { ...base, type: "user_message", text: "Review this image", attachments: [{ ...image }] };
      default: return { ...base, type: "assistant_message", markdown: `Result ${index}\n\n${prose}` };
    }
  });
}

/** Native JSONL, including paired tool calls/results and image blocks. */
export function claudeHistoryWorkload(count: number): string {
  const rows: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const user = i % 5 === 0 || i % 5 === 4;
    let content: unknown = [{ type: "text", text: i % 5 === 2 ? code : prose }];
    if (i % 5 === 0) content = [{ type: "text", text: `Review ${i}` }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }];
    if (i % 5 === 3) content = [{ type: "tool_use", id: `tool-${i}`, name: "Read", input: { file_path: "src/chat/ui.ts" } }];
    if (i % 5 === 4) content = [{ type: "tool_result", tool_use_id: `tool-${i - 1}`, content: output }];
    rows.push({ type: user ? "user" : "assistant", uuid: `entry-${i}`, parentUuid: i ? `entry-${i - 1}` : null,
      timestamp: new Date(epoch + i * 1_000).toISOString(), isSidechain: false,
      message: { id: `message-${i}`, role: user ? "user" : "assistant", content,
        ...(!user ? { model: "claude-fixture", usage: { input_tokens: 100 + i, output_tokens: 40 } } : {}) } });
  }
  return rows.map(row => JSON.stringify(row) + "\n").join("");
}

/** Disjoint native/compatibility stores exercise the complete merged read. */
export function opencodeHistoryWorkload(count: number) {
  const v2: unknown[] = [];
  const legacy: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const text = i % 5 === 2 ? code : prose;
    if (i % 2 === 0) {
      v2.push({ id: `message-${i}`, type: "assistant", time: { created: epoch + i * 1_000, completed: epoch + i * 1_000 + 1 },
        content: [{ id: `text-${i}`, type: "text", text },
          ...(i % 5 === 3 ? [{ id: `tool-${i}`, type: "tool", name: "read", time: { created: epoch + i * 1_000 },
            state: { status: "completed", input: { path: "src/chat/ui.ts" }, content: [{ type: "text", text: output }] } }] : [])] });
    } else {
      legacy.push({ info: { id: `message-${i}`, sessionID: "fixture", role: "user", time: { created: epoch + i * 1_000 } },
        parts: [{ id: `text-${i}`, type: "text", text },
          ...(i % 5 === 0 ? [{ id: `image-${i}`, type: "file", mime: "image/png", filename: image.name, url: "data:image/png;base64,iVBORw0KGgo=" }] : [])] });
    }
  }
  return { v2, legacy };
}

export function workloadBytes(count: number) {
  const encoder = new TextEncoder();
  const native = opencodeHistoryWorkload(count);
  return { items: count, uiBytes: encoder.encode(JSON.stringify(chatWorkload(count))).byteLength,
    claudeBytes: encoder.encode(claudeHistoryWorkload(count)).byteLength,
    opencodeV2Bytes: encoder.encode(JSON.stringify(native.v2)).byteLength,
    opencodeLegacyBytes: encoder.encode(JSON.stringify(native.legacy)).byteLength };
}
