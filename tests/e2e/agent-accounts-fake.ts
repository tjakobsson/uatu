// Fake agent account runtimes for the e2e Hub (UATU_E2E_HUB_AGENT_ACCOUNTS).
//
// Real agents cannot be logged in and out by a browser suite, so the Hub's
// Agent accounts service runs over these instead. Everything above the
// adapter seam is real: the service, its attempts and expiry, redirect
// confinement and delivery, the HTTP surface, the Settings pane, and the
// notification of running workspaces. The fakes behave like the agents as
// probed on 2026-10-03:
//
// - OpenCode (1.x shapes): Berget logged in with a saved key, the free
//   OpenCode Zen built in, and Groq, Cloudflare (a key plus an account id),
//   GitHub Copilot (a device login with a conditional enterprise field), and
//   OpenAI (a browser login that redirects to a loopback listener, a device
//   login, a key, and an environment variable) to log in to.
// - Claude Code: not logged in; both login methods end with a pasted code,
//   and `good-code` is the one the fake accepts.
//
// A small control server lets a spec approve a device login on the
// "provider's site", and shorten the next login's deadline. The redirect
// listener is a real loopback HTTP server: the Hub delivers a pasted address
// to it exactly as it would to OpenCode's own.

import { AccountOperationError, type AccountAdapter, type AccountAdapterStatus, type StartedLogin } from "../../src/hub/agent-account-adapter";
import { classifyCompletion } from "../../src/hub/agent-account-redirect";
import type { AccountRuntime, AccountRuntimeFactory } from "../../src/hub/agent-account-runtime";
import type { AccountCredential, AccountMethod, AccountTarget, ClaudeAccountState } from "../../src/hub/agent-account-types";

export const FAKE_DEVICE_CODE = "15EF-0DB6";
export const FAKE_CLAUDE_CODE = "good-code";
export const FAKE_CLAUDE_EMAIL = "e2e@example.test";

type Deferred = { promise: Promise<void>; resolve(): void; reject(error: unknown): void };
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

const COPILOT_FIELDS = [
  { key: "deploymentType", label: "Select GitHub deployment type", kind: "select" as const, valueType: "string", required: true, options: [{ value: "github.com", label: "GitHub.com", hint: "Public" }, { value: "enterprise", label: "GitHub Enterprise", hint: "Data residency or self-hosted" }] },
  { key: "enterpriseUrl", label: "Enter your GitHub Enterprise URL or domain", kind: "text" as const, valueType: "string", required: true, placeholder: "company.ghe.com", when: [{ key: "deploymentType", op: "eq" as const, value: "enterprise" }] },
];

function openCodeTargets(): AccountTarget[] {
  const saved = (id: string): AccountCredential => ({ id, label: "Saved login", kind: "saved", active: true, removable: true });
  return [
    { id: "berget", name: "Berget.AI", connected: true, credentials: [saved("berget")], methods: [{ id: "key", kind: "key", label: "API key", fields: [] }, { id: "env", kind: "env", label: "Environment variable", variables: ["BERGET_API_KEY"] }] },
    { id: "opencode", name: "OpenCode Zen", connected: true, credentials: [{ id: "opencode", label: "Built in", kind: "other", active: true, removable: false }], methods: [{ id: "key", kind: "key", label: "API key", fields: [] }] },
    { id: "cloudflare-workers-ai", name: "Cloudflare Workers AI", connected: false, credentials: [], methods: [{ id: "0", kind: "key", label: "API key", fields: [{ key: "accountId", label: "Enter your Cloudflare Account ID", kind: "text", valueType: "string", required: true, placeholder: "e.g. 1234567890abcdef1234567890abcdef" }] }] },
    { id: "github-copilot", name: "GitHub Copilot", connected: false, credentials: [], methods: [{ id: "0", kind: "oauth", label: "Login with GitHub Copilot", fields: COPILOT_FIELDS }] },
    { id: "groq", name: "Groq", connected: false, credentials: [], methods: [{ id: "key", kind: "key", label: "API key", fields: [] }, { id: "env", kind: "env", label: "Environment variable", variables: ["GROQ_API_KEY"] }] },
    { id: "openai", name: "OpenAI", connected: false, credentials: [], methods: [
      { id: "0", kind: "oauth", label: "ChatGPT Pro/Plus (browser)", fields: [] },
      { id: "1", kind: "oauth", label: "ChatGPT Pro/Plus (headless)", fields: [] },
      { id: "2", kind: "key", label: "Manually enter API Key", fields: [] },
      { id: "env", kind: "env", label: "Environment variable", variables: ["OPENAI_API_KEY"] },
    ] },
  ];
}

