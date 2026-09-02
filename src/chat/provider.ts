import type { ChatAgent, ChatMode, ChatCommand, ChatModel, ConversationConfiguration, ConversationItem, ConversationStatus, ModelSelection, PermissionChoice, ReversibleHistoryResult, ReversibleHistoryState, StructuredQuestion, TokenUsage } from "./types";

// `conversationId` is the owning session, like PendingPermission's: the global
// list is filtered by the adapter, which is what lets a parent discover its
// children's pending questions.
export type PendingQuestion = {
  requestId: string;
  conversationId: string;
  questions: StructuredQuestion[];
  // A dialog or elicitation carries its context so a card rebuilt after a
  // missed announcement reads the same as the live one.
  source?: "dialog" | "elicitation";
  intro?: string;
  link?: string;
  schema?: Record<string, unknown>;
};
// `diff` is the change a file-edit permission would apply (OpenCode's
// `metadata.diff`), carried through recovery so a card rebuilt after a missed
// event shows the same change the live announcement would have.
export type PendingPermission = { requestId: string; conversationId: string; action: string; resources: string[]; diff?: string; plan?: string; choices?: PermissionChoice[] };

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

/**
 * The seam speaks the shared timeline model, never an agent's wire format.
 * Each provider owns its normalization; what crosses here is what the
 * adapter can apply directly. (D2: normalization lives below this seam.)
 */
export type NormalizedProviderUpdate =
  | { kind: "upsert"; item: ConversationItem }
  | { kind: "text"; itemId: string; identity: string; mode: "cumulative" | "incremental"; text: string; item?: ConversationItem }
  | { kind: "remove"; itemId: string }
  | { kind: "status"; status: ConversationStatus; message?: string };

export type NormalizedSessionLifecycle = {
  kind: "created" | "updated" | "deleted";
  id: string;
  directory: string;
  title: string;
  parentId?: string;
};

// Why an event produced no updates. Without this an unrecognized event and one
// we deliberately ignore are the same empty value to the caller, so a counter
// over them would either miss real drops or inflate on expected ones.
export type NormalizedEventOutcome =
  | "handled"
  // Recognized, and correctly produced nothing (a status we already hold, a
  // streaming frame whose start and end are enough).
  | "ignored"
  // No case matched: the provider does not know this event type at all.
  | "unrecognized"
  // A case matched but the payload did not carry what that case requires.
  | "unparseable";

export type NormalizedProviderEvent = {
  conversationId?: string;
  updates: NormalizedProviderUpdate[];
  outcome: NormalizedEventOutcome;
  // The event's own type, so a caller can count drops per type. Never a
  // payload — a payload can carry file contents.
  eventType: string;
  // The model the assistant message ran, when the event states it. Reported on
  // the envelope rather than on an item: it belongs to the message, and the
  // one thing that needs it — attributing a subagent on its parent's row —
  // reads it from the child's event stream, not from the child's timeline.
  assistantModel?: { messageId: string; model: string; createdAt: number };
  // The tokens a message reported, with the message's own id. A message can
  // produce several parts, so aggregation keys on this id rather than counting
  // the dedicated usage carrier as though it were another content part.
  assistantUsage?: { messageId: string; usage: TokenUsage };
  // A deleted assistant message must also leave any aggregate keyed by its
  // provider id; timeline removes alone cannot reach the adapter's tally.
  removedMessageId?: string;
  configuration?: ConversationConfiguration;
  // A model switch without a variant explicitly clears the previous variant.
  replaceModel?: boolean;
  // Inventory identity deliberately excludes provider timestamps. They change
  // during ordinary session activity without changing picker membership.
  sessionLifecycle?: NormalizedSessionLifecycle;
  // Revert lifecycle events invalidate the visible transcript. The adapter
  // fetches provider history rather than presenting these events as notices.
  revertLifecycle?: "staged" | "committed" | "cleared";
};

// What one stored message reported about cost and model, keyed by the
// message's own provider id — the aggregation input for subagent attribution,
// which the timeline's usage carriers cannot serve (they are items, not
// per-message records).
export type StoredMessageAccounting = { messageId: string; createdAt: number; usage?: TokenUsage; model?: string };

export type ProviderHistoryPage = {
  // Normalized timeline items for this page, in the provider's part order.
  items: ConversationItem[];
  // Accounting for the stored messages underlying this page's items.
  accounting: StoredMessageAccounting[];
  // Providers that page locally over a fully loaded transcript can expose the
  // complete normalized items, so a walker that needs the whole conversation
  // (title derivation) avoids refetching the transcript once per page.
  completeItems?: ConversationItem[];
  nextCursor?: string;
};

export class UnsupportedVariantSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedVariantSelectionError";
  }
}

/**
 * An answer the request's own schema refuses (a fraction for an integer
 * field, a value outside its range). Thrown before the interaction settles,
 * so the card stays pending and the user can correct it.
 */
export class InvalidQuestionAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidQuestionAnswerError";
  }
}

export class ReversibleHistoryTargetError extends Error {
  constructor(message = "reversible-history message is no longer available") {
    super(message);
    this.name = "ReversibleHistoryTargetError";
  }
}

export type ProviderPermissionReply = "once" | "always" | "reject";

// Provider-neutral by contract: identity, display name, mime, and where the
// stored bytes live on disk. How an attachment reaches the agent (file: URL,
// inline base64, multipart, ...) is each provider's own concern — nothing
// OpenCode-shaped may leak into this type, so a future non-OpenCode provider
// reuses the store, routes, and UI unchanged.
export type ProviderAttachment = {
  id: string;
  name: string;
  mimeType: string;
  absolutePath: string;
};

export interface ChatProvider {
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
  getConversationConfiguration(sessionId: string): Promise<ConversationConfiguration>;
  listMessages(sessionId: string, options: { cursor?: string; limit: number }): Promise<ProviderHistoryPage>;
  getReversibleHistoryState?(sessionId: string): Promise<ReversibleHistoryState>;
  undo?(sessionId: string): Promise<ReversibleHistoryResult>;
  redo?(sessionId: string): Promise<ReversibleHistoryResult>;
  revert?(sessionId: string, messageId: string): Promise<ReversibleHistoryResult>;
  restore?(sessionId: string, messageId: string): Promise<ReversibleHistoryResult>;
  events(signal: AbortSignal): AsyncIterable<NormalizedProviderEvent>;
  /**
   * Retire the provider's own resources — live agent sessions, pending
   * tool callbacks, background probes. The adapter awaits this as part of
   * its own disposal, so a retired adapter leaves no agent process behind.
   */
  dispose?(): Promise<void>;
  prompt(sessionId: string, input: { id: string; text: string; delivery: "queue"; attachments?: ProviderAttachment[]; model?: ModelSelection; mode?: string; variant?: string }): Promise<{ messageId: string }>;
  command(sessionId: string, input: { id: string; name: string; arguments: string; model?: ModelSelection; mode?: string; variant?: string }): Promise<{ messageId: string }>;
  interrupt(sessionId: string): Promise<void>;
  replyPermission(sessionId: string, requestId: string, reply: ProviderPermissionReply, choiceId?: string): Promise<void>;
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
