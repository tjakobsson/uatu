/**
 * Agent accounts for OpenCode 2.x, over `@opencode/client`.
 *
 * - Integrations: `integration.list` gives each integration's login methods
 *   (`key`, `oauth`, `env`, `command`) and its live connections.
 * - Saved credentials: `credential.list`, used to say which credential is
 *   active and to log out or switch. Older 2.x servers do not answer the
 *   credential routes at all (2.0.13 returns 404). The first 404 turns logout
 *   and switching off for that server's lifetime, and connections alone
 *   describe the logins.
 * - Key login: `integration.connect.key`.
 * - Browser login: `integration.oauth.connect`, then `oauth.status` polled
 *   until it settles, with `oauth.complete` carrying a pasted code for a
 *   `code` attempt and `oauth.cancel` ending it.
 *
 * `env` methods read a variable from the agent's environment, and `command`
 * methods run a local helper whose output the user cannot see from here.
 * Both are listed with what the user does instead, never run.
 */

import { OpenCode } from "@opencode/client";

import { fieldsFromOpenCodeV2Form } from "./agent-account-fields";
import { classifyCompletion } from "./agent-account-redirect";
import { AccountOperationError, AttemptExpiredError, agentErrorMessage, validatedAnswers, type AccountAdapter, type AccountAdapterStatus, type StartedLogin } from "./agent-account-adapter";
import type { AccountCapabilities, AccountCredential, AccountMethod, AccountTarget } from "./agent-account-types";

export type OpenCodeV2AccountClient = Pick<ReturnType<typeof OpenCode.make>, "integration" | "credential">;

type V2Method = { type?: string; id?: string; label?: string; form?: unknown; names?: unknown; command?: unknown };
type V2Connection = { type?: string; id?: string; label?: string; method?: string; name?: string; status?: { status?: string; message?: string } };
type V2Integration = { id?: string; name?: string; methods?: V2Method[]; connections?: V2Connection[] };
type V2Credential = { id: string; integrationID: string; label: string; active: boolean; value?: { type?: string } };
type V2AttemptStatus = { status: "pending" | "complete" | "failed" | "expired"; message?: string; time?: { expires?: number } };

export const V2_KEY_METHOD_ID = "key";
const LOGIN_COMMAND = "opencode auth login";

