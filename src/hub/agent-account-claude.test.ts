import { describe, expect, test } from "bun:test";

import { AccountOperationError } from "./agent-account-adapter";
import {
  CLAUDE_METHOD_CONSOLE,
  CLAUDE_METHOD_SUBSCRIPTION,
  ClaudeAccountAdapter,
  type ClaudeAccountInfo,
  type ClaudeAccountSession,
  claudeAccountState,
  splitClaudeCode,
} from "./agent-account-claude";

const MANUAL_URL = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=st4te";

type SessionLog = { opened: number; closed: number; calls: Array<[string, ...unknown[]]> };

function fakeSessions(options: { info?: ClaudeAccountInfo; login?: boolean; callbackError?: Error } = {}) {
  const log: SessionLog = { opened: 0, closed: 0, calls: [] };
  const factory = () => {
    log.opened += 1;
    const session: ClaudeAccountSession = {
      async *[Symbol.asyncIterator]() {
        await new Promise(() => undefined);
      },
      accountInfo: async () => {
        log.calls.push(["accountInfo"]);
        return options.info ?? { tokenSource: "none", apiProvider: "firstParty" };
      },
      close: () => {
        log.closed += 1;
      },
      ...(options.login === false
        ? {}
        : {
          claudeAuthenticate: async (loginWithClaudeAi: boolean) => {
            log.calls.push(["claudeAuthenticate", loginWithClaudeAi]);
            return { manualUrl: MANUAL_URL, automaticUrl: "https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A51686%2Fcallback" };
          },
          claudeOAuthCallback: async (code: string, state: string) => {
            log.calls.push(["claudeOAuthCallback", code, state]);
            if (options.callbackError) throw options.callbackError;
            return {};
          },
          claudeOAuthWaitForCompletion: async () => {
            log.calls.push(["claudeOAuthWaitForCompletion"]);
            return {};
          },
        }),
    };
    return session;
  };
  return { factory, log };
}

function adapter(sessions: ReturnType<typeof fakeSessions>, extra: Partial<ConstructorParameters<typeof ClaudeAccountAdapter>[0]> = {}) {
  let clock = 0;
  const instance = new ClaudeAccountAdapter({
    cwd: "/hub/agent-accounts",
    executable: "/usr/local/bin/claude",
    env: { PATH: "/bin" },
    sessionFactory: sessions.factory,
    now: () => clock,
    ...extra,
  });
  return { instance, advance: (ms: number) => { clock += ms; } };
}

