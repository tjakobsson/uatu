import type { ChatVisualMessageIdentity } from "../visual-identity";

/** Internal metadata survives object spreads but never crosses JSON/API boundaries. */
export const CLAUDE_TEXT_BLOCKS = Symbol("claude-text-blocks");
export type ClaudeTextBlock = { id: string; offset: number };
export type ClaudeTextIdentity = ChatVisualMessageIdentity & { [CLAUDE_TEXT_BLOCKS]?: readonly ClaudeTextBlock[] };

/** Resolve a Markdown occurrence relative to its native API text block. */
export function claudeVisualIdentity(item: { id: string } & ClaudeTextIdentity, key?: string): { messageId: string; key?: string } {
  const blocks = item[CLAUDE_TEXT_BLOCKS];
  const offset = key?.match(/^offset:(\d+)$/)?.[1];
  if (blocks?.length && offset !== undefined) {
    const position = Number(offset);
    const block = blocks.findLast(block => block.offset <= position);
    if (block) return { messageId: block.id, key: `offset:${position - block.offset}` };
  }
  if (blocks?.length === 1) return { messageId: blocks[0]!.id, key };
  return { messageId: item.id, key };
}

export function claudeTextBlockId(apiMessageId: string, textOrdinal: number): string {
  return `claude:text:${apiMessageId}:${textOrdinal}`;
}
