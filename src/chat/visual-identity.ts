/** Internal native-message identity; object spreads retain it, JSON omits it. */
export const CHAT_VISUAL_MESSAGE = Symbol("chat-visual-message");
export type ChatVisualMessageIdentity = { [CHAT_VISUAL_MESSAGE]?: string };

/** Text parts share admissions, but retain their own capture and timeline IDs. */
export function nativeVisualMessageIdentity(provider: "claude" | "opencode", messageId: string | undefined): ChatVisualMessageIdentity {
  return messageId === undefined ? {} : { [CHAT_VISUAL_MESSAGE]: `${provider}:message:${messageId}` };
}

export function visualAdmissionIdentity(item: { id: string } & ChatVisualMessageIdentity): string {
  return item[CHAT_VISUAL_MESSAGE] ?? item.id;
}
