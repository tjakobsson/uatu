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
  | "subagents"
  // The selected model offers named reasoning variants (thinking harder/faster).
  | "variants"
  // The agent reports token usage per message, so Chat can say how full the
  // context window is and what each subagent cost.
  | "context"
  | "conversation-rename"
  | "reversible-history"
  // The agent accepts image attachments on a prompt. Whether a particular
  // model can see them is per-model (`ChatModel.imageInput`), not per-agent.
  | "attachments";

// Image attachment bounds, shared by the composer (intake refusal), the
// upload route (authoritative enforcement), and the store. 10 MiB sits
// safely under OpenCode's 20 MiB decoded per-item cap while leaving room
// for its server-side resize budget.
export const CHAT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_ATTACHMENTS_PER_MESSAGE = 8;
// The image formats OpenCode supports as model-visible attachments. SVG is
// deliberately absent (OpenCode treats it as text), as is PDF (unsupported).
export const CHAT_ATTACHMENT_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

// An image riding a user message, referenced by store id — never by bytes
// (spec: attachment bytes stay out of the conversation transport). `id` is
// absent on a replayed attachment whose reference could not be recovered;
// the client renders those as labeled placeholders.
export type MessageAttachment = {
  id?: string;
  name: string;
  mimeType: string;
};

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

export type ConversationConfiguration = {
  model?: ModelSelection;
  mode?: string;
  // A variant always qualifies the selected model; it is invalid on its own.
  variant?: string;
};

export type ChatModel = {
  selection: ModelSelection;
  provider: string;
  name: string;
  // The reasoning variants this model advertises (OpenCode reports them as a
  // keyed map; these are its keys). Absent or empty when the model offers none.
  variants?: string[];
  // The model's context-window size in tokens, when the agent reports it.
  contextLimit?: number;
  // Whether this model can see image attachments, as the agent reports it.
  // Drives the attach control's inactive state; absent means not reported,
  // which the surface treats as no.
  imageInput?: boolean;
};

export type ChatCommand = {
  name: string;
  description: string;
  argumentHint: string;
  kind: "command" | "skill" | "local-operation";
};

export type RestoredDraft = {
  text: string;
  attachments?: MessageAttachment[];
};

export type RevertedUserMessage = {
  id: string;
  text: string;
};

export type ReversibleHistoryState = {
  staged: boolean;
  canUndo: boolean;
  canRedo: boolean;
  revertedMessages: RevertedUserMessage[];
};

export type ReversibleHistoryResult = {
  outcome: "changed" | "nothing-to-undo" | "nothing-to-redo";
  state: ReversibleHistoryState;
  restoredDraft?: RestoredDraft;
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
  // Images sent with this message, as references (see MessageAttachment).
  attachments?: MessageAttachment[];
};

/**
 * What a message spent, as the agent reports it. Absent fields mean the agent
 * did not report that component — never zero, because "no cache read" and "not
 * told" are different statements and a readout that conflates them asserts a
 * figure it does not have.
 *
 * The window fill is `input + cacheRead + cacheWrite`: the prompt the most
 * recent request carried, which already includes the conversation so far. It
 * deliberately excludes `output`, which is what came back rather than what is
 * occupying the window.
 */
export type TokenUsage = {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type AssistantMessageItem = TimelineItemBase & {
  type: "assistant_message";
  markdown: string;
  completedAt?: number;
  // Message-level accounting rides a dedicated empty-markdown carrier.
  usage?: TokenUsage;
  // The model that reported this carrier's usage, so a context percentage is
  // measured against that model's window even after another model is selected.
  model?: ModelSelection;
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
  // A subagent's own model and token cost, aggregated from its child session
  // and mirrored here — the client holds one conversation's projection and can
  // never read a child's, so the attribution has to be materialized onto the
  // row that launched it. Absent until the child has reported something.
  model?: string;
  usage?: TokenUsage;
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
  // A unified diff of the change a file-edit permission would apply, when the
  // agent attaches one (OpenCode puts it on the permission's `metadata.diff`).
  // Absent for a permission with nothing to show — a command, a fetch.
  diff?: string;
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

// A prompt accepted while the conversation was busy, held by this workspace
// and not yet delivered to the agent. Not a timeline item: it has no position
// in the transcript until delivery, which is what lets it stay pinned at the
// composer and removable. `id` is the handle removal addresses. `requestId`
// echoes the accepting mutation's client request id so the submitting
// client's optimistic draft retires the moment the held entry appears.
export type QueuedMessage = {
  id: string;
  text: string;
  queuedAt: number;
  requestId?: string;
  // Attachment references held with the message; delivered exactly as
  // submitted, discarded with the message on removal.
  attachments?: MessageAttachment[];
};

export type ConversationSnapshot = {
  conversation: ConversationSummary;
  configuration: ConversationConfiguration;
  generation: string;
  cursor: string;
  items: ConversationItem[];
  // Held messages in submission order. Optional on the wire so a snapshot
  // producer with no queue concept stays parseable; absent means empty.
  queued?: QueuedMessage[];
  reversibleHistory?: ReversibleHistoryState;
  olderCursor?: string;
};

export type ConversationInventoryEvent = {
  type: "conversation.inventory";
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
  | { type: "conversation.configuration"; configuration: ConversationConfiguration }
  | { type: "conversation.updated"; conversation: ConversationSummary }
  // Restates the whole held queue rather than shipping a diff: replayed or
  // duplicated frames converge on the same state, and a client that missed
  // nothing pays only the few queued entries a conversation can hold. `change`
  // names what happened for announcements.
  | { type: "conversation.queue"; queued: QueuedMessage[]; change: { kind: "held" | "removed" | "delivered"; messageId: string } }
  | { type: "resync"; reason: "generation-changed" | "retention-gap" | "invalid-cursor" | "conversation-rewritten" }
);
