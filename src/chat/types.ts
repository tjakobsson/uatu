// What the last health probe actually did. Four of these used to collapse into
// one indistinguishable timeout string; they are four different bugs.
// `unknown` exists so an error shape the classifier does not recognize degrades
// attribution instead of being misreported as a refusal.
export type ChatProbeOutcome =
  | { kind: "none" }
  | { kind: "refused" }
  | { kind: "abandoned" }
  | { kind: "http-status"; status: number }
  | { kind: "unhealthy-body"; status: number }
  | { kind: "healthy"; status: number }
  | { kind: "unknown"; error: string };

// Evidence attached to a failed startup so a bug report diagnoses itself
// without asking the user to reproduce anything. Assembled on the failure path
// only. Never carries the ephemeral OpenCode server password.
export type ChatStartupDiagnostics = {
  executable: string | null;
  // Other `opencode` executables found earlier or later on PATH. A Windows
  // shim shadowing a Linux binary under WSL2 is invisible without this.
  shadowedExecutables: string[];
  version: string | null;
  endpoint: string | null;
  elapsedMs: number;
  probes: number;
  lastProbe: ChatProbeOutcome;
  stdout: string;
  stderr: string;
};

// A capability the surface can present. Positively declared only: a capability
// is in an agent's list or the agent does not have it. No `false` and no
// `unknown` — two ways to say "no" eventually disagree, and the surface would
// have to pick one to believe. Extended one key at a time, by the change that
// adds the feature behind it.
export type ChatCapability =
  | "modes"
  | "models"
  | "commands"
  | "questions"
  | "permissions"
  | "subagents";

// What Chat is talking to. One agent per workspace today, but the surface
// takes its name and its controls from this record rather than from fixed
// copy, so a second agent changes what is reported and not what is written.
export type ChatAgent = {
  id: string;
  name: string;
  capabilities: ChatCapability[];
};

export type ChatAvailability =
  | { state: "idle" }
  | { state: "starting" }
  // `agent` is absent for the moment between the runtime reporting ready and
  // the adapter existing to describe it. A surface that has no agent yet says
  // nothing about one rather than guessing a name.
  | { state: "ready"; version: string; agent?: ChatAgent }
  | {
    state: "unavailable";
    reason: "not-installed" | "startup-failed" | "unsupported";
    message: string;
    diagnostics?: ChatStartupDiagnostics;
  };

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

// A way of working a prompt can run under — the agent's own named modes
// (Build, Plan, ...). Not the agent itself, and not a subagent: subagents are
// spawned by the task tool, never chosen.
export type ChatMode = {
  name: string;
  description: string;
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
  // The conversation that owns this request — its own, except when a subagent's
  // request is shown in the conversation that launched it. Answers are always
  // addressed here, so one `requirePending` guard and one receipt key govern
  // the reply however many places showed the card.
  conversationId?: string;
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
  // See PermissionRequest.conversationId.
  conversationId?: string;
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