export type FakeAccountsControl = {
  /** A device login the "provider's site" approved. */
  approve(target: string): boolean;
  /** The next login's deadline, from now. */
  expireNextAfter(ms: number): void;
  /** Claude Code's login source, as `accountInfo()` would report it. */
  setClaudeSource(source: ClaudeAccountState["source"]): void;
  /** OpenCode as 2.x: Groq with two saved keys, and switching between them. */
  twoGroqKeys(): void;
  reset(): void;
};

export type FakeAgentAccounts = {
  runtimes: AccountRuntimeFactory;
  control: FakeAccountsControl;
  listener: { port: number; stop(): void };
};

export function createFakeAgentAccounts(): FakeAgentAccounts {
  let targets = openCodeTargets();
  let claude: ClaudeAccountState = { source: "none" };
  let nextExpiry: number | null = null;
  let switching = false;
  const pendingDevice = new Map<string, Deferred>();
  // Loopback attempts by the state their authorize URL carries.
  const pendingRedirect = new Map<string, { target: string; done: Deferred }>();
  let redirects = 0;

  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const waiting = pendingRedirect.get(url.searchParams.get("state") ?? "");
      if (url.pathname !== "/auth/callback" || !waiting || !url.searchParams.get("code")) return new Response("unknown callback", { status: 400 });
      pendingRedirect.delete(url.searchParams.get("state")!);
      connect(waiting.target, "oauth");
      waiting.done.resolve();
      return new Response("<p>Login complete.</p>", { headers: { "content-type": "text/html" } });
    },
  });

  function connect(id: string, kind: AccountCredential["kind"]): void {
    targets = targets.map(target => target.id === id
      ? { ...target, connected: true, credentials: [{ id, label: kind === "oauth" ? "Browser login" : "Saved login", kind: kind === "oauth" ? "oauth" : "saved", active: true, removable: true }] }
      : target);
  }

  function expiry(): number | undefined {
    if (nextExpiry === null) return undefined;
    const at = Date.now() + nextExpiry;
    nextExpiry = null;
    return at;
  }

  const opencode: AccountAdapter = {
    get capabilities() { return { login: true, logout: true, activate: switching }; },
    async status(): Promise<AccountAdapterStatus> {
      const sorted = [...targets].sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
      return { version: "1.18.34", generation: 1, targets: structuredClone(sorted), methods: [] };
    },
    async connectKey(target, methodId, key, answers) {
      const method = targets.find(candidate => candidate.id === target)?.methods.find(candidate => candidate.id === methodId);
      if (!method || method.kind !== "key") throw new AccountOperationError("That login method does not take a key.");
      for (const field of method.fields) {
        if (field.required && !String(answers[field.key] ?? "").trim()) throw new AccountOperationError(field.label + " is required.", field.key);
      }
      if (key.trim() === "bad-key") throw new AccountOperationError("Invalid API key", "key");
      connect(target, "saved");
    },
    async startLogin(target, methodId, answers): Promise<StartedLogin> {
      const method = targets.find(candidate => candidate.id === target)?.methods.find(candidate => candidate.id === methodId) as AccountMethod | undefined;
      if (!method || method.kind !== "oauth") throw new AccountOperationError("That login method is not a browser login.");
      if (target === "github-copilot" && answers.deploymentType === "enterprise" && !String(answers.enterpriseUrl ?? "").trim()) {
        throw new AccountOperationError("Enter your GitHub Enterprise URL or domain is required.", "enterpriseUrl");
      }
      const done = deferred();
      const expiresAt = expiry();
      if (target === "openai" && methodId === "0") {
        const state = "s" + (++redirects);
        pendingRedirect.set(state, { target, done });
        const url = `https://auth.openai.example/oauth/authorize?redirect_uri=${encodeURIComponent(`http://localhost:${listener.port}/auth/callback`)}&state=${state}`;
        const { completion, callback } = classifyCompletion(url, "auto");
        return {
          url, instructions: "Complete authorization in your browser.", completion, callback, ...(expiresAt ? { expiresAt } : {}),
          waitForCompletion: () => done.promise,
          cancel: async () => { pendingRedirect.delete(state); done.reject(new AccountOperationError("cancelled")); },
        };
      }
      pendingDevice.set(target, done);
      void done.promise.then(() => connect(target, "oauth"), () => undefined);
      return {
        url: target === "openai" ? "https://auth.openai.example/codex/device" : "https://github.com/login/device",
        instructions: `Enter code: ${FAKE_DEVICE_CODE}`,
        completion: "device",
        callback: null,
        ...(expiresAt ? { expiresAt } : {}),
        waitForCompletion: () => done.promise,
        cancel: async () => { pendingDevice.delete(target); done.reject(new AccountOperationError("cancelled")); },
      };
    },
    async logout(target) {
      targets = targets.map(candidate => candidate.id === target ? { ...candidate, connected: false, credentials: [] } : candidate);
    },
    async activate(credentialId) {
      if (!switching) throw new AccountOperationError("This OpenCode version keeps one login per provider.");
      targets = targets.map(target => ({ ...target, credentials: target.credentials.map(credential => target.credentials.some(other => other.id === credentialId) ? { ...credential, active: credential.id === credentialId } : credential) }));
    },
    async dispose() {},
  };

  const removable = (source: string) => source === "subscription" || source === "console";
  const claudeAdapter: AccountAdapter = {
    get capabilities() { return { login: true, logout: removable(claude.source), activate: false }; },
    async status(): Promise<AccountAdapterStatus> {
      return {
        version: "2.1.281",
        targets: [],
        methods: [
          { id: "claudeai", kind: "oauth", label: "Claude subscription (Pro, Max, Team or Enterprise)", fields: [], completion: "code" },
          { id: "console", kind: "oauth", label: "Anthropic Console account (API billing)", fields: [], completion: "code" },
        ],
        claude: structuredClone(claude),
      };
    },
    async connectKey() { throw new AccountOperationError("Claude Code takes no key here."); },
    async startLogin(_target, methodId): Promise<StartedLogin> {
      const done = deferred();
      const expiresAt = expiry();
      let submitted = false;
      return {
        url: "https://claude.example.test/oauth/authorize?code=true&state=fake",
        instructions: "Sign in, then paste the code the page shows.",
        completion: "code",
        callback: null,
        ...(expiresAt ? { expiresAt } : {}),
        waitForCompletion: () => done.promise,
        submitCode: async (code: string) => {
          if (submitted) throw new AccountOperationError("A code was already submitted for this login.", "code");
          submitted = true;
          if (code.split("#")[0]!.trim() !== FAKE_CLAUDE_CODE) {
            const failure = new AccountOperationError("Invalid authorization code", "code");
            done.reject(failure);
            throw failure;
          }
          claude = methodId === "console"
            ? { source: "console", email: FAKE_CLAUDE_EMAIL }
            : { source: "subscription", email: FAKE_CLAUDE_EMAIL, organization: "E2E Organization", plan: "Claude Max" };
          done.resolve();
        },
        cancel: async () => { done.reject(new AccountOperationError("cancelled")); },
      };
    },
    async logout() {
      if (!removable(claude.source)) throw new AccountOperationError("This Claude Code login is not saved by Claude Code, so it cannot be logged out here.");
      claude = { source: "none" };
    },
    async activate() { throw new AccountOperationError("Claude Code keeps one login."); },
    async dispose() {},
  };

  const runtimes: AccountRuntimeFactory = agent => ({
    start: async () => agent === "opencode"
      ? { state: "ready", version: "1.18.34", generation: 1, adapter: opencode }
      : { state: "ready", version: "2.1.281", adapter: claudeAdapter },
    stop: async () => undefined,
  }) satisfies AccountRuntime;

  return {
    runtimes,
    listener: { port: listener.port!, stop: () => listener.stop(true) },
    control: {
      approve(target) {
        const waiting = pendingDevice.get(target);
        if (!waiting) return false;
        pendingDevice.delete(target);
        waiting.resolve();
        return true;
      },
      expireNextAfter(ms) { nextExpiry = ms; },
      setClaudeSource(source) { claude = source === "env-api-key" ? { source, plan: "Claude Max" } : { source }; },
      twoGroqKeys() {
        switching = true;
        targets = targets.map(target => target.id === "groq" ? { ...target, connected: true, credentials: [
          { id: "cred_work", label: "Groq work", kind: "key", active: true, removable: true },
          { id: "cred_personal", label: "Groq personal", kind: "key", active: false, removable: true },
        ] } : target);
      },
      reset() {
        targets = openCodeTargets();
        claude = { source: "none" };
        nextExpiry = null;
        switching = false;
        for (const waiting of pendingDevice.values()) waiting.reject(new AccountOperationError("reset"));
        for (const waiting of pendingRedirect.values()) waiting.done.reject(new AccountOperationError("reset"));
        pendingDevice.clear();
        pendingRedirect.clear();
      },
    },
  };
}
