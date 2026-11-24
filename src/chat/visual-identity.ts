/** Internal native-message identity; object spreads retain it, JSON omits it. */
export const CHAT_VISUAL_MESSAGE = Symbol("chat-visual-message");
export type ChatVisualMessageIdentity = { [CHAT_VISUAL_MESSAGE]?: string };

/** The native text blocks joined into one reply's Markdown, each with the
 * offset where it starts. Captures are then identified relative to their
 * block, so a streamed block and its joined completion share them. */
export const CHAT_TEXT_BLOCKS = Symbol("chat-text-blocks");
export type ChatTextBlock = { id: string; offset: number };
export type ChatVisualIdentity = ChatVisualMessageIdentity & { [CHAT_TEXT_BLOCKS]?: readonly ChatTextBlock[] };

/** Text parts share admissions, but retain their own capture and timeline IDs.
 * The stored capture ledger hashes this string: it must never change for an
 * agent that has shipped. */
export function nativeVisualMessageIdentity(agentId: string, messageId: string | undefined): ChatVisualMessageIdentity {
  return messageId === undefined ? {} : { [CHAT_VISUAL_MESSAGE]: `${agentId}:message:${messageId}` };
}

export function visualAdmissionIdentity(item: { id: string } & ChatVisualMessageIdentity): string {
  return item[CHAT_VISUAL_MESSAGE] ?? item.id;
}

/** Resolve a Markdown occurrence relative to its native text block. A reply
 * without blocks is its own capture identity. */
export function visualCaptureIdentity(item: { id: string } & ChatVisualIdentity, key?: string): { messageId: string; key?: string } {
  const blocks = item[CHAT_TEXT_BLOCKS];
  const offset = key?.match(/^offset:(\d+)$/)?.[1];
  if (blocks?.length && offset !== undefined) {
    const position = Number(offset);
    const block = blocks.findLast(block => block.offset <= position);
    if (block) return { messageId: block.id, key: `offset:${position - block.offset}` };
  }
  if (blocks?.length === 1) return { messageId: blocks[0]!.id, key };
  return { messageId: item.id, key };
}
