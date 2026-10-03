import { describe, expect, test } from "bun:test";

import { AccountOperationError, AttemptExpiredError } from "./agent-account-adapter";
import { OpenCodeV2AccountAdapter, V2_KEY_METHOD_ID, type OpenCodeV2AccountClient } from "./agent-account-opencode-v2";

const COPILOT_FORM = [
  { key: "deploymentType", title: "Select GitHub deployment type", required: true, type: "string", options: [{ value: "github.com", label: "GitHub.com" }, { value: "enterprise", label: "GitHub Enterprise" }] },
  { key: "enterpriseUrl", title: "Enterprise URL", required: true, type: "string", when: [{ key: "deploymentType", op: "eq", value: "enterprise" }] },
];

// Method lists as OpenCode 2.0.13's `integration.list` answered them on 2026-10-03.
function integrations() {
  return [
    {
      id: "openai",
      name: "OpenAI",
      methods: [
        { type: "key" },
        { type: "env", names: ["OPENAI_API_KEY"] },
        { id: "chatgpt-browser", type: "oauth", label: "ChatGPT Pro/Plus (browser)" },
        { id: "chatgpt-headless", type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
      ],
      connections: [] as unknown[],
    },
    {
      id: "github-copilot",
      name: "GitHub Copilot",
      methods: [{ type: "env", names: ["GITHUB_TOKEN"] }, { id: "device", type: "oauth", label: "Login with GitHub Copilot", form: COPILOT_FORM }],
      connections: [],
    },
    {
      id: "groq",
      name: "Groq",
      methods: [{ type: "key" }, { type: "env", names: ["GROQ_API_KEY"] }],
      connections: [
        { type: "credential", id: "cred_a", label: "Groq work", method: "key" },
        { type: "env", name: "GROQ_API_KEY" },
      ],
    },
    { id: "helper", name: "Helper", methods: [{ id: "run", type: "command", label: "Run helper", command: ["helper", "login"] }], connections: [] },
  ];
}

const NOT_FOUND = Object.assign(new Error("UnexpectedStatus: 404"), { reason: "UnexpectedStatus", cause: { status: 404 } });

type Call = { op: string; input: unknown };

function fakeClient(options: {
  credentials?: "unsupported" | Array<{ id: string; integrationID: string; label: string; active: boolean; value: { type: string } }>;
  statuses?: Array<{ status: string; message?: string }>;
  complete?: (input: Record<string, unknown>) => Promise<void>;
} = {}) {
  const calls: Call[] = [];
  const statuses = [...(options.statuses ?? [{ status: "complete" }])];
  const attempts: Record<string, { attemptID: string; url: string; instructions: string; mode: "auto" | "code"; time: { created: number; expires: number } }> = {
    "chatgpt-browser": {
      attemptID: "att_browser",
      url: "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
      instructions: "Complete authorization in your browser.",
      mode: "auto",
      time: { created: 1, expires: 600_001 },
    },
    "chatgpt-headless": { attemptID: "att_headless", url: "https://auth.openai.com/codex/device", instructions: "Enter code: AAAA-BBBB", mode: "auto", time: { created: 1, expires: 900_001 } },
    device: { attemptID: "att_copilot", url: "https://github.com/login/device", instructions: "Enter code: 1234-5678", mode: "auto", time: { created: 1, expires: 900_001 } },
  };
  const client = {
    integration: {
      list: async (input: unknown) => {
        calls.push({ op: "list", input });
        return { location: {}, data: integrations() };
      },
      connect: {
        key: async (input: unknown) => {
          calls.push({ op: "connect.key", input });
        },
      },
      oauth: {
        connect: async (input: { methodID: string }) => {
          calls.push({ op: "oauth.connect", input });
          return { location: {}, data: attempts[input.methodID] ?? { attemptID: "att_code", url: "https://example.test/authorize", instructions: "Paste the code", mode: "code", time: { created: 1, expires: 2 } } };
        },
        status: async (input: unknown) => {
          calls.push({ op: "oauth.status", input });
          return { location: {}, data: statuses.length > 1 ? statuses.shift() : statuses[0] };
        },
        complete: async (input: Record<string, unknown>) => {
          calls.push({ op: "oauth.complete", input });
          await options.complete?.(input);
        },
        cancel: async (input: unknown) => {
          calls.push({ op: "oauth.cancel", input });
        },
      },
    },
    credential: {
      list: async () => {
        calls.push({ op: "credential.list", input: undefined });
        if (options.credentials === "unsupported") throw NOT_FOUND;
        return options.credentials ?? [];
      },
      remove: async (input: unknown) => {
        calls.push({ op: "credential.remove", input });
      },
      activate: async (input: unknown) => {
        calls.push({ op: "credential.activate", input });
      },
    },
  } as unknown as OpenCodeV2AccountClient;
  return { client, calls };
}

const LOCATION = { location: { directory: "/hub/agent-accounts" } };

describe("OpenCode 2.x account status", () => {
  test("lists connected integrations first with their saved and environment credentials", async () => {
    const { client } = fakeClient({
      credentials: [
        { id: "cred_a", integrationID: "groq", label: "Groq work", active: true, value: { type: "key" } },
        { id: "cred_b", integrationID: "groq", label: "Groq personal", active: false, value: { type: "key" } },
      ],
    });
    const adapter = new OpenCodeV2AccountAdapter(client, "/hub/agent-accounts", 1);
    const status = await adapter.status();
    expect(status.targets[0]?.id).toBe("groq");
    expect(status.targets[0]?.credentials).toEqual([
      { id: "cred_a", label: "Groq work", kind: "key", active: true, removable: true },
      { id: "cred_b", label: "Groq personal", kind: "key", active: false, removable: true },
      { id: "env:GROQ_API_KEY", label: "Environment", kind: "env", active: true, removable: false, variables: ["GROQ_API_KEY"] },
    ]);
    expect(adapter.capabilities).toEqual({ login: true, logout: true, activate: true });
  });

  test("methods map by type: key, oauth with its form, env as information, command as the login command", async () => {
    const { client } = fakeClient();
    const status = await new OpenCodeV2AccountAdapter(client, "/d", 1).status();
    const byId = Object.fromEntries(status.targets.map(target => [target.id, target]));
    expect(byId.openai?.methods.map(method => [method.id, method.kind])).toEqual([
      [V2_KEY_METHOD_ID, "key"],
      ["env", "env"],
      ["chatgpt-browser", "oauth"],
      ["chatgpt-headless", "oauth"],
    ]);
    const copilot = byId["github-copilot"]?.methods.find(method => method.kind === "oauth");
    expect(copilot?.kind === "oauth" && copilot.fields.map(field => field.key)).toEqual(["deploymentType", "enterpriseUrl"]);
    expect(byId.helper?.methods).toEqual([{ id: "run", kind: "command", label: "Run helper", command: "opencode auth login" }]);
  });

  test("a server without credential routes loses logout and switching, and connections still describe logins", async () => {
    const { client, calls } = fakeClient({ credentials: "unsupported" });
    const adapter = new OpenCodeV2AccountAdapter(client, "/d", 1);
    const status = await adapter.status();
    expect(adapter.capabilities).toEqual({ login: true, logout: false, activate: false });
    expect(status.targets[0]?.credentials[0]).toEqual({ id: "cred_a", label: "Groq work", kind: "key", active: true, removable: false });
    await adapter.status();
    expect(calls.filter(call => call.op === "credential.list").length).toBe(1);
    await expect(adapter.logout("groq", "cred_a")).rejects.toThrow("cannot remove");
    await expect(adapter.activate("cred_a")).rejects.toThrow("cannot switch");
  });
});

describe("OpenCode 2.x key login", () => {
  test("a key goes to integration.connect.key with the directory", async () => {
    const { client, calls } = fakeClient();
    await new OpenCodeV2AccountAdapter(client, "/hub/agent-accounts", 1).connectKey("openai", V2_KEY_METHOD_ID, " sk-1 ", {});
    expect(calls.at(-1)).toEqual({ op: "connect.key", input: { ...LOCATION, integrationID: "openai", key: "sk-1" } });
  });
});

describe("OpenCode 2.x browser login", () => {
  test("a device login polls status until complete, and its form answers travel as the answer", async () => {
    const { client, calls } = fakeClient({ statuses: [{ status: "pending" }, { status: "pending" }, { status: "complete" }] });
    const login = await new OpenCodeV2AccountAdapter(client, "/hub/agent-accounts", 1).startLogin("github-copilot", "device", { deploymentType: "github.com" });
    expect([login.completion, login.instructions, login.expiresAt]).toEqual(["device", "Enter code: 1234-5678", 900_001]);
    expect(calls.find(call => call.op === "oauth.connect")?.input).toEqual({ ...LOCATION, integrationID: "github-copilot", methodID: "device", answer: { deploymentType: "github.com" } });
    await login.waitForCompletion();
    expect(calls.filter(call => call.op === "oauth.status").length).toBe(3);
  });

  test("the browser method is a redirect login on the loopback callback", async () => {
    const { client } = fakeClient();
    const login = await new OpenCodeV2AccountAdapter(client, "/d", 1).startLogin("openai", "chatgpt-browser", {});
    expect(login.completion).toBe("redirect");
    expect(login.callback?.port).toBe("1455");
  });

  test("failed and expired attempts reject with the agent's message or as expired", async () => {
    const failing = fakeClient({ statuses: [{ status: "failed", message: "Access denied" }] });
    const failed = await (await new OpenCodeV2AccountAdapter(failing.client, "/d", 1).startLogin("openai", "chatgpt-headless", {})).waitForCompletion().catch(error => error);
    expect(failed).toBeInstanceOf(AccountOperationError);
    expect(failed.message).toBe("Access denied");
    const expiring = fakeClient({ statuses: [{ status: "expired" }] });
    const expired = await (await new OpenCodeV2AccountAdapter(expiring.client, "/d", 1).startLogin("openai", "chatgpt-headless", {})).waitForCompletion().catch(error => error);
    expect(expired).toBeInstanceOf(AttemptExpiredError);
  });

  test("cancel stops polling and cancels the attempt in OpenCode", async () => {
    const { client, calls } = fakeClient({ statuses: [{ status: "pending" }] });
    const login = await new OpenCodeV2AccountAdapter(client, "/d", 1).startLogin("openai", "chatgpt-headless", {});
    const waiting = login.waitForCompletion().catch(error => error);
    await login.cancel();
    expect((await waiting).message).toBe("The login was cancelled.");
    expect(calls.find(call => call.op === "oauth.cancel")?.input).toEqual({ location: { directory: "/d" }, integrationID: "openai", attemptID: "att_headless" });
  });
});

describe("OpenCode 2.x logout and switching", () => {
  test("logout removes the named credential and activate switches to it", async () => {
    const { client, calls } = fakeClient({ credentials: [{ id: "cred_a", integrationID: "groq", label: "Groq", active: true, value: { type: "key" } }] });
    const adapter = new OpenCodeV2AccountAdapter(client, "/d", 1);
    await adapter.logout("groq", "cred_a");
    await adapter.activate("cred_b");
    expect(calls.slice(-2)).toEqual([
      { op: "credential.remove", input: { credentialID: "cred_a" } },
      { op: "credential.activate", input: { credentialID: "cred_b" } },
    ]);
  });
});
