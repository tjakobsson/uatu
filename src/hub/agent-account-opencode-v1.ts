/**
 * Agent accounts for OpenCode 1.x, over `@opencode-ai/sdk/v2` (the 1.x SDK's
 * second client, the one the 1.x chat provider already uses).
 *
 * - Providers: `provider.list` (all, plus which are connected) merged with
 *   `provider.auth` (each provider's login methods and their prompts).
 * - Key login: `auth.set({ type: "api", key, metadata })`. This is what
 *   `opencode auth login` itself saves; a key method's prompt answers become
 *   the metadata.
 * - Browser login: `provider.oauth.authorize` (with the prompt answers as
 *   `inputs`), then `provider.oauth.callback`. For `method: "auto"` the
 *   callback request blocks until the plugin's own poll or local listener
 *   completes; for `method: "code"` it carries the pasted code.
 * - Logout: `auth.remove`. Only a login saved to OpenCode's store
 *   (`source: "api"`) can be removed; environment and configuration logins
 *   are reported as such.
 *
 * `provider.list` answers each provider's `key` when it has one. Nothing
 * from that field is ever copied into the account model.
 *
 * After every change the Hub's own server is reset (`instance.dispose`). A
 * 1.x instance that has already listed its providers reports a key saved
 * afterwards as `custom`, with no key, until it reloads them (1.18.34), which
 * would hide the new login's logout. This server is the Hub's alone, with no
 * conversation or event stream to disturb. Workspaces' servers are never
 * reset; they replay the change instead (design D6).
 */

import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";

import { fieldsFromOpenCodeV1Prompts, stringAnswers } from "./agent-account-fields";
import { classifyCompletion } from "./agent-account-redirect";
import { AccountOperationError, agentErrorMessage, validatedAnswers, type AccountAdapter, type AccountAdapterStatus, type StartedLogin } from "./agent-account-adapter";
import type { AccountCredential, AccountMethod, AccountTarget } from "./agent-account-types";

type Result<T> = { data?: T; error?: unknown };

// `key` is read only to learn that a login is saved; its value is never copied.
type V1Provider = { id: string; name?: string; source?: string; env?: string[]; key?: unknown };
type V1Method = { type?: string; label?: string; prompts?: unknown };

/** The implicit method `opencode auth login` offers a provider whose plugin lists none. */
export const IMPLICIT_KEY_METHOD_ID = "key";

export type OpenCodeV1AccountClient = Pick<OpencodeClient, "provider" | "auth" | "instance">;

