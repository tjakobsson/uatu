/** Opaque, versioned fingerprints: presentation storage must not copy chat text. */
export function markdownBlockKey(context: string, text: string): string {
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second, 33) ^ code;
  }
  // The Markdown block type is structural context; an identical code block
  // and paragraph are not interchangeable reading locations.
  return `markdown-v1:${context}:${text.length}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
}

export function markdownTextKey(blockKey: string, textOffset: number): string {
  return `${blockKey}:text:${textOffset}`;
}

/** Keep the deployed storage grammar; geometry checks which numbers are usable. */
export function parseMarkdownAnchorKey(key: string) {
  const match = /^(markdown-v1:([a-z0-9-]+):(\d+):[a-z0-9]+:[a-z0-9]+)(?::text:(\d+))?$/.exec(key);
  if (!match) return null;
  const [, blockKey, context, length, textOffset] = match;
  return { blockKey, context, length: Number(length), textOffset: textOffset === undefined ? undefined : Number(textOffset) };
}
