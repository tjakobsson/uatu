import { describe, expect, test } from "bun:test";

import { AccountOperationError, AttemptExpiredError, type AccountAdapter, type AccountAdapterStatus, type StartedLogin } from "./agent-account-adapter";
import { RedirectRefusedError } from "./agent-account-redirect";
import type { AccountRuntime, AccountRuntimeStart } from "./agent-account-runtime";
import { AgentAccountService, AgentNotReadyError, AttemptNotFoundError, scrubSecrets, type Timers } from "./agent-account-service";
import type { ChatAccountChange } from "../chat/types";
import type { AccountAgentId } from "./agent-account-types";

class FakeClock implements Timers {
  now = 1_000;
  private next = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
      await flush();
    }
    this.now = until;
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

class FakeAdapter implements AccountAdapter {
  capabilities = { login: true, logout: true, activate: false };
  statusReads = 0;
  keys: Array<[string, string, string]> = [];
  logins: Array<{ login: StartedLogin; completion: Deferred; codes: string[]; cancelled: boolean }> = [];
  connectKeyError: Error | null = null;
  completion: StartedLogin["completion"] = "device";

  async status(): Promise<AccountAdapterStatus> {
    this.statusReads += 1;
    return { targets: [{ id: "groq", name: "Groq", connected: this.keys.length > 0, credentials: [], methods: [] }], methods: [] };
  }

  async connectKey(target: string, methodId: string, key: string): Promise<void> {
    if (this.connectKeyError) throw this.connectKeyError;
    this.keys.push([target, methodId, key]);
  }

  async startLogin(): Promise<StartedLogin> {
    const completion = deferred();
    const record = { login: null as unknown as StartedLogin, completion, codes: [] as string[], cancelled: false };
    record.login = {
      url: this.completion === "redirect" ? "https://auth.example.test/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback" : "https://example.test/device",
      instructions: "Enter code: AAAA-BBBB",
      completion: this.completion,
      callback: this.completion === "redirect" ? { protocol: "http:", hostname: "localhost", port: "1455", pathname: "/auth/callback" } : null,
      waitForCompletion: () => completion.promise,
      ...(this.completion === "code"
        ? {
          submitCode: async (code: string) => {
            record.codes.push(code);
            if (code === "wrong") throw new AccountOperationError(`code ${code} was rejected`, "code");
            completion.resolve();
          },
        }
        : {}),
      cancel: async () => {
        record.cancelled = true;
        completion.reject(new AccountOperationError("cancelled"));
      },
    };
    this.logins.push(record);
    return record.login;
  }

