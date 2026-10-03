/**
 * The seam between the Hub's account service and each agent's own login
 * interface (design D2). One adapter per agent and generation; the service
 * owns attempts, runtimes and the wire, and never sees an agent's protocol.
 */

import { AccountFieldError, collectAnswers } from "./agent-account-fields";
import type { LoopbackCallback } from "./agent-account-redirect";
import type {
  AccountCapabilities,
  AccountCompletion,
  AccountField,
  AccountMethod,
  AccountTarget,
  ClaudeAccountState,
} from "./agent-account-types";

export type AccountAdapterStatus = {
  version?: string;
  generation?: 1 | 2;
  targets: AccountTarget[];
  methods: AccountMethod[];
  claude?: ClaudeAccountState;
};

/**
 * A login the agent has started. `waitForCompletion` settles when the agent
 * says the login completed and rejects with the agent's message when it
 * failed. For a `code` login it waits for `submitCode`.
 */
export type StartedLogin = {
  url: string;
  instructions: string;
  completion: AccountCompletion;
  /** For `redirect`: the loopback listener the pasted address must target. */
  callback: LoopbackCallback | null;
  /** The agent's own deadline, when it states one (epoch ms). */
  expiresAt?: number;
  waitForCompletion(): Promise<void>;
  submitCode?(code: string): Promise<void>;
  cancel(): Promise<void>;
};

export class AccountOperationError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = "AccountOperationError";
  }
}

/** The agent's own deadline passed; the service reports `expired` rather than `failed`. */
export class AttemptExpiredError extends AccountOperationError {
  constructor() {
    super("The login expired before it was completed.");
    this.name = "AttemptExpiredError";
  }
}

/** Submitted answers checked against a method's fields, as an operation error naming the field. */
export function validatedAnswers(fields: AccountField[], answers: Record<string, unknown>): ReturnType<typeof collectAnswers> {
  try {
    return collectAnswers(fields, answers);
  } catch (error) {
    if (error instanceof AccountFieldError) throw new AccountOperationError(error.message, error.field);
    throw error;
  }
}

export interface AccountAdapter {
  readonly capabilities: AccountCapabilities;
  status(): Promise<AccountAdapterStatus>;
  /** `answers` are the raw submitted strings; the adapter validates them against the method's fields. */
  connectKey(target: string, methodId: string, key: string, answers: Record<string, unknown>): Promise<void>;
  startLogin(target: string, methodId: string, answers: Record<string, unknown>): Promise<StartedLogin>;
  logout(target: string, credentialId: string): Promise<void>;
  activate(credentialId: string): Promise<void>;
  dispose(): Promise<void>;
}

/** The agent's own message from a failed SDK call, without request details. */
export function agentErrorMessage(error: unknown, fallback: string): string {
  const visit = (value: unknown, depth: number): string | undefined => {
    if (depth > 3 || value === null || value === undefined) return undefined;
    if (typeof value === "string") return value.trim() || undefined;
    if (value instanceof Error && value.message && !/^\[object /.test(value.message)) {
      return visit((value as { cause?: unknown }).cause, depth + 1) ?? value.message;
    }
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      return visit(record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>).message : undefined, depth + 1)
        ?? visit(record.message, depth + 1)
        ?? visit(record.error, depth + 1);
    }
    return undefined;
  };
  const message = visit(error, 0);
  return message ? message.slice(0, 500) : fallback;
}
