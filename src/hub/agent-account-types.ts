/**
 * The Agent accounts wire model: what the Hub publishes about the machine's
 * agent logins at `/api/hub/agent-accounts`, normalized across OpenCode 1.x,
 * OpenCode 2.x and Claude Code so the Settings page has one form renderer and
 * one attempt view.
 *
 * Nothing in this model carries a secret. Keys, tokens, authorization codes
 * and pasted redirect addresses travel only inbound, in mutation bodies, and
 * are handed to the agent without being stored or echoed.
 */

import type { ClaudeAccountState } from "../chat/claude/account";

export type AccountAgentId = "opencode" | "claude";

/** A condition on an earlier field's answer; every condition must hold for the field to show. */
export type AccountFieldCondition = { key: string; op: "eq" | "neq"; value: string };

export type AccountFieldOption = { value: string; label: string; hint?: string };

/**
 * One extra field a login method asks for. `valueType` says how the answer is
 * sent back to the agent: the page always submits strings, and the Hub
 * converts them before handing them on.
 */
export type AccountField = {
  key: string;
  label: string;
  kind: "text" | "select";
  valueType: "string" | "number" | "boolean" | "list";
  required: boolean;
  placeholder?: string;
  description?: string;
  options?: AccountFieldOption[];
  when?: AccountFieldCondition[];
};

/**
 * How a login method is used.
 * - `key`: a masked key field plus `fields`, submitted to the agent.
 * - `oauth`: a browser or device-code login; `fields` are asked before it starts.
 * - `env`: the agent reads `variables` from its environment; nothing to submit.
 * - `command`: the agent runs a local helper; the user runs `command` instead.
 */
export type AccountMethod =
  | { id: string; kind: "key"; label: string; fields: AccountField[] }
  | { id: string; kind: "oauth"; label: string; fields: AccountField[]; completion?: AccountCompletion }
  | { id: string; kind: "env"; label: string; variables: string[] }
  | { id: string; kind: "command"; label: string; command: string };

/** How the user finishes a started login. */
export type AccountCompletion = "device" | "code" | "redirect";

/**
 * Where a login came from, as far as the agent says.
 * - `key`, `oauth`: saved through a key or browser login (OpenCode 2.x says which).
 * - `saved`: saved through a login, kind not reported (OpenCode 1.x).
 * - `env`: read from the agent's environment.
 * - `config`: set in the agent's configuration file.
 * - `other`: anything else the agent reports, such as a built-in free provider.
 */
export type AccountCredentialKind = "key" | "oauth" | "saved" | "env" | "config" | "other";

export type AccountCredential = {
  /** The agent's own credential id where it has one (OpenCode 2.x), else the target id. */
  id: string;
  label: string;
  kind: AccountCredentialKind;
  active: boolean;
  removable: boolean;
  /** For `env`: the variable names the agent reads. */
  variables?: string[];
  /** The agent's own status message for the credential, such as needing reauthentication. */
  status?: string;
};

/** One OpenCode provider (1.x) or integration (2.x). */
export type AccountTarget = {
  id: string;
  name: string;
  connected: boolean;
  credentials: AccountCredential[];
  methods: AccountMethod[];
};

/** How Claude Code is authenticated, as `accountInfo()` reports it (see `src/chat/claude/account.ts`). */
export type { ClaudeAccountState, ClaudeLoginSource } from "../chat/claude/account";

export type AccountCapabilities = {
  login: boolean;
  logout: boolean;
  activate: boolean;
};

export type AccountAgentState = "idle" | "starting" | "ready" | "not-installed" | "unavailable";

export type AccountAgentStatus = {
  agent: AccountAgentId;
  name: string;
  state: AccountAgentState;
  version?: string;
  /** OpenCode only: which server API answered. */
  generation?: 1 | 2;
  /** Set for `not-installed` and `unavailable`: what went wrong, safe to show. */
  message?: string;
  capabilities: AccountCapabilities;
  /** OpenCode: providers or integrations. Empty for Claude Code. */
  targets: AccountTarget[];
  /** Claude Code: the login in effect. Absent for OpenCode. */
  claude?: ClaudeAccountState;
  /** Claude Code: the login methods offered. Empty for OpenCode (methods sit on targets). */
  methods: AccountMethod[];
  /** What to run in a terminal when the Hub cannot do the login itself. */
  loginCommand: string;
};

export type AccountAttemptState = "pending" | "complete" | "failed" | "expired" | "cancelled";

export type AccountAttempt = {
  id: string;
  agent: AccountAgentId;
  /** The provider or integration id; `claude` for Claude Code. */
  target: string;
  methodId: string;
  url: string;
  instructions: string;
  completion: AccountCompletion;
  state: AccountAttemptState;
  /** For `failed`: the agent's message, never a code or token. */
  message?: string;
  startedAt: number;
  expiresAt: number;
};

export type AgentAccountsSnapshot = {
  agents: AccountAgentStatus[];
  attempts: AccountAttempt[];
};
