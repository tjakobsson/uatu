/**
 * The Hub's own agent runtimes for Agent accounts (design D1). Agent
 * runtimes otherwise exist only inside running workspaces, and a login has to
 * work with none running, so the Hub starts its own:
 *
 * - OpenCode: an `opencode serve` through the same `OpenCodeService` a
 *   workspace uses (same binary resolution, loopback, password, and
 *   two-generation readiness probe), in a Hub-owned working directory. The
 *   generation it answers with picks the account adapter.
 * - Claude Code: the same executable discovery and version probe a workspace
 *   uses; the adapter opens its own short-lived SDK sessions.
 *
 * Both get the environment workspaces get (the Hub's, minus ambient Git and
 * SSH credentials), with `HOME` and `XDG_*` untouched, so they read and write
 * exactly the agent stores the workspaces use.
 */

import { ClaudeRuntime } from "../chat/claude/runtime";
import { OpenCodeService } from "../chat/opencode/opencode-service";
import type { AccountAdapter } from "./agent-account-adapter";
import { ClaudeAccountAdapter } from "./agent-account-claude";
import { createOpenCodeV1AccountAdapter } from "./agent-account-opencode-v1";
import { createOpenCodeV2AccountAdapter } from "./agent-account-opencode-v2";
import type { AccountAgentId } from "./agent-account-types";

export type AccountRuntimeStart =
  | { state: "ready"; version?: string; generation?: 1 | 2; adapter: AccountAdapter }
  | { state: "not-installed" | "unavailable"; message: string };

export interface AccountRuntime {
  start(): Promise<AccountRuntimeStart>;
  stop(): Promise<void>;
}

export type AccountRuntimeFactory = (agent: AccountAgentId) => AccountRuntime;

export function createAccountRuntimeFactory(options: { cwd: string; env: Record<string, string> }): AccountRuntimeFactory {
  return agent => agent === "opencode" ? new OpenCodeAccountRuntime(options) : new ClaudeAccountRuntime(options);
}

class OpenCodeAccountRuntime implements AccountRuntime {
  private readonly service: OpenCodeService;
  private adapter: AccountAdapter | null = null;

  constructor(private readonly options: { cwd: string; env: Record<string, string> }) {
    this.service = new OpenCodeService({ workspacePath: options.cwd, env: options.env });
  }

  async start(): Promise<AccountRuntimeStart> {
    let availability = await this.service.status();
    // One retry: two OpenCode servers starting against the same data
    // directory at the same instant can collide, and the second try is
    // started after the first has given up.
    if (availability.state === "unavailable" && availability.reason === "startup-failed") availability = await this.service.retry();
    if (availability.state === "unavailable") {
      return availability.reason === "not-installed"
        ? { state: "not-installed", message: "OpenCode is not installed or is not on the Hub's PATH." }
        : { state: "unavailable", message: availability.message };
    }
    const connection = this.service.currentConnection();
    if (availability.state !== "ready" || !connection) return { state: "unavailable", message: "OpenCode did not become ready." };
    const adapterOptions = { endpoint: connection.endpoint, password: connection.password, directory: this.options.cwd };
    this.adapter = connection.generation === 2 ? createOpenCodeV2AccountAdapter(adapterOptions) : createOpenCodeV1AccountAdapter(adapterOptions);
    return { state: "ready", version: availability.version, generation: connection.generation, adapter: this.adapter };
  }

  async stop(): Promise<void> {
    await this.adapter?.dispose();
    this.adapter = null;
    await this.service.dispose();
  }
}

class ClaudeAccountRuntime implements AccountRuntime {
  private readonly runtime: ClaudeRuntime;
  private adapter: ClaudeAccountAdapter | null = null;

  constructor(private readonly options: { cwd: string; env: Record<string, string> }) {
    this.runtime = new ClaudeRuntime({ workspacePath: options.cwd, env: options.env });
  }

  async start(): Promise<AccountRuntimeStart> {
    const availability = await this.runtime.ensure();
    if (availability.state === "unavailable") {
      return availability.reason === "not-installed"
        ? { state: "not-installed", message: "Claude Code is not installed or is not on the Hub's PATH." }
        : { state: "unavailable", message: availability.message };
    }
    const executable = this.runtime.executablePath();
    if (availability.state !== "ready" || !executable) return { state: "unavailable", message: "Claude Code did not answer." };
    this.adapter = new ClaudeAccountAdapter({ cwd: this.options.cwd, executable, env: this.options.env });
    return { state: "ready", version: availability.version, adapter: this.adapter };
  }

  async stop(): Promise<void> {
    await this.adapter?.dispose();
    this.adapter = null;
    this.runtime.dispose();
  }
}