export function createOpenCodeV2AccountAdapter(options: { endpoint: string; password: string; directory: string; fetch?: typeof globalThis.fetch; pollMs?: number }): OpenCodeV2AccountAdapter {
  const authorization = `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`;
  const client = OpenCode.make({
    baseUrl: options.endpoint,
    headers: { authorization },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return new OpenCodeV2AccountAdapter(client, options.directory, options.pollMs);
}

function isNotFound(error: unknown): boolean {
  const record = error as { reason?: unknown; cause?: { status?: unknown } } | null;
  return record?.reason === "UnexpectedStatus" && record.cause?.status === 404;
}

export function methodsForV2Integration(integration: V2Integration): AccountMethod[] {
  const methods: AccountMethod[] = [];
  for (const method of integration.methods ?? []) {
    switch (method.type) {
      case "key":
        methods.push({ id: V2_KEY_METHOD_ID, kind: "key", label: method.label?.trim() || "API key", fields: fieldsFromOpenCodeV2Form(method.form) });
        break;
      case "oauth":
        if (typeof method.id === "string" && method.id) {
          methods.push({ id: method.id, kind: "oauth", label: method.label?.trim() || "Log in with the browser", fields: fieldsFromOpenCodeV2Form(method.form) });
        }
        break;
      case "env": {
        const variables = Array.isArray(method.names) ? method.names.filter((name): name is string => typeof name === "string" && !!name) : [];
        if (variables.length) methods.push({ id: "env", kind: "env", label: "Environment variable", variables });
        break;
      }
      case "command":
        methods.push({ id: typeof method.id === "string" && method.id ? method.id : "command", kind: "command", label: method.label?.trim() || "Command", command: LOGIN_COMMAND });
        break;
    }
  }
  return methods;
}

export class OpenCodeV2AccountAdapter implements AccountAdapter {
  private credentialsSupported = true;
  private targets = new Map<string, AccountTarget>();

  constructor(private readonly client: OpenCodeV2AccountClient, private readonly directory: string, private readonly pollMs = 1_000) {}

  get capabilities(): AccountCapabilities {
    return { login: true, logout: this.credentialsSupported, activate: this.credentialsSupported };
  }

  private get location() {
    return { location: { directory: this.directory } };
  }

  private async credentials(): Promise<V2Credential[] | null> {
    if (!this.credentialsSupported) return null;
    try {
      return await this.client.credential.list() as V2Credential[];
    } catch (error) {
      if (isNotFound(error)) {
        this.credentialsSupported = false;
        return null;
      }
      throw new AccountOperationError(agentErrorMessage(error, "OpenCode did not list its saved credentials."));
    }
  }

  async status(): Promise<AccountAdapterStatus> {
    let integrations: V2Integration[];
    try {
      integrations = (await this.client.integration.list(this.location)).data as V2Integration[];
    } catch (error) {
      throw new AccountOperationError(agentErrorMessage(error, "OpenCode did not list its integrations."));
    }
    const saved = await this.credentials();
    const targets: AccountTarget[] = [];
    for (const integration of integrations ?? []) {
      if (typeof integration?.id !== "string" || !integration.id) continue;
      const credentials = this.credentialsFor(integration, saved);
      targets.push({
        id: integration.id,
        name: integration.name?.trim() || integration.id,
        connected: (integration.connections ?? []).length > 0,
        credentials,
        methods: methodsForV2Integration(integration),
      });
    }
    targets.sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
    this.targets = new Map(targets.map(target => [target.id, target]));
    return { targets, methods: [] };
  }

  private credentialsFor(integration: V2Integration, saved: V2Credential[] | null): AccountCredential[] {
    const connections = integration.connections ?? [];
    const statusOf = (id: string) => connections.find(connection => connection.type === "credential" && connection.id === id)?.status;
    const credentials: AccountCredential[] = [];
    if (saved) {
      for (const entry of saved.filter(candidate => candidate.integrationID === integration.id)) {
        const status = statusOf(entry.id);
        credentials.push({
          id: entry.id,
          label: entry.label || integration.name || integration.id!,
          kind: entry.value?.type === "oauth" ? "oauth" : "key",
          active: entry.active === true,
          removable: true,
          ...(status?.message ? { status: status.message } : {}),
        });
      }
    } else {
      for (const connection of connections.filter(candidate => candidate.type === "credential")) {
        credentials.push({
          id: connection.id ?? integration.id!,
          label: connection.label || integration.name || integration.id!,
          kind: connection.method === "oauth" ? "oauth" : "key",
          active: true,
          removable: false,
          ...(connection.status?.message ? { status: connection.status.message } : {}),
        });
      }
    }
    for (const connection of connections.filter(candidate => candidate.type === "env")) {
      credentials.push({
        id: `env:${connection.name ?? integration.id}`,
        label: "Environment",
        kind: "env",
        active: true,
        removable: false,
        ...(connection.name ? { variables: [connection.name] } : {}),
        ...(connection.status?.message ? { status: connection.status.message } : {}),
      });
    }
    return credentials;
  }

  private async method(target: string, methodId: string): Promise<AccountMethod> {
    if (!this.targets.has(target)) await this.status();
    const found = this.targets.get(target)?.methods.find(method => method.id === methodId);
    if (!found) throw new AccountOperationError("OpenCode does not offer that login method for this integration.");
    return found;
  }

  async connectKey(target: string, methodId: string, key: string, answers: Record<string, unknown>): Promise<void> {
    const method = await this.method(target, methodId);
    if (method.kind !== "key") throw new AccountOperationError("That login method does not take a key.");
    if (!key.trim()) throw new AccountOperationError("Enter a key.", "key");
    const answer = validatedAnswers(method.fields, answers);
    try {
      await this.client.integration.connect.key({
        ...this.location,
        integrationID: target,
        key: key.trim(),
        ...(Object.keys(answer).length ? { answer } : {}),
      } as Parameters<OpenCodeV2AccountClient["integration"]["connect"]["key"]>[0]);
    } catch (error) {
      throw new AccountOperationError(agentErrorMessage(error, "OpenCode did not save the key."), "key");
    }
  }

  async startLogin(target: string, methodId: string, answers: Record<string, unknown>): Promise<StartedLogin> {
    const method = await this.method(target, methodId);
    if (method.kind !== "oauth") throw new AccountOperationError("That login method is not a browser login.");
    const answer = validatedAnswers(method.fields, answers);
    let attempt: { attemptID: string; url: string; instructions: string; mode: "auto" | "code"; time?: { expires?: number } };
    try {
      attempt = (await this.client.integration.oauth.connect({
        ...this.location,
        integrationID: target,
        methodID: methodId,
        ...(Object.keys(answer).length ? { answer } : {}),
      } as Parameters<OpenCodeV2AccountClient["integration"]["oauth"]["connect"]>[0])).data;
    } catch (error) {
      throw new AccountOperationError(agentErrorMessage(error, "OpenCode did not start the login."));
    }
    const ids = { ...this.location, integrationID: target, attemptID: attempt.attemptID };
    const { completion, callback } = classifyCompletion(attempt.url, attempt.mode === "code" ? "code" : "auto");
    let stopped = false;
    const poll = async (): Promise<void> => {
      while (!stopped) {
        let status: V2AttemptStatus;
        try {
          status = (await this.client.integration.oauth.status(ids)).data as V2AttemptStatus;
        } catch (error) {
          throw new AccountOperationError(agentErrorMessage(error, "OpenCode stopped answering about the login."));
        }
        if (status.status === "complete") return;
        if (status.status === "failed") throw new AccountOperationError(status.message?.trim() || "OpenCode reported the login failed.");
        if (status.status === "expired") throw new AttemptExpiredError();
        await new Promise(resolve => setTimeout(resolve, this.pollMs));
      }
      throw new AccountOperationError("The login was cancelled.");
    };
    return {
      url: attempt.url,
      instructions: attempt.instructions ?? "",
      completion,
      callback,
      ...(typeof attempt.time?.expires === "number" && Number.isFinite(attempt.time.expires) ? { expiresAt: attempt.time.expires } : {}),
      waitForCompletion: poll,
      ...(completion === "code"
        ? {
          submitCode: async (code: string) => {
            if (!code.trim()) throw new AccountOperationError("Paste the code the sign-in page showed.", "code");
            try {
              await this.client.integration.oauth.complete({ ...ids, code: code.trim() } as Parameters<OpenCodeV2AccountClient["integration"]["oauth"]["complete"]>[0]);
            } catch (error) {
              throw new AccountOperationError(agentErrorMessage(error, "OpenCode did not accept the code."), "code");
            }
          },
        }
        : {}),
      cancel: async () => {
        stopped = true;
        await this.client.integration.oauth.cancel(ids).catch(() => undefined);
      },
    };
  }

  async logout(_target: string, credentialId: string): Promise<void> {
    if (!this.credentialsSupported) throw new AccountOperationError("This OpenCode version cannot remove saved logins.");
    try {
      await this.client.credential.remove({ credentialID: credentialId } as Parameters<OpenCodeV2AccountClient["credential"]["remove"]>[0]);
    } catch (error) {
      if (isNotFound(error)) this.credentialsSupported = false;
      throw new AccountOperationError(agentErrorMessage(error, "OpenCode did not remove the login."));
    }
  }

  async activate(credentialId: string): Promise<void> {
    if (!this.credentialsSupported) throw new AccountOperationError("This OpenCode version cannot switch saved logins.");
    try {
      await this.client.credential.activate({ credentialID: credentialId } as Parameters<OpenCodeV2AccountClient["credential"]["activate"]>[0]);
    } catch (error) {
      if (isNotFound(error)) this.credentialsSupported = false;
      throw new AccountOperationError(agentErrorMessage(error, "OpenCode did not switch the login."));
    }
  }

  async dispose(): Promise<void> {}
}
