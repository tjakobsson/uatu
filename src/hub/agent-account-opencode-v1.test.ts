import { describe, expect, test } from "bun:test";

import { AccountOperationError } from "./agent-account-adapter";
import { IMPLICIT_KEY_METHOD_ID, OpenCodeV1AccountAdapter, type OpenCodeV1AccountClient } from "./agent-account-opencode-v1";

const COPILOT_PROMPTS = [
  { type: "select", key: "deploymentType", message: "Select GitHub deployment type", options: [{ label: "GitHub.com", value: "github.com" }, { label: "GitHub Enterprise", value: "enterprise" }] },
  { type: "text", key: "enterpriseUrl", message: "Enterprise URL", when: { key: "deploymentType", op: "eq", value: "enterprise" } },
];

// The shapes OpenCode 1.18.34 answered on 2026-10-03, trimmed to the providers used here.
const PROVIDERS = {
  all: [
    { id: "openai", name: "OpenAI", source: "api", env: ["OPENAI_API_KEY"], key: "sk-must-never-leak", options: {}, models: {} },
    { id: "github-copilot", name: "GitHub Copilot", source: "custom", env: [], options: {}, models: {} },
    { id: "opencode", name: "OpenCode Zen", source: "custom", env: [], options: {}, models: {} },
    { id: "cloudflare-workers-ai", name: "Cloudflare Workers AI", source: "custom", env: ["CLOUDFLARE_API_KEY"], options: {}, models: {} },
    { id: "groq", name: "Groq", source: "env", env: ["GROQ_API_KEY"], key: "gsk-env-secret", options: {}, models: {} },
    { id: "berget", name: "Berget", source: "custom", env: [], options: {}, models: {} },
    // A key saved on a fresh configuration: 1.18.34 reports it `custom`.
    { id: "mistral", name: "Mistral", source: "custom", env: [], key: "mk-saved-secret", options: {}, models: {} },
  ],
  default: {},
  connected: ["openai", "groq", "github-copilot", "opencode", "mistral"],
};
const AUTH = {
  openai: [
    { type: "oauth", label: "ChatGPT Pro/Plus (browser)" },
    { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
    { type: "api", label: "Manually enter API Key" },
  ],
  "github-copilot": [{ type: "oauth", label: "Login with GitHub Copilot", prompts: COPILOT_PROMPTS }],
  "cloudflare-workers-ai": [{ type: "api", label: "API key", prompts: [{ type: "text", key: "accountId", message: "Enter your Cloudflare Account ID" }] }],
};
const AUTHORIZATIONS: Record<string, { url: string; method: "auto" | "code"; instructions: string }> = {
  "openai:0": {
    url: "https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=abc",
    method: "auto",
    instructions: "Complete authorization in your browser.",
  },
  "openai:1": { url: "https://auth.openai.com/codex/device", method: "auto", instructions: "Enter code: BBWH-P2AH6" },
  "github-copilot:0": { url: "https://github.com/login/device", method: "auto", instructions: "Enter code: 15EF-0DB6" },
};

type Call = { op: string; parameters: unknown; signal?: AbortSignal };

function fakeClient(overrides: { callback?: (parameters: Record<string, unknown>, signal?: AbortSignal) => Promise<{ data?: boolean; error?: unknown }> } = {}) {
  const calls: Call[] = [];
  const oauth = {
    authorize: async (parameters: { providerID: string; method: number }) => {
      calls.push({ op: "authorize", parameters });
      const found = AUTHORIZATIONS[`${parameters.providerID}:${parameters.method}`];
      return found ? { data: found } : { error: { name: "ProviderAuthOauthMissing", data: { message: "no such method" } } };
    },
    callback: async (parameters: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      calls.push({ op: "callback", parameters, signal: options?.signal });
      return overrides.callback ? overrides.callback(parameters, options?.signal) : { data: true };
    },
  };
  const client = {
    provider: {
      list: async () => ({ data: PROVIDERS }),
      auth: async () => ({ data: AUTH }),
      oauth,
    },
    instance: {
      dispose: async () => {
        calls.push({ op: "dispose", parameters: undefined });
        return { data: true };
      },
    },
    auth: {
      set: async (parameters: unknown) => {
        calls.push({ op: "set", parameters });
        return { data: true };
      },
      remove: async (parameters: unknown) => {
        calls.push({ op: "remove", parameters });
        return { data: true };
      },
    },
  } as unknown as OpenCodeV1AccountClient;
  return { client, calls };
}

describe("OpenCode 1.x account status", () => {
  test("lists connected providers first, with their credential kind, and never copies a provider's key", async () => {
    const { client } = fakeClient();
    const status = await new OpenCodeV1AccountAdapter(client).status();
    expect(status.targets.map(target => [target.id, target.connected])).toEqual([
      ["github-copilot", true],
      ["groq", true],
      ["mistral", true],
      ["openai", true],
      ["opencode", true],
      ["berget", false],
      ["cloudflare-workers-ai", false],
    ]);
    // A plugin-backed provider whose OAuth login is saved reports `custom`:
    // it is a saved login. A provider with no login methods is built in.
    expect(status.targets.find(target => target.id === "github-copilot")?.credentials[0]).toMatchObject({ kind: "saved", removable: true });
    expect(status.targets.find(target => target.id === "opencode")?.credentials[0]).toMatchObject({ kind: "other", removable: false });
    expect(status.targets.find(target => target.id === "mistral")?.credentials[0]).toMatchObject({ kind: "saved", removable: true });
    expect(status.targets.find(target => target.id === "openai")?.credentials).toEqual([
      { id: "openai", label: "Saved login", kind: "saved", active: true, removable: true },
    ]);
    expect(status.targets.find(target => target.id === "groq")?.credentials).toEqual([
      { id: "groq", label: "Environment", kind: "env", active: true, removable: false, variables: ["GROQ_API_KEY"] },
    ]);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("sk-must-never-leak");
    expect(serialized).not.toContain("gsk-env-secret");
    expect(serialized).not.toContain("mk-saved-secret");
  });

  test("listed methods keep their index ids; a provider without listed methods gets the implicit key method", async () => {
    const { client } = fakeClient();
    const status = await new OpenCodeV1AccountAdapter(client).status();
    const openai = status.targets.find(target => target.id === "openai")!;
    expect(openai.methods.map(method => [method.id, method.kind, method.label])).toEqual([
      ["0", "oauth", "ChatGPT Pro/Plus (browser)"],
      ["1", "oauth", "ChatGPT Pro/Plus (headless)"],
      ["2", "key", "Manually enter API Key"],
      ["env", "env", "Environment variable"],
    ]);
    const berget = status.targets.find(target => target.id === "berget")!;
    expect(berget.methods).toEqual([{ id: IMPLICIT_KEY_METHOD_ID, kind: "key", label: "API key", fields: [] }]);
    const copilot = status.targets.find(target => target.id === "github-copilot")!;
    expect(copilot.methods[0]).toMatchObject({ id: "0", kind: "oauth" });
    expect(copilot.methods[0]?.kind === "oauth" && copilot.methods[0].fields.map(field => field.key)).toEqual(["deploymentType", "enterpriseUrl"]);
  });
});

describe("OpenCode 1.x key login", () => {
  test("a key with an extra field is saved the way `opencode auth login` saves it", async () => {
    const { client, calls } = fakeClient();
    const adapter = new OpenCodeV1AccountAdapter(client);
    await adapter.connectKey("cloudflare-workers-ai", "0", "  cf-key  ", { accountId: "abc123" });
    // The Hub's own server is reset after the change, so it reports the new
    // login as saved rather than as a provider with no key.
    expect(calls).toEqual([
      { op: "set", parameters: { providerID: "cloudflare-workers-ai", auth: { type: "api", key: "cf-key", metadata: { accountId: "abc123" } } } },
      { op: "dispose", parameters: undefined },
    ]);
  });

  test("the implicit key method saves a bare key", async () => {
    const { client, calls } = fakeClient();
    await new OpenCodeV1AccountAdapter(client).connectKey("berget", IMPLICIT_KEY_METHOD_ID, "bk", {});
    expect(calls.filter(call => call.op === "set")).toEqual([{ op: "set", parameters: { providerID: "berget", auth: { type: "api", key: "bk" } } }]);
  });

  test("a missing required field or empty key is refused before reaching OpenCode, naming the field", async () => {
    const { client, calls } = fakeClient();
    const adapter = new OpenCodeV1AccountAdapter(client);
    const missingField = await adapter.connectKey("cloudflare-workers-ai", "0", "cf-key", {}).catch(error => error);
    expect(missingField).toBeInstanceOf(AccountOperationError);
    expect(missingField.field).toBe("accountId");
    const emptyKey = await adapter.connectKey("berget", IMPLICIT_KEY_METHOD_ID, "  ", {}).catch(error => error);
    expect(emptyKey.field).toBe("key");
    expect(calls).toEqual([]);
  });

  test("an OAuth method does not take a key", async () => {
    const { client } = fakeClient();
    await expect(new OpenCodeV1AccountAdapter(client).connectKey("openai", "0", "sk", {})).rejects.toThrow("does not take a key");
  });
});

describe("OpenCode 1.x browser login", () => {
  test("ChatGPT browser is a redirect login whose callback is the loopback listener", async () => {
    const { client, calls } = fakeClient();
    const login = await new OpenCodeV1AccountAdapter(client).startLogin("openai", "0", {});
    expect(login.completion).toBe("redirect");
    expect(login.callback).toEqual({ protocol: "http:", hostname: "localhost", port: "1455", pathname: "/auth/callback" });
    await login.waitForCompletion();
    expect(calls.map(call => call.op)).toEqual(["authorize", "callback", "dispose"]);
    expect(calls[1]?.parameters).toEqual({ providerID: "openai", method: 0 });
  });

  test("ChatGPT headless and Copilot are device logins; Copilot's answers go as inputs", async () => {
    const { client, calls } = fakeClient();
    const adapter = new OpenCodeV1AccountAdapter(client);
    const headless = await adapter.startLogin("openai", "1", {});
    expect([headless.completion, headless.instructions]).toEqual(["device", "Enter code: BBWH-P2AH6"]);
    const copilot = await adapter.startLogin("github-copilot", "0", { deploymentType: "github.com", enterpriseUrl: "ignored" });
    expect(copilot.completion).toBe("device");
    expect(calls.at(-1)?.parameters).toEqual({ providerID: "github-copilot", method: 0, inputs: { deploymentType: "github.com" } });
  });

  test("a code login waits for the pasted code and a wrong code leaves it open for another try", async () => {
    AUTHORIZATIONS["anthropic:0"] = { url: "https://claude.ai/oauth/authorize?code=true", method: "code", instructions: "Paste the authorization code here:" };
    (AUTH as Record<string, unknown>).anthropic = [{ type: "oauth", label: "Claude Pro/Max" }];
    PROVIDERS.all.push({ id: "anthropic", name: "Anthropic", source: "custom", env: [], options: {}, models: {} });
    try {
      let accept = false;
      const { client, calls } = fakeClient({ callback: async () => accept ? { data: true } : { error: { data: { message: "invalid code" } } } });
      const login = await new OpenCodeV1AccountAdapter(client).startLogin("anthropic", "0", {});
      expect(login.completion).toBe("code");
      const settled = login.waitForCompletion();
      const wrong = await login.submitCode!("bad").catch(error => error);
      expect(wrong).toBeInstanceOf(AccountOperationError);
      expect(wrong.message).toBe("invalid code");
      accept = true;
      await login.submitCode!("good");
      await settled;
      expect(calls.filter(call => call.op === "callback").at(-1)?.parameters).toEqual({ providerID: "anthropic", method: 0, code: "good" });
    } finally {
      delete AUTHORIZATIONS["anthropic:0"];
      delete (AUTH as Record<string, unknown>).anthropic;
      PROVIDERS.all.pop();
    }
  });

  test("cancel aborts the blocking callback request", async () => {
    const { client, calls } = fakeClient({
      callback: (_parameters, signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    });
    const login = await new OpenCodeV1AccountAdapter(client).startLogin("openai", "1", {});
    const waiting = login.waitForCompletion().catch(error => error);
    await login.cancel();
    expect(await waiting).toBeInstanceOf(Error);
    expect(calls.find(call => call.op === "callback")?.signal?.aborted).toBe(true);
  });
});

describe("OpenCode 1.x logout", () => {
  test("a saved login is removed; an environment login is refused without calling OpenCode", async () => {
    const { client, calls } = fakeClient();
    const adapter = new OpenCodeV1AccountAdapter(client);
    await adapter.status();
    await adapter.logout("openai");
    expect(calls).toEqual([{ op: "remove", parameters: { providerID: "openai" } }, { op: "dispose", parameters: undefined }]);
    await expect(adapter.logout("groq")).rejects.toThrow("not saved in OpenCode");
    expect(calls.length).toBe(2);
  });
});
