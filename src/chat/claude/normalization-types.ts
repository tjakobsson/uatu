/** The persisted capture identity of one native API text block. */
export function claudeTextBlockId(apiMessageId: string, textOrdinal: number): string {
  return `claude:text:${apiMessageId}:${textOrdinal}`;
}