export function createOpenCodeV1AccountAdapter(options: { endpoint: string; password: string; directory: string; fetch?: typeof globalThis.fetch }): OpenCodeV1AccountAdapter {
  const authorization = `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`;
  const client = createOpencodeClient({
    baseUrl: options.endpoint,
    directory: options.directory,
    headers: { authorization },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return new OpenCodeV1AccountAdapter(client);
}

function unwrap<T>(result: Result<T>, fallback: string): T {
  if (result.error !== undefined && result.error !== null) throw new AccountOperationError(agentErrorMessage(result.error, fallback));
  if (result.data === undefined) throw new AccountOperationError(fallback);
  return result.data;
}

function credentialFor(provider: V1Provider, hasLoginMethods: boolean): AccountCredential {
  // 1.x does not report `api` for every saved login: a key saved for Groq on
  // a fresh configuration comes back `custom` (1.18.34), and so does a
  // plugin-backed OAuth login (ChatGPT, Copilot). A saved login carries a key
  // or belongs to a provider with login methods of its own; OpenCode Zen's
  // free provider has neither and is built in.
  const hasKey = typeof provider.key === "string" && provider.key !== "";
  const source = provider.source === "custom" && (hasKey || hasLoginMethods) ? "api" : provider.source;
  switch (source) {
    case "api":
      return { id: provider.id, label: "Saved login", kind: "saved", active: true, removable: true };
    case "env":
      return {
        id: provider.id,
        label: "Environment",
        kind: "env",
        active: true,
        removable: false,
        ...(provider.env?.length ? { variables: [...provider.env] } : {}),
      };
    case "config":
      return { id: provider.id, label: "OpenCode configuration", kind: "config", active: true, removable: false };
    default:
      return { id: provider.id, label: "Built in", kind: "other", active: true, removable: false };
  }
}

export function methodsForV1Provider(provider: V1Provider, listed: V1Method[]): AccountMethod[] {
  const methods: AccountMethod[] = [];
  listed.forEach((method, index) => {
    const label = method.label?.trim() || (method.type === "oauth" ? "Log in with the browser" : "API key");
    const fields = fieldsFromOpenCodeV1Prompts(method.prompts);
    if (method.type === "oauth") methods.push({ id: String(index), kind: "oauth", label, fields });
    else if (method.type === "api") methods.push({ id: String(index), kind: "key", label, fields });
  });
  if (listed.length === 0) methods.push({ id: IMPLICIT_KEY_METHOD_ID, kind: "key", label: "API key", fields: [] });
  if (provider.env?.length) methods.push({ id: "env", kind: "env", label: "Environment variable", variables: [...provider.env] });
  return methods;
}

export class OpenCodeV1AccountAdapter implements AccountAdapter {
  readonly capabilities = { login: true, logout: true, activate: false };
  // The last listing, so a login validates against the methods the page was shown.
  private targets = new Map<string, AccountTarget>();

  constructor(private readonly client: OpenCodeV1AccountClient) {}

  async status(): Promise<AccountAdapterStatus> {
    const [list, auth] = await Promise.all([
      this.client.provider.list() as Promise<Result<{ all: V1Provider[]; connected: string[] }>>,
      this.client.provider.auth() as Promise<Result<Record<string, V1Method[]>>>,
    ]);
    const providers = unwrap(list, "OpenCode did not list its providers.");
    const methods = unwrap(auth, "OpenCode did not list its login methods.");
    const connected = new Set(providers.connected ?? []);
    const targets: AccountTarget[] = [];
    for (const provider of providers.all ?? []) {
      if (typeof provider?.id !== "string" || !provider.id) continue;
      const isConnected = connected.has(provider.id);
      targets.push({
        id: provider.id,
        name: provider.name?.trim() || provider.id,
        connected: isConnected,
        credentials: isConnected ? [credentialFor(provider, Array.isArray(methods[provider.id]) && methods[provider.id]!.length > 0)] : [],
        methods: methodsForV1Provider(provider, Array.isArray(methods[provider.id]) ? methods[provider.id]! : []),
      });
    }
    targets.sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
    this.targets = new Map(targets.map(target => [target.id, target]));
    return { targets, methods: [] };
  }

  private async method(target: string, methodId: string): Promise<AccountMethod> {
    if (!this.targets.has(target)) await this.status();
    const found = this.targets.get(target)?.methods.find(method => method.id === methodId);
    if (!found) throw new AccountOperationError("OpenCode does not offer that login method for this provider.");
    return found;
  }

  async connectKey(target: string, methodId: string, key: string, answers: Record<string, unknown>): Promise<void> {
    const method = await this.method(target, methodId);
    if (method.kind !== "key") throw new AccountOperationError("That login method does not take a key.");
    if (!key.trim()) throw new AccountOperationError("Enter a key.", "key");
    const metadata = stringAnswers(validatedAnswers(method.fields, answers));
    const result = await this.client.auth.set({
      providerID: target,
      auth: { type: "api", key: key.trim(), ...(Object.keys(metadata).length ? { metadata } : {}) },
    }) as Result<boolean>;
    unwrap(result, "OpenCode did not save the key.");
    await this.reload();
  }

  /** Re-reads the store on the Hub's own server; a failure only leaves a stale label. */
  private async reload(): Promise<void> {
    await (this.client.instance?.dispose() as Promise<unknown> | undefined)?.catch(() => undefined);
  }

  async startLogin(target: string, methodId: string, answers: Record<string, unknown>): Promise<StartedLogin> {
    const method = await this.method(target, methodId);
    if (method.kind !== "oauth") throw new AccountOperationError("That login method is not a browser login.");
    const index = Number(methodId);
    const inputs = stringAnswers(validatedAnswers(method.fields, answers));
    const authorization = unwrap(
      await this.client.provider.oauth.authorize({ providerID: target, method: index, ...(Object.keys(inputs).length ? { inputs } : {}) }) as Result<{ url: string; method: "auto" | "code"; instructions: string }>,
      "OpenCode did not start the login.",
    );
    const { completion, callback } = classifyCompletion(authorization.url, authorization.method === "code" ? "code" : "auto");
    const abort = new AbortController();
    const finish = async (code?: string) => {
      const result = await this.client.provider.oauth.callback(
        { providerID: target, method: index, ...(code ? { code } : {}) },
        { signal: abort.signal },
      ) as Result<boolean>;
      if (unwrap(result, "OpenCode did not complete the login.") !== true) throw new AccountOperationError("OpenCode did not complete the login.");
      await this.reload();
    };
    // Only a code login waits on the user; every other kind waits on OpenCode.
    let codeWaiter: { resolve: () => void; reject: (error: unknown) => void } | null = null;
    const codeSettled = completion === "code"
      ? new Promise<void>((resolve, reject) => {
        codeWaiter = { resolve, reject };
      })
      : null;
    // Settled by the code or by cancel, possibly before anyone waits on it.
    codeSettled?.catch(() => undefined);
    return {
      url: authorization.url,
      instructions: authorization.instructions ?? "",
      completion,
      callback,
      waitForCompletion: () => codeSettled ?? finish(),
      ...(completion === "code"
        ? {
          submitCode: async (code: string) => {
            if (!code.trim()) throw new AccountOperationError("Paste the code the sign-in page showed.", "code");
            try {
              await finish(code.trim());
              codeWaiter?.resolve();
            } catch (error) {
              // A wrong code fails this submission; the attempt stays open for another try.
              throw new AccountOperationError(agentErrorMessage(error, "OpenCode did not accept the code."), "code");
            }
          },
        }
        : {}),
      cancel: async () => {
        abort.abort();
        codeWaiter?.reject(new AccountOperationError("The login was cancelled."));
      },
    };
  }

  async logout(target: string): Promise<void> {
    const existing = this.targets.get(target) ?? (await this.status(), this.targets.get(target));
    const credential = existing?.credentials[0];
    if (!credential?.removable) throw new AccountOperationError("This login is not saved in OpenCode, so it cannot be logged out here.");
    unwrap(await this.client.auth.remove({ providerID: target }) as Result<boolean>, "OpenCode did not remove the login.");
    await this.reload();
  }

  async activate(): Promise<void> {
    throw new AccountOperationError("This OpenCode version keeps one login per provider.");
  }

  async dispose(): Promise<void> {}
}