  async logout(): Promise<void> {}
  async activate(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class FakeRuntime implements AccountRuntime {
  starts = 0;
  stops = 0;
  constructor(readonly adapter: FakeAdapter, private readonly result: () => AccountRuntimeStart) {}
  async start(): Promise<AccountRuntimeStart> {
    this.starts += 1;
    return this.result();
  }
  async stop(): Promise<void> {
    this.stops += 1;
  }
}

function harness(options: { claude?: () => AccountRuntimeStart; fetch?: (input: string, init: RequestInit) => Promise<Response> } = {}) {
  const clock = new FakeClock();
  const adapters: Record<AccountAgentId, FakeAdapter> = { opencode: new FakeAdapter(), claude: new FakeAdapter() };
  const runtimes: FakeRuntime[] = [];
  const changed: AccountAgentId[] = [];
  const changes: Array<[AccountAgentId, ChatAccountChange]> = [];
  let notify: (agent: AccountAgentId, change: ChatAccountChange) => Promise<void> = async () => undefined;
  const service = new AgentAccountService({
    runtimes: agent => {
      const adapter = adapters[agent];
      const runtime = new FakeRuntime(adapter, agent === "claude" && options.claude ? options.claude : () => ({ state: "ready", version: "1.0.0", adapter }));
      runtimes.push(runtime);
      return runtime;
    },
    onChanged: async (agent, change) => {
      changed.push(agent);
      changes.push([agent, change]);
      await notify(agent, change);
    },
    now: () => clock.now,
    timers: clock,
    // Instant, but yields like a real wait so work that answers at once lands first.
    sleep: () => flush(),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return { clock, adapters, runtimes, changed, changes, service, setNotify: (next: typeof notify) => { notify = next; } };
}

describe("account runtimes", () => {
  test("start on the first read, report each agent, and keep one runtime per agent", async () => {
    const { service, runtimes } = harness();
    expect(service.isRunning("opencode")).toBe(false);
    const snapshot = await service.read();
    expect(snapshot.agents.map(agent => [agent.agent, agent.state, agent.version])).toEqual([["opencode", "ready", "1.0.0"], ["claude", "ready", "1.0.0"]]);
    await service.read();
    expect(runtimes.length).toBe(2);
  });

  test("stop after the idle period, and start again on the next request", async () => {
    const { service, runtimes, clock } = harness();
    await service.read();
    await clock.advance(5 * 60_000);
    expect(service.isRunning("opencode")).toBe(false);
    expect(runtimes.every(runtime => runtime.stops === 1)).toBe(true);
    const again = await service.read();
    expect(again.agents[0]?.state).toBe("ready");
    expect(runtimes.length).toBe(4);
  });

  test("do not stop while a login is pending", async () => {
    const { service, clock } = harness();
    await service.startLogin("opencode", "groq", "0", {});
    await clock.advance(5 * 60_000);
    expect(service.isRunning("opencode")).toBe(true);
    expect(service.isRunning("claude")).toBe(false);
  });

  test("stop with the Hub", async () => {
    const { service, runtimes, adapters } = harness();
    await service.startLogin("opencode", "groq", "0", {});
    await service.dispose();
    expect(runtimes[0]?.stops).toBe(1);
    expect(adapters.opencode.logins[0]?.cancelled).toBe(true);
  });

  test("an agent that is not installed is reported without hiding the other, and is retried on the next read", async () => {
    let installed = false;
    const { service, runtimes } = harness({ claude: () => installed ? { state: "ready", adapter: new FakeAdapter() } : { state: "not-installed", message: "Claude Code is not installed." } });
    const snapshot = await service.read();
    expect(snapshot.agents.map(agent => [agent.agent, agent.state, agent.message])).toEqual([
      ["opencode", "ready", undefined],
      ["claude", "not-installed", "Claude Code is not installed."],
    ]);
    await expect(service.startLogin("claude", "claude", "claudeai", {})).rejects.toBeInstanceOf(AgentNotReadyError);
    installed = true;
    expect((await service.read()).agents[1]?.state).toBe("ready");
    expect(runtimes.filter(runtime => runtime.adapter !== undefined).length).toBeGreaterThan(2);
  });
});

describe("answer deadline", () => {
  test("a status read that never answers stops the runtime, shows the agent as not answering, and the next read starts it again", async () => {
    const { service, adapters, runtimes, clock } = harness();
    const status = adapters.claude.status.bind(adapters.claude);
    adapters.claude.status = () => new Promise(() => undefined);
    expect((await service.read()).agents.find(agent => agent.agent === "claude")?.state).toBe("starting");
    await clock.advance(30_000);
    expect(service.isRunning("claude")).toBe(false);
    expect(runtimes.filter(runtime => runtime.adapter === adapters.claude).map(runtime => runtime.stops)).toEqual([1]);
    expect(service.snapshot().agents.find(agent => agent.agent === "claude")).toMatchObject({ state: "unavailable", message: "Claude Code did not answer within 30s. Try again." });
    adapters.claude.status = status;
    expect((await service.read()).agents.find(agent => agent.agent === "claude")?.state).toBe("ready");
  });

  test("a login start that never answers is refused at the deadline and does not hold up the next start", async () => {
    const { service, adapters, clock } = harness();
    await service.read();
    const startLogin = adapters.opencode.startLogin.bind(adapters.opencode);
    const late = deferred();
    adapters.opencode.startLogin = async () => {
      adapters.opencode.startLogin = startLogin;
      await late.promise;
      return startLogin();
    };
    const first = service.startLogin("opencode", "groq", "0", {}).catch(caught => caught);
    const second = service.startLogin("opencode", "groq", "1", {});
    await flush();
    await clock.advance(30_000);
    expect(await first).toBeInstanceOf(AgentNotReadyError);
    expect((await second).attempts.map(attempt => [attempt.methodId, attempt.state])).toEqual([["1", "pending"]]);
    // The agent's login arriving after the deadline has nobody to finish it.
    late.resolve();
    await flush();
    expect(adapters.opencode.logins.map(login => login.cancelled)).toEqual([false, true]);
  });

  test("a code the agent never answers is refused at the deadline, and the login fails instead of waiting", async () => {
    const { service, adapters, clock } = harness();
    adapters.opencode.completion = "code";
    const { attempts } = await service.startLogin("opencode", "groq", "0", {});
    adapters.opencode.logins[0]!.login.submitCode = () => new Promise(() => undefined);
    const submitted = service.submitCode(attempts[0]!.id, "pasted-code").catch(caught => caught);
    await flush();
    await clock.advance(30_000);
    expect(await submitted).toBeInstanceOf(AgentNotReadyError);
    expect(service.isRunning("opencode")).toBe(false);
    expect(service.snapshot().attempts[0]).toMatchObject({ state: "failed", message: "OpenCode stopped answering, so this login can't finish. Start it again." });
  });

  test("cancel answers at once even when the agent never ends its side", async () => {
    const { service, adapters } = harness();
    const { attempts } = await service.startLogin("opencode", "groq", "0", {});
    adapters.opencode.logins[0]!.login.cancel = () => new Promise(() => undefined);
    expect((await service.cancel(attempts[0]!.id)).attempts[0]?.state).toBe("cancelled");
  });

  test("a replacement start behind a cancel the agent never answers goes ahead on a restarted runtime", async () => {
    const { service, adapters, runtimes, clock } = harness();
    await service.startLogin("opencode", "groq", "0", {});
    adapters.opencode.logins[0]!.login.cancel = () => new Promise(() => undefined);
    const replacement = service.startLogin("opencode", "groq", "1", {});
    await flush();
    await clock.advance(30_000);
    expect((await replacement).attempts.map(attempt => [attempt.methodId, attempt.state])).toEqual([["0", "cancelled"], ["1", "pending"]]);
    expect(runtimes.filter(runtime => runtime.adapter === adapters.opencode).map(runtime => runtime.stops)).toEqual([1, 0]);
  });

  test("a change that never answers does not hold up the next change", async () => {
    const { service, adapters, clock } = harness();
    await service.read();
    const connectKey = adapters.opencode.connectKey.bind(adapters.opencode);
    adapters.opencode.connectKey = () => new Promise(() => undefined);
    const hung = service.connectKey("opencode", "groq", "api", "sk-hung-key", {}).catch(caught => caught);
    await flush();
    await clock.advance(30_000);
    expect(await hung).toBeInstanceOf(AgentNotReadyError);
    adapters.opencode.connectKey = connectKey;
    await service.connectKey("opencode", "groq", "api", "sk-next-key", {});
    expect(adapters.opencode.keys.map(([, , key]) => key)).toEqual(["sk-next-key"]);
  });
});

describe("key logins", () => {
  test("hand the key to the agent, re-read, and tell running workspaces", async () => {
    const { service, adapters, changed } = harness();
    const snapshot = await service.connectKey("opencode", "groq", "key", "gsk-123", {});
    expect(adapters.opencode.keys).toEqual([["groq", "key", "gsk-123"]]);
    expect(snapshot.agents[0]?.targets[0]?.connected).toBe(true);
    expect(changed).toEqual(["opencode"]);
    expect(JSON.stringify(snapshot)).not.toContain("gsk-123");
  });

  test("a rejection that echoes the key is scrubbed, and nothing is announced", async () => {
    const { service, adapters, changed } = harness();
    adapters.opencode.connectKeyError = new Error("key gsk-secret-value is invalid");
    const error = await service.connectKey("opencode", "groq", "key", "gsk-secret-value", {}).catch(caught => caught);
    expect(error).toBeInstanceOf(AccountOperationError);
    expect(error.message).toBe("key [redacted] is invalid");
    expect(changed).toEqual([]);
  });

  test("what the user typed into a method's fields is scrubbed from the agent's errors, like the key", async () => {
    const { service, adapters } = harness();
    adapters.opencode.startLogin = async () => {
      throw new Error("bad client secret gloas-typed-secret for gitlab.example.com");
    };
    const login = await service.startLogin("opencode", "gitlab", "0", { clientSecret: "gloas-typed-secret", instanceUrl: "gitlab.example.com" }).catch(caught => caught);
    expect(login.message).toBe("bad client secret [redacted] for [redacted]");
    adapters.opencode.connectKeyError = new Error("key sk-typed-key rejected for account acct-typed-id");
    const key = await service.connectKey("opencode", "groq", "key", "sk-typed-key", { accountId: "acct-typed-id" }).catch(caught => caught);
    expect(key.message).toBe("key [redacted] rejected for account [redacted]");
  });

  test("scrubbing ignores very short values", () => {
    expect(scrubSecrets("abc abc", ["abc"])).toBe("abc abc");
  });
});

describe("workspace notification", () => {
  test("each change names what changed", async () => {
    const { service, changes, adapters } = harness();
    await service.connectKey("opencode", "groq", "key", "gsk", {});
    await service.logout("opencode", "groq", "groq");
    await service.activate("opencode", "cred_b");
    await service.startLogin("opencode", "groq", "0", {});
    adapters.opencode.logins[0]!.completion.resolve();
    await flush();
    expect(changes).toEqual([
      ["opencode", { kind: "added" }],
      ["opencode", { kind: "removed", target: "groq", credential: "groq" }],
      ["opencode", { kind: "activated", credential: "cred_b" }],
      ["opencode", { kind: "added" }],
    ]);
  });

  test("a change is announced with a status read that started after it, not one already running", async () => {
    const { service, adapters, clock } = harness();
    await service.read();
    await clock.advance(2_000);
    const gate = deferred();
    const status = adapters.opencode.status.bind(adapters.opencode);
    adapters.opencode.status = async () => {
      // Taken before the key lands, answered after.
      const before = await status();
      adapters.opencode.status = status;
      await gate.promise;
      return before;
    };
    await service.read();
    const saved = service.connectKey("opencode", "groq", "key", "sk-fresh-key", {});
    await flush();
    gate.resolve();
    const snapshot = await saved;
    expect(snapshot.agents.find(agent => agent.agent === "opencode")?.targets[0]?.connected).toBe(true);
  });

  test("the next change for an agent waits for the previous change's notification", async () => {
    const { service, adapters, setNotify } = harness();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    setNotify(async () => {
      if (first) {
        first = false;
        await held;
      }
    });
    const logout = service.logout("opencode", "groq", "groq");
    await flush();
    const login = service.connectKey("opencode", "groq", "key", "gsk-new", {});
    await flush();
    expect(adapters.opencode.keys).toEqual([]);
    release();
    await Promise.all([logout, login]);
    expect(adapters.opencode.keys).toEqual([["groq", "key", "gsk-new"]]);
  });

  test("a failed notification does not fail the login", async () => {
    const { service, setNotify } = harness();
    setNotify(async () => { throw new Error("child gone"); });
    await expect(service.connectKey("opencode", "groq", "key", "gsk", {})).resolves.toBeDefined();
  });
});

describe("login attempts", () => {
  test("a device login settles complete when the agent says so, then announces the change", async () => {
    const { service, adapters, changed } = harness();
    const started = await service.startLogin("opencode", "groq", "0", {});
    expect(started.attempts.map(attempt => [attempt.state, attempt.completion, attempt.instructions])).toEqual([["pending", "device", "Enter code: AAAA-BBBB"]]);
    adapters.opencode.logins[0]!.completion.resolve();
    await flush();
    expect(service.snapshot().attempts[0]?.state).toBe("complete");
    expect(changed).toEqual(["opencode"]);
  });

  test("a new attempt for the same target cancels the earlier one", async () => {
    const { service, adapters } = harness();
    await service.startLogin("opencode", "groq", "0", {});
    await service.startLogin("opencode", "groq", "0", {});
    expect(adapters.opencode.logins[0]?.cancelled).toBe(true);
    expect(service.snapshot().attempts.map(attempt => attempt.state)).toEqual(["cancelled", "pending"]);
  });

  test("two starts for the same target at once leave one attempt pending", async () => {
    const { service, adapters } = harness();
    await Promise.all([service.startLogin("opencode", "groq", "0", {}), service.startLogin("opencode", "groq", "1", {})]);
    expect(adapters.opencode.logins.map(login => login.cancelled)).toEqual([true, false]);
    expect(service.snapshot().attempts.map(attempt => [attempt.methodId, attempt.state])).toEqual([["0", "cancelled"], ["1", "pending"]]);
  });

  test("a failed start does not hold up the next one", async () => {
    const { service, adapters } = harness();
    const startLogin = adapters.opencode.startLogin.bind(adapters.opencode);
    adapters.opencode.startLogin = async () => {
      adapters.opencode.startLogin = startLogin;
      throw new Error("the agent refused");
    };
    const results = await Promise.allSettled([service.startLogin("opencode", "groq", "0", {}), service.startLogin("opencode", "groq", "1", {})]);
    expect(results.map(result => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(service.snapshot().attempts.map(attempt => [attempt.methodId, attempt.state])).toEqual([["1", "pending"]]);
  });

  test("a login the agent starts after the Hub stopped is cancelled, not tracked", async () => {
    const { service, adapters } = harness();
    await service.read();
    const gate = deferred();
    const startLogin = adapters.opencode.startLogin.bind(adapters.opencode);
    adapters.opencode.startLogin = async () => {
      await gate.promise;
      return startLogin();
    };
    const started = service.startLogin("opencode", "groq", "0", {}).catch(caught => caught);
    await flush();
    await service.dispose();
    gate.resolve();
    expect(await started).toBeInstanceOf(AgentNotReadyError);
    expect(adapters.opencode.logins[0]?.cancelled).toBe(true);
    expect(service.snapshot().attempts).toEqual([]);
  });

  test("a failure carries the agent's message, scrubbed of the code it took", async () => {
    const { service, adapters } = harness();
    adapters.opencode.completion = "code";
    const { attempts } = await service.startLogin("opencode", "groq", "0", {});
    // The agent takes the code, then fails the login quoting it.
    adapters.opencode.logins[0]!.login.submitCode = async () => undefined;
    await service.submitCode(attempts[0]!.id, "taken-code");
    adapters.opencode.logins[0]!.completion.reject(new Error("denied for taken-code"));
    await flush();
    expect(service.snapshot().attempts[0]).toMatchObject({ state: "failed", message: "denied for [redacted]" });
  });

  test("a refused code is scrubbed from its own error and not held afterwards", async () => {
    const { service, adapters } = harness();
    adapters.opencode.completion = "code";
    const { attempts } = await service.startLogin("opencode", "groq", "0", {});
    const error = await service.submitCode(attempts[0]!.id, "wrong").catch(caught => caught);
    expect(error.message).toBe("code [redacted] was rejected");
    // Dropped once refused: the Hub no longer holds it, so a later message
    // quoting it is not scrubbed either.
    adapters.opencode.logins[0]!.completion.reject(new Error("denied for wrong"));
    await flush();
    expect(service.snapshot().attempts[0]).toMatchObject({ state: "failed", message: "denied for wrong" });
  });

  test("a pasted code completes a code login", async () => {
    const { service, adapters } = harness();
    adapters.opencode.completion = "code";
    const { attempts } = await service.startLogin("opencode", "groq", "0", {});
    await service.submitCode(attempts[0]!.id, "right-code");
    await flush();
    expect(adapters.opencode.logins[0]?.codes).toEqual(["right-code"]);
    expect(service.snapshot().attempts[0]?.state).toBe("complete");
  });

  test("an attempt expires at the default deadline and the agent's attempt is cancelled", async () => {
    const { service, adapters, clock } = harness();
    await service.startLogin("opencode", "groq", "0", {});
    expect(service.snapshot().attempts[0]?.expiresAt).toBe(clock.now + 10 * 60_000);
    await clock.advance(10 * 60_000);
    expect(service.snapshot().attempts[0]?.state).toBe("expired");
    expect(adapters.opencode.logins[0]?.cancelled).toBe(true);
  });

  test("the agent reporting expiry settles expired, not failed", async () => {
    const { service, adapters } = harness();
    await service.startLogin("opencode", "groq", "0", {});
    adapters.opencode.logins[0]!.completion.reject(new AttemptExpiredError());
    await flush();
    expect(service.snapshot().attempts[0]?.state).toBe("expired");
  });

  test("cancel settles cancelled; a settled attempt is dropped after the retention period", async () => {
    const { service, clock } = harness();
    const { attempts } = await service.startLogin("opencode", "groq", "0", {});
    await service.cancel(attempts[0]!.id);
    expect(service.snapshot().attempts[0]?.state).toBe("cancelled");
    await clock.advance(5 * 60_000);
    expect(service.snapshot().attempts).toEqual([]);
    await expect(service.cancel(attempts[0]!.id)).rejects.toBeInstanceOf(AttemptNotFoundError);
  });

  test("a code for a login that has ended is refused", async () => {
    const { service } = harness();
    const { attempts } = await service.startLogin("opencode", "groq", "0", {});
    await service.cancel(attempts[0]!.id);
    await expect(service.submitCode(attempts[0]!.id, "late")).rejects.toThrow("already ended");
  });
});

describe("redirect delivery", () => {
  function redirectHarness() {
    const requests: Array<{ input: string; init: RequestInit }> = [];
    const setup = harness({
      fetch: async (input, init) => {
        requests.push({ input, init });
        return new Response("listener page with the code", { status: 200 });
      },
    });
    setup.adapters.opencode.completion = "redirect";
    return { ...setup, requests };
  }

  test("an address matching the attempt's callback is requested once, on the recorded host, without following redirects", async () => {
    const { service, requests } = redirectHarness();
    const { attempts } = await service.startLogin("opencode", "openai", "0", {});
    await service.submitRedirect(attempts[0]!.id, "http://127.0.0.1:1455/auth/callback?code=c0de&state=st");
    expect(requests.length).toBe(1);
    expect(requests[0]?.input).toBe("http://localhost:1455/auth/callback?code=c0de&state=st");
    expect(requests[0]?.init.redirect).toBe("manual");
  });

  test("an address the listener never took is not held after the failure", async () => {
    const setup = harness({ fetch: async () => { throw new Error("connection refused"); } });
    setup.adapters.opencode.completion = "redirect";
    const { service, adapters } = setup;
    const { attempts } = await service.startLogin("opencode", "openai", "0", {});
    const error = await service.submitRedirect(attempts[0]!.id, "http://127.0.0.1:1455/auth/callback?code=c0de-lost&state=st").catch(caught => caught);
    expect(error.message).toBe("The login's listener on the Hub machine did not answer. Start the login again.");
    adapters.opencode.logins[0]!.completion.reject(new Error("no callback for code=c0de-lost&state=st"));
    await flush();
    expect(service.snapshot().attempts[0]).toMatchObject({ state: "failed", message: "no callback for code=c0de-lost&state=st" });
  });

  for (const [name, address] of [
    ["another host", "http://evil.example.test:1455/auth/callback?code=x"],
    ["another port", "http://localhost:1456/auth/callback?code=x"],
    ["another path", "http://localhost:1455/admin?code=x"],
    ["https", "https://localhost:1455/auth/callback?code=x"],
    ["not an address", "code=x"],
  ] as const) {
    test(`${name} is refused without any request, and the attempt stays pending`, async () => {
      const { service, requests } = redirectHarness();
      const { attempts } = await service.startLogin("opencode", "openai", "0", {});
      const error = await service.submitRedirect(attempts[0]!.id, address).catch(caught => caught);
      expect(error).toBeInstanceOf(RedirectRefusedError);
      expect(error.message).not.toContain(address);
      expect(requests).toEqual([]);
      expect(service.snapshot().attempts[0]?.state).toBe("pending");
    });
  }

  test("no attempt in progress is refused without any request", async () => {
    const { service, requests } = redirectHarness();
    await expect(service.submitRedirect("no-such-attempt", "http://localhost:1455/auth/callback?code=x")).rejects.toBeInstanceOf(AttemptNotFoundError);
    const { attempts } = await service.startLogin("opencode", "openai", "0", {});
    await service.cancel(attempts[0]!.id);
    await expect(service.submitRedirect(attempts[0]!.id, "http://localhost:1455/auth/callback?code=x")).rejects.toThrow("already ended");
    expect(requests).toEqual([]);
  });

  test("a device login takes no address", async () => {
    const { service, adapters, requests } = redirectHarness();
    adapters.opencode.completion = "device";
    const { attempts } = await service.startLogin("opencode", "openai", "1", {});
    await expect(service.submitRedirect(attempts[0]!.id, "http://localhost:1455/auth/callback?code=x")).rejects.toThrow("does not take an address");
    expect(requests).toEqual([]);
  });
});