describe("Claude Code login source", () => {
  test("each accountInfo shape maps to the login in effect", () => {
    // The shape a real Claude Max login answered on 2026-10-03.
    expect(claudeAccountState({ email: "me@example.test", organization: "Org", subscriptionType: "Claude Max", apiProvider: "firstParty" })).toEqual({
      source: "subscription",
      email: "me@example.test",
      organization: "Org",
      plan: "Claude Max",
    });
    // And with no login, in an isolated config directory.
    expect(claudeAccountState({ tokenSource: "none", apiProvider: "firstParty" })).toEqual({ source: "none" });
    expect(claudeAccountState({ apiKeySource: "ANTHROPIC_API_KEY", subscriptionType: "Claude Max", apiProvider: "firstParty" }).source).toBe("env-api-key");
    expect(claudeAccountState({ apiKeySource: "/login managed key", email: "c@example.test", apiProvider: "firstParty" })).toEqual({ source: "console", email: "c@example.test" });
    expect(claudeAccountState({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" }).source).toBe("env-token");
    expect(claudeAccountState({ tokenSource: "ANTHROPIC_AUTH_TOKEN", apiProvider: "firstParty" }).source).toBe("env-token");
    expect(claudeAccountState({ apiKeySource: "apiKeyHelper", apiProvider: "firstParty" }).source).toBe("api-key-helper");
    expect(claudeAccountState({ apiProvider: "bedrock" })).toEqual({ source: "third-party", provider: "bedrock" });
    expect(claudeAccountState({ tokenSource: "CCR_OAUTH_TOKEN_FILE", apiProvider: "firstParty" }).source).toBe("unknown");
  });

  test("a pasted code splits into code and state, and a bare code takes the URL's state", () => {
    expect(splitClaudeCode(" abc#xyz ", MANUAL_URL)).toEqual({ code: "abc", state: "xyz" });
    expect(splitClaudeCode("abc", MANUAL_URL)).toEqual({ code: "abc", state: "st4te" });
  });
});

describe("Claude Code account status", () => {
  test("reads accountInfo on a short-lived session and offers both login methods when the CLI supports them", async () => {
    const sessions = fakeSessions();
    const { instance } = adapter(sessions);
    const status = await instance.status();
    expect(status.claude).toEqual({ source: "none" });
    expect(status.methods.map(method => method.id)).toEqual([CLAUDE_METHOD_SUBSCRIPTION, CLAUDE_METHOD_CONSOLE]);
    expect(sessions.log.opened).toBe(1);
    expect(sessions.log.closed).toBe(1);
    expect(instance.capabilities).toEqual({ login: true, logout: false, activate: false });
  });

  test("reads within the cache window share one session; a later read opens a fresh one", async () => {
    const sessions = fakeSessions();
    const { instance, advance } = adapter(sessions);
    await Promise.all([instance.status(), instance.status()]);
    await instance.status();
    expect(sessions.log.opened).toBe(1);
    advance(5_000);
    await instance.status();
    expect(sessions.log.opened).toBe(2);
  });

  test("without the login methods, no login method is offered", async () => {
    const sessions = fakeSessions({ login: false });
    const { instance } = adapter(sessions);
    const status = await instance.status();
    expect(status.methods).toEqual([]);
    expect(instance.capabilities.login).toBe(false);
    await expect(instance.startLogin("claude", CLAUDE_METHOD_SUBSCRIPTION)).rejects.toThrow("claude auth login");
  });

  test("a subscription login can be logged out; an environment key cannot", async () => {
    const subscribed = adapter(fakeSessions({ info: { subscriptionType: "Claude Max", apiProvider: "firstParty" } })).instance;
    await subscribed.status();
    expect(subscribed.capabilities.logout).toBe(true);
    const env = adapter(fakeSessions({ info: { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" } })).instance;
    await env.status();
    expect(env.capabilities.logout).toBe(false);
  });
});

describe("Claude Code login", () => {
  test("both methods start with the manual URL; the pasted code completes the login and closes the session", async () => {
    const sessions = fakeSessions();
    const { instance } = adapter(sessions);
    const console = await instance.startLogin("claude", CLAUDE_METHOD_CONSOLE);
    expect(sessions.log.calls.at(-1)).toEqual(["claudeAuthenticate", false]);
    await console.cancel();
    const login = await instance.startLogin("claude", CLAUDE_METHOD_SUBSCRIPTION);
    expect(sessions.log.calls.at(-1)).toEqual(["claudeAuthenticate", true]);
    expect([login.url, login.completion, login.callback]).toEqual([MANUAL_URL, "code", null]);
    const settled = login.waitForCompletion();
    await login.submitCode!("thecode#thestate");
    await settled;
    expect(sessions.log.calls.slice(-2)).toEqual([["claudeOAuthCallback", "thecode", "thestate"], ["claudeOAuthWaitForCompletion"]]);
    expect(sessions.log.opened).toBe(sessions.log.closed);
  });

  test("a rejected code fails the attempt with the agent's message", async () => {
    const sessions = fakeSessions({ callbackError: new Error("Invalid authorization code") });
    const { instance } = adapter(sessions);
    const login = await instance.startLogin("claude", CLAUDE_METHOD_SUBSCRIPTION);
    const settled = login.waitForCompletion().catch(error => error);
    const submitted = await login.submitCode!("bad#st4te").catch(error => error);
    expect(submitted).toBeInstanceOf(AccountOperationError);
    expect(submitted.message).toBe("Invalid authorization code");
    expect((await settled).message).toBe("Invalid authorization code");
  });

  test("cancel closes the session and ends the wait", async () => {
    const sessions = fakeSessions();
    const { instance } = adapter(sessions);
    const login = await instance.startLogin("claude", CLAUDE_METHOD_SUBSCRIPTION);
    const settled = login.waitForCompletion().catch(error => error);
    await login.cancel();
    expect((await settled).message).toBe("The login was cancelled.");
    expect(sessions.log.closed).toBe(sessions.log.opened);
  });
});

describe("Claude Code logout", () => {
  test("runs `claude auth logout` with the resolved executable and reads fresh afterwards", async () => {
    const commands: string[][] = [];
    const sessions = fakeSessions({ info: { subscriptionType: "Claude Max", apiProvider: "firstParty" } });
    const { instance } = adapter(sessions, { runCommand: async argv => { commands.push(argv); return { exitCode: 0, output: "Logged out" }; } });
    await instance.logout();
    expect(commands).toEqual([["/usr/local/bin/claude", "auth", "logout"]]);
    await instance.status();
    expect(sessions.log.opened).toBe(2);
  });

  test("an environment key is refused without running anything", async () => {
    const commands: string[][] = [];
    const sessions = fakeSessions({ info: { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" } });
    const { instance } = adapter(sessions, { runCommand: async argv => { commands.push(argv); return { exitCode: 0, output: "" }; } });
    await expect(instance.logout()).rejects.toThrow("cannot be logged out here");
    expect(commands).toEqual([]);
  });

  test("a failed logout reports the CLI's first line", async () => {
    const sessions = fakeSessions({ info: { subscriptionType: "Claude Max", apiProvider: "firstParty" } });
    const { instance } = adapter(sessions, { runCommand: async () => ({ exitCode: 1, output: "\nKeychain locked\nmore" }) });
    await expect(instance.logout()).rejects.toThrow("Keychain locked");
  });
});
