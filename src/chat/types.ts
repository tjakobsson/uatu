export type ChatAvailability =
  | { state: "idle" }
  | { state: "starting" }
  | { state: "ready"; version: string }
  | { state: "unavailable"; reason: "not-installed" | "startup-failed" | "unsupported"; message: string };

export type ConversationStatus = "idle" | "sending" | "running" | "completed" | "interrupted" | "failed";
export type ActivityStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type ModelSelection = {
  providerId: string;
  modelId: string;
};

export type ChatModel = {
  selection: ModelSelection;
  provider: string;
  name: string;
};

export type ChatCommand = {
  name: string;
  description: string;
  argumentHint: string;
  kind: "command" | "skill";
};

export type ConversationSummary = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: ConversationStatus;
};

type TimelineItemBase = {
  id: string;
  createdAt: number;
};

export type UserMessageItem = TimelineItemBase & {
  type: "user_message";
  text: string;
  requestId?: string;
};

export type AssistantMessageItem = TimelineItemBase & {
  type: "assistant_message";
  markdown: string;
  completedAt?: number;
};

export type ReasoningItem = TimelineItemBase & {
  type: "reasoning";
  text: string;
  status: ActivityStatus;
  // How long the model thought, when the provider reports it (history parts
  // carry start/end) or the event stream lets us measure it.
  durationMs?: number;
};

export type ToolItem = TimelineItemBase & {
  type: "tool";
  name: string;
  status: ActivityStatus;
  input?: string;
  output?: string;
  error?: string;
  // The child session a `task` tool ran as, when the provider reports one —
  // what makes a subagent transcript openable as its own conversation.
  childConversationId?: string;
};

export type CommandItem = TimelineItemBase & {
  type: "command";
  command: string;
  status: ActivityStatus;
  output?: string;
  exitCode?: number;
};

export type FileChangeItem = TimelineItemBase & {
  type: "file_change";
  path: string;
  operation: "create" | "update" | "delete";
  additions?: number;
  deletions?: number;
};

export type PermissionOutcome = "approved-once" | "approved-session" | "rejected";

export type PermissionRequest = TimelineItemBase & {
  type: "permission";
  requestId: string;
  action: string;
  resources: string[];
  status: "pending" | "resolved";
  outcome?: PermissionOutcome;
};

export type QuestionOption = {
  label: string;
  description: string;
};

export type StructuredQuestion = {
  prompt: string;
  header: string;
  options: QuestionOption[];
  multiple: boolean;
  allowFreeForm: boolean;
};

export type QuestionOutcome =
  | { kind: "answered"; answers: string[][] }
  | { kind: "rejected" };

export type QuestionRequest = TimelineItemBase & {
  type: "question";
  requestId: string;
  questions: StructuredQuestion[];
  status: "pending" | "resolved";
  outcome?: QuestionOutcome;
};

export type TurnStatusItem = TimelineItemBase & {
  type: "turn_status";
  status: ConversationStatus;
  message?: string;
};

export type NoticeItem = TimelineItemBase & {
  type: "notice";
  level: "info" | "warning" | "error";
  message: string;
};

export type ConversationItem =
  | UserMessageItem
  | AssistantMessageItem
  | ReasoningItem
  | ToolItem
  | CommandItem
  | FileChangeItem
  | PermissionRequest
  | QuestionRequest
  | TurnStatusItem
  | NoticeItem;

export type InteractionRequest = PermissionRequest | QuestionRequest;

export type ConversationSnapshot = {
  conversation: ConversationSummary;
  generation: string;
  cursor: string;
  items: ConversationItem[];
  olderCursor?: string;
};

type ChatEventBase = {
  generation: string;
  sequence: number;
  conversationId: string;
};

export type ChatEvent = ChatEventBase & (
  | { type: "item.upsert"; item: ConversationItem }
  | { type: "item.remove"; itemId: string }
  | { type: "item.text_delta"; itemId: string; delta: string }
  | { type: "conversation.status"; status: ConversationStatus; message?: string }
  | { type: "resync"; reason: "generation-changed" | "retention-gap" | "invalid-cursor" }
);
