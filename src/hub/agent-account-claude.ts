/**
 * Agent accounts for Claude Code, through the agent SDK.
 *
 * - Status: `accountInfo()` (declared) on a short-lived promptless session.
 *   A fresh session per read, so a login or logout made in a terminal shows
 *   on the next read; reads within a few seconds share one answer.
 * - Login: the SDK's undeclared `claudeAuthenticate(loginWithClaudeAi)`,
 *   `claudeOAuthCallback(code, state)` and `claudeOAuthWaitForCompletion()`.
 *   The CLI answers them (verified against CLI 2.1.281 / SDK 0.3.286), but the
 *   SDK's type declarations do not list them, so they are feature-detected on
 *   the session object. When they are missing, login is not offered and the
 *   page names `claude auth login` instead. Only `manualUrl` is used: it ends on
 *   a page that shows a code to paste back, which works from any device;
 *   `automaticUrl` redirects to a loopback listener in the CLI.
 * - Logout: `claude auth logout`. The SDK has no call for it.
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

import { AccountOperationError, agentErrorMessage, type AccountAdapter, type AccountAdapterStatus, type StartedLogin } from "./agent-account-adapter";
import { claudeAccountState, type ClaudeAccountInfo } from "../chat/claude/account";
import type { AccountCapabilities, AccountMethod, ClaudeAccountState, ClaudeLoginSource } from "./agent-account-types";

export { claudeAccountState, type ClaudeAccountInfo };

/** The parts of an SDK session this adapter uses; the login methods are optional because they are undeclared. */
export type ClaudeAccountSession = AsyncIterable<unknown> & {
  accountInfo(): Promise<ClaudeAccountInfo>;
  close(): void;
  claudeAuthenticate?: (loginWithClaudeAi: boolean) => Promise<{ manualUrl?: string; automaticUrl?: string }>;
  claudeOAuthCallback?: (authorizationCode: string, state: string) => Promise<unknown>;
  claudeOAuthWaitForCompletion?: () => Promise<unknown>;
};

export type ClaudeSessionFactory = (options: { cwd: string; executable: string; env: Record<string, string> }) => ClaudeAccountSession;

export type ClaudeCommandRunner = (argv: string[], env: Record<string, string>) => Promise<{ exitCode: number | null; output: string }>;

export const CLAUDE_METHOD_SUBSCRIPTION = "claudeai";
export const CLAUDE_METHOD_CONSOLE = "console";
export const CLAUDE_LOGIN_COMMAND = "claude auth login";

const STATUS_CACHE_MS = 3_000;
const LOGOUT_TIMEOUT_MS = 15_000;

const CLAUDE_METHODS: AccountMethod[] = [
  { id: CLAUDE_METHOD_SUBSCRIPTION, kind: "oauth", label: "Claude subscription (Pro, Max, Team or Enterprise)", fields: [], completion: "code" },
  { id: CLAUDE_METHOD_CONSOLE, kind: "oauth", label: "Anthropic Console account (API billing)", fields: [], completion: "code" },
];

function defaultSessionFactory(options: { cwd: string; executable: string; env: Record<string, string> }): ClaudeAccountSession {
  // Never yields: the session exists only for its control channel.
  const prompt = (async function* () {
    await new Promise<never>(() => undefined);
  })();
  return sdkQuery({
    prompt: prompt as never,
    options: { cwd: options.cwd, pathToClaudeCodeExecutable: options.executable, env: options.env },
  }) as unknown as ClaudeAccountSession;
}

async function defaultCommandRunner(argv: string[], env: Record<string, string>): Promise<{ exitCode: number | null; output: string }> {
  const child = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), LOGOUT_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { exitCode, output: `${stdout}\n${stderr}`.trim().slice(0, 2_000) };
  } finally {
    clearTimeout(timer);
  }
}

/** Whether the Hub can remove this login: only one saved by a Claude Code login. */
export function claudeLoginRemovable(source: ClaudeLoginSource): boolean {
  return source === "subscription" || source === "console";
}

/** The pasted value from the code page is `code#state`; a bare code takes the state from the started URL. */
export function splitClaudeCode(pasted: string, startedUrl: string): { code: string; state: string } {
  const trimmed = pasted.trim();
  const hash = trimmed.indexOf("#");
  if (hash > 0) return { code: trimmed.slice(0, hash), state: trimmed.slice(hash + 1) };
  let state = "";
  try {
    state = new URL(startedUrl).searchParams.get("state") ?? "";
  } catch {
    // An unparseable URL leaves the state empty and the CLI refuses the code.
  }
  return { code: trimmed, state };
}

export class ClaudeAccountAdapter implements AccountAdapter {
  private loginSupported: boolean | null = null;
  private lastSource: ClaudeLoginSource = "unknown";
  private cached: { at: number; state: ClaudeAccountState } | null = null;
  private reading: Promise<ClaudeAccountState> | null = null;
  private readonly openSessions = new Set<ClaudeAccountSession>();

  constructor(private readonly options: {
    cwd: string;
    executable: string;
    env: Record<string, string>;
    sessionFactory?: ClaudeSessionFactory;
    runCommand?: ClaudeCommandRunner;
    now?: () => number;
  }) {}

