import type { ChatCommand, ChatModel, ModelSelection, StructuredQuestion } from "./types";

export type PendingQuestion = { requestId: string; questions: StructuredQuestion[] };
export type PendingPermission = { requestId: string; conversationId: string; action: string; resources: string[] };

export type ProviderSession = {
  id: string;
  title: string;
  directory: string;
  createdAt: number;
  updatedAt: number;
  // Set when this session is a subagent child of another session. Children
  // stay out of the conversation picker and are reached from their parent.
  parentId?: string;
};

export type ProviderPage<T> = {
  items: T[];
  nextCursor?: string;
};

export type ProviderMessage = Record<string, unknown>;
export type ProviderEvent = Record<string, unknown>;

export type ProviderPermissionReply = "once" | "always" | "reject";

export interface OpenCodeProvider {
  listCommands(): Promise<ChatCommand[]>;
  listModels(): Promise<ChatModel[]>;
  switchModel(sessionId: string, selection: ModelSelection): Promise<void>;
  renameSession?(sessionId: string, title: string): Promise<ProviderSession>;
  listSessions(): Promise<ProviderSession[]>;
  createSession(id: string): Promise<ProviderSession>;
  getSession(id: string): Promise<ProviderSession | null>;
  listMessages(sessionId: string, options: { cursor?: string; limit: number }): Promise<ProviderPage<ProviderMessage>>;
  events(signal: AbortSignal): AsyncIterable<ProviderEvent>;
  prompt(sessionId: string, input: { id: string; text: string; delivery: "steer" | "queue"; model?: ModelSelection }): Promise<{ messageId: string }>;
  command(sessionId: string, input: { id: string; name: string; arguments: string; model?: ModelSelection }): Promise<{ messageId: string }>;
  interrupt(sessionId: string): Promise<void>;
  replyPermission(sessionId: string, requestId: string, reply: ProviderPermissionReply): Promise<void>;
  /**
   * Every pending permission request the server holds, each naming the session
   * that owns it. Unfiltered on purpose: a permission is otherwise knowable
   * only from a live event, and OpenCode does not deliver a subagent's request
   * on the main stream — so the caller must be able to see requests owned by a
   * conversation's children, not just its own. Optional: a provider without it
   * simply never recovers a missed request.
   */
  listPermissions?(): Promise<PendingPermission[]>;
  /**
   * Pending question requests owned by a session. OpenCode 1.18 never emits
   * `question.v2.asked` over the event stream, so a pending question is only
   * discoverable by asking. Optional: a provider without it simply never
   * surfaces questions.
   */
  listQuestions?(sessionId: string): Promise<PendingQuestion[]>;
  replyQuestion(sessionId: string, requestId: string, answers: string[][]): Promise<void>;
  rejectQuestion(sessionId: string, requestId: string): Promise<void>;
}
