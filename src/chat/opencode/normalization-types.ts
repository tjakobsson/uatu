/** Native text completion seals Markdown syntax, not the parent message/turn. */
export const OPENCODE_TEXT_END = Symbol("opencode-text-end");
export type OpenCodeTextIdentity = { [OPENCODE_TEXT_END]?: true };