  get capabilities(): AccountCapabilities {
    return { login: this.loginSupported !== false, logout: claudeLoginRemovable(this.lastSource), activate: false };
  }

  private open(): ClaudeAccountSession {
    const session = (this.options.sessionFactory ?? defaultSessionFactory)({ cwd: this.options.cwd, executable: this.options.executable, env: this.options.env });
    this.openSessions.add(session);
    // Drained so the SDK's pump keeps running; nothing in it is used.
    void (async () => {
      try {
        for await (const _ of session) { /* drained */ }
      } catch {
        // A closed session ends its stream with an error on some SDK versions.
      }
    })();
    return session;
  }

  private close(session: ClaudeAccountSession): void {
    this.openSessions.delete(session);
    try {
      session.close();
    } catch {
      // Already closed.
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async readState(): Promise<ClaudeAccountState> {
    if (this.cached && this.now() - this.cached.at < STATUS_CACHE_MS) return this.cached.state;
    this.reading ??= (async () => {
      const session = this.open();
      try {
        this.loginSupported = typeof session.claudeAuthenticate === "function"
          && typeof session.claudeOAuthCallback === "function"
          && typeof session.claudeOAuthWaitForCompletion === "function";
        const state = claudeAccountState(await session.accountInfo());
        this.lastSource = state.source;
        this.cached = { at: this.now(), state };
        return state;
      } catch (error) {
        throw new AccountOperationError(agentErrorMessage(error, "Claude Code did not report its login."));
      } finally {
        this.close(session);
      }
    })().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  /** Forget the cached status, so the next read asks Claude Code again. */
  invalidate(): void {
    this.cached = null;
  }

  async status(): Promise<AccountAdapterStatus> {
    const claude = await this.readState();
    return { targets: [], methods: this.loginSupported ? CLAUDE_METHODS.map(method => ({ ...method })) : [], claude };
  }

  async connectKey(): Promise<void> {
    throw new AccountOperationError("Claude Code takes an API key from ANTHROPIC_API_KEY in the Hub's environment, or from an Anthropic Console login.");
  }

  async startLogin(_target: string, methodId: string): Promise<StartedLogin> {
    if (methodId !== CLAUDE_METHOD_SUBSCRIPTION && methodId !== CLAUDE_METHOD_CONSOLE) {
      throw new AccountOperationError("Claude Code does not offer that login method.");
    }
    const session = this.open();
    const authenticate = session.claudeAuthenticate;
    const callback = session.claudeOAuthCallback;
    const wait = session.claudeOAuthWaitForCompletion;
    if (typeof authenticate !== "function" || typeof callback !== "function" || typeof wait !== "function") {
      this.close(session);
      this.loginSupported = false;
      throw new AccountOperationError(`This Claude Code version cannot log in from here. Run \`${CLAUDE_LOGIN_COMMAND}\` on the Hub machine.`);
    }
    let urls: { manualUrl?: string; automaticUrl?: string };
    try {
      urls = await authenticate.call(session, methodId === CLAUDE_METHOD_SUBSCRIPTION);
    } catch (error) {
      this.close(session);
      throw new AccountOperationError(agentErrorMessage(error, "Claude Code did not start the login."));
    }
    const url = urls?.manualUrl;
    if (!url) {
      this.close(session);
      throw new AccountOperationError("Claude Code did not return a sign-in address.");
    }
    let resolveCode!: () => void;
    let rejectCode!: (error: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    // Settled by the code or by cancel, possibly before anyone waits on it.
    done.catch(() => undefined);
    let submitted = false;
    const finish = () => {
      this.close(session);
      this.invalidate();
    };
    return {
      url,
      instructions: "Sign in, then paste the code the page shows.",
      completion: "code",
      callback: null,
      waitForCompletion: () => done,
      submitCode: async (pasted: string) => {
        if (!pasted.trim()) throw new AccountOperationError("Paste the code the sign-in page showed.", "code");
        if (submitted) throw new AccountOperationError("A code was already submitted for this login.", "code");
        submitted = true;
        const { code, state } = splitClaudeCode(pasted, url);
        try {
          await callback.call(session, code, state);
          await wait.call(session);
          finish();
          resolveCode();
        } catch (error) {
          finish();
          const failure = new AccountOperationError(agentErrorMessage(error, "Claude Code did not accept the code."), "code");
          rejectCode(failure);
          throw failure;
        }
      },
      cancel: async () => {
        finish();
        rejectCode(new AccountOperationError("The login was cancelled."));
      },
    };
  }

  async logout(): Promise<void> {
    const state = await this.readState();
    if (!claudeLoginRemovable(state.source)) {
      throw new AccountOperationError("This Claude Code login is not saved by Claude Code, so it cannot be logged out here.");
    }
    const runner = this.options.runCommand ?? defaultCommandRunner;
    const result = await runner([this.options.executable, "auth", "logout"], this.options.env);
    this.invalidate();
    if (result.exitCode !== 0) {
      throw new AccountOperationError(result.output.split("\n").find(line => line.trim())?.trim() || "Claude Code did not log out.");
    }
  }

  async activate(): Promise<void> {
    throw new AccountOperationError("Claude Code keeps one login.");
  }

  async dispose(): Promise<void> {
    for (const session of [...this.openSessions]) this.close(session);
  }
}
