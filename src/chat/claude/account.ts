/**
 * What Claude Code says about the login in effect (`accountInfo()`), and how
 * that maps to a login source. Shared by the chat provider, which needs to
 * know whether a turn can run, and the Hub's Agent accounts, which shows and
 * changes the login. The rules follow the CLI's own: an environment API key
 * wins over a saved login, a third-party provider reports nothing else.
 */

import type { ChatLoginState } from "../types";

export type ClaudeAccountInfo = {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: string;
};

export type ClaudeLoginSource =
  | "subscription"
  | "console"
  | "env-api-key"
  | "env-token"
  | "api-key-helper"
  | "third-party"
  | "none"
  | "unknown";

export type ClaudeAccountState = {
  source: ClaudeLoginSource;
  email?: string;
  organization?: string;
  plan?: string;
  provider?: string;
};

/** How Claude Code is authenticated, from the CLI's own `accountInfo` rules. */
export function claudeAccountState(info: ClaudeAccountInfo): ClaudeAccountState {
  const details = {
    ...(info.email ? { email: info.email } : {}),
    ...(info.organization ? { organization: info.organization } : {}),
    ...(info.subscriptionType ? { plan: info.subscriptionType } : {}),
  };
  if (info.apiProvider && info.apiProvider !== "firstParty") return { source: "third-party", provider: info.apiProvider };
  // A key from the environment wins over a saved login, which is why it is checked first.
  if (info.apiKeySource === "ANTHROPIC_API_KEY") return { source: "env-api-key", ...details };
  if (info.apiKeySource === "apiKeyHelper" || info.tokenSource === "apiKeyHelper") return { source: "api-key-helper", ...details };
  if (info.subscriptionType) return { source: "subscription", ...details };
  if (info.apiKeySource === "/login managed key") return { source: "console", ...details };
  if (info.tokenSource === "CLAUDE_CODE_OAUTH_TOKEN" || info.tokenSource === "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR" || info.tokenSource === "ANTHROPIC_AUTH_TOKEN") {
    return { source: "env-token", ...details };
  }
  const source: ClaudeLoginSource = (info.tokenSource === undefined || info.tokenSource === "none") && !info.apiKeySource ? "none" : "unknown";
  return { source, ...details };
}

/** Whether a turn can run under this login, for the chat's availability. */
export function claudeLoginState(state: ClaudeAccountState): ChatLoginState {
  if (state.source === "none") return "missing";
  return state.source === "unknown" ? "unknown" : "ok";
}

/** `accountInfo()`'s answer, kept only when it is an object. */
export function parseClaudeAccountInfo(value: unknown): ClaudeAccountInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = (key: string) => typeof record[key] === "string" && record[key] ? { [key]: record[key] as string } : {};
  return { ...text("email"), ...text("organization"), ...text("subscriptionType"), ...text("tokenSource"), ...text("apiKeySource"), ...text("apiProvider") };
}
