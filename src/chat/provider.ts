import type { ChatAgent, ChatMode, ChatCommand, ChatModel, ConversationConfiguration, ModelSelection, StructuredQuestion } from "./types";

// `conversationId` is the owning session, like PendingPermission's: the global
// list is filtered by the adapter, which is what lets a parent discover its
// children's pending questions.
export type PendingQuestion = { requestId: string; conversationId: string; questions: StructuredQuestion[] };
// `diff` is the change a file-edit permission would apply (OpenCode's
// `metadata.diff`), carried through recovery so a card rebuilt after a missed
// event shows the same change the live announcement would have.
export type PendingPermission = { requestId: string; conversationId: string; action: string; resources: string[]; diff?: string };

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

export class UnsupportedVariantSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedVariantSelectionError";
  }
}

export type ProviderPermissionReply = "once" | "always" | "reject";

export interface OpenCodeProvider {
  /**
   * Who this provider is and what it offers, for the surface to name and to
   * gate its controls on. The provider declares its own capabilities because
   * it is the only thing that knows them; the adapter passes the declaration
   * through without adding to it.
   */
  describe(): ChatAgent;
  listCommands(): Promise<ChatCommand[]>;
  listModels(): Promise<ChatModel[]>;
  /**
   * Modes a prompt can run under (Build, Plan, ...). Optional: a provider
   * without it simply never offers a choice. Without the choice a session
   * stuck in a read-only mode is stuck for good.
   */
  listModes?(): Promise<ChatMode[]>;
  switchModel(sessionId: string, selection: ModelSelection, variant?: string): Promise<void>;
  renameSession?(sessionId: string, title: string): Promise<ProviderSession>;
  listSessions(): Promise<ProviderSession[]>;
  newConversationConfiguration(): Promise<ConversationConfiguration>;
  createSession(id: string, configuration?: ConversationConfiguration): Promise<ProviderSession>;
  getSession(id: string): Promise<ProviderSession | null>;
  getConversationConfiguration(sessionId: string, messages?: ProviderMessage[]): Promise<ConversationConfiguration>;
  listMessages(sessionId: string, options: { cursor?: string; limit: number }): Promise<ProviderPage<ProviderMessage>>;
  events(signal: AbortSignal): AsyncIterable<ProviderEvent>;
  prompt(sessionId: string, input: { id: string; text: string; delivery: "steer" | "queue"; model?: ModelSelection; mode?: string; variant?: string }): Promise<{ messageId: string }>;
  command(sessionId: string, input: { id: string; name: string; arguments: string; model?: ModelSelection; mode?: string; variant?: string }): Promise<{ messageId: string }>;
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
   * Every pending question request, each carrying its owning session.
   * OpenCode 1.18 never emits `question.v2.asked` over the event stream, so a
   * pending question is only discoverable by asking — and the adapter filters
   * the global list, which is what lets a parent recover a subagent's
   * question. Optional: a provider without it simply never surfaces questions.
   */
  listQuestions?(): Promise<PendingQuestion[]>;
  replyQuestion(sessionId: string, requestId: string, answers: string[][]): Promise<void>;
  rejectQuestion(sessionId: string, requestId: string): Promise<void>;
}
