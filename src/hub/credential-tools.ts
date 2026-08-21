import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  CREDENTIAL_TOOLS,
  type CredentialTool,
  type PublicToolReadinessDto,
  type ReadinessResult,
} from "./credential-types";
import { CredentialToolOverrideStore } from "./credential-store";
import { providerCliVersionSupported } from "./provider-runtime";

const MAX_PATH_ENTRIES = 128;
const MAX_PATH_LENGTH = 32_768;
const PROBE_OUTPUT_LIMIT = 8_192;
const PROBE_TIMEOUT_MS = 5_000;

const VERSION_ARGUMENTS: Record<CredentialTool, string[]> = {
  ssh: ["-V"],
  "ssh-agent": ["-?"],
  "ssh-add": ["--help"],
  "ssh-keygen": ["-?"],
  gpg: ["--version"],
  gpgconf: ["--version"],
  git: ["--version"],
  gh: ["--version"],
  glab: ["--version"],
};

const USAGE_VERSION_TOOLS = new Set<CredentialTool>(["ssh-agent", "ssh-add", "ssh-keygen"]);

// Exit status alone accepts unrelated executables (/bin/false exits 1, which
// the usage probes tolerate). The probe output must also identify the tool.
const TOOL_BANNERS: Record<CredentialTool, RegExp> = {
  ssh: /OpenSSH/i,
  "ssh-agent": /ssh-agent/i,
  "ssh-add": /ssh-add/i,
  "ssh-keygen": /ssh-keygen/i,
  gpg: /GnuPG/i,
  gpgconf: /GnuPG/i,
  git: /git version/i,
  gh: /gh version/i,
  glab: /glab/i,
};

export type ToolDiscovery = {
  tool: CredentialTool;
  path: string | null;
  source: "override" | "path" | "missing";
  invalid?: boolean;
};

function pathEntries(value: string | undefined): string[] {
  if (!value || value.length > MAX_PATH_LENGTH) return [];
  return value.split(path.delimiter).slice(0, MAX_PATH_ENTRIES).filter(entry => entry !== "");
}

export async function validateExecutablePath(executablePath: string): Promise<string> {
  if (!path.isAbsolute(executablePath)) throw new Error("tool override path must be absolute");
  if (executablePath.includes("\0")) throw new Error("tool override path contains an invalid null byte");
  let stats;
  try {
    stats = await fs.stat(executablePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("tool override path does not exist");
    throw error;
  }
  if (!stats.isFile()) throw new Error("tool override path must resolve to a regular file");
  try {
    await fs.access(executablePath, constants.X_OK);
  } catch {
    throw new Error("tool override path is not executable");
  }
  return executablePath;
}

export async function discoverExecutable(
  tool: CredentialTool,
  options: { override?: string; path?: string } = {},
): Promise<ToolDiscovery> {
  if (!CREDENTIAL_TOOLS.includes(tool)) throw new Error(`unsupported credential tool: ${tool}`);
  if (options.override !== undefined) {
    return { tool, path: await validateExecutablePath(options.override), source: "override" };
  }
  for (const directory of pathEntries(options.path ?? process.env.PATH)) {
    const candidate = path.join(directory, tool);
    try {
      return { tool, path: await validateExecutablePath(candidate), source: "path" };
    } catch {
      // Continue through the bounded service PATH; invalid candidates are not executable discoveries.
    }
  }
  return { tool, path: null, source: "missing" };
}

export async function discoverCredentialTools(
  overrides: Partial<Record<CredentialTool, string>> = {},
  servicePath: string | undefined = process.env.PATH,
): Promise<ToolDiscovery[]> {
  return Promise.all(CREDENTIAL_TOOLS.map(async tool => {
    try {
      return await discoverExecutable(tool, { override: overrides[tool], path: servicePath });
    } catch {
      const override = overrides[tool];
      if (override === undefined) throw new Error(`credential tool discovery failed: ${tool}`);
      return { tool, path: override, source: "override", invalid: true };
    }
  }));
}

type ProcessProbeResult = {
  exitCode: number;
  timedOut: boolean;
  outputExceeded: boolean;
  output: string;
};

type ActiveProbe = {
  child: ReturnType<typeof Bun.spawn>;
  cancel: () => void;
};

function killProbe(active: ActiveProbe): void {
  active.cancel();
  if (process.platform === "win32" && active.child.pid > 0) {
    spawnSync("taskkill", ["/PID", String(active.child.pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 1_000,
      windowsHide: true,
    });
  }
  if (process.platform !== "win32" && active.child.pid > 0) {
    try {
      process.kill(-active.child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct child if its process group has already gone.
    }
  }
  try {
    active.child.kill("SIGKILL");
  } catch {
    // The direct child may already have exited.
  }
}

async function collectBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal,
  onExceeded: () => void,
): Promise<{ text: string; exceeded: boolean }> {
  const reader = stream.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  let exceeded = false;
  try {
    for (;;) {
      if (signal.aborted) break;
      const next = await reader.read();
      if (next.done) break;
      const remaining = limit - size;
      if (remaining > 0) {
        chunks.push(next.value.slice(0, remaining));
        size += Math.min(next.value.length, remaining);
      }
      if (next.value.length > remaining) {
        exceeded = true;
        onExceeded();
        break;
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (signal.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder().decode(bytes), exceeded };
}

async function runProbe(
  executablePath: string,
  args: string[],
  timeoutMs: number,
  activeProbes?: Set<ActiveProbe>,
): Promise<ProcessProbeResult> {
  const child = Bun.spawn([executablePath, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", LANG: "C", LC_ALL: "C" },
    detached: process.platform !== "win32",
  });
  const controller = new AbortController();
  const active: ActiveProbe = { child, cancel: () => controller.abort() };
  activeProbes?.add(active);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProbe(active);
  }, timeoutMs);
  try {
    const terminateForOutput = () => killProbe(active);
    const stdoutPromise = collectBounded(child.stdout, PROBE_OUTPUT_LIMIT, controller.signal, terminateForOutput);
    const stderrPromise = collectBounded(child.stderr, PROBE_OUTPUT_LIMIT, controller.signal, terminateForOutput);
    const exitCode = await child.exited;
    const streams = Promise.all([stdoutPromise, stderrPromise]);
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const drainTimeout = new Promise<[Awaited<typeof stdoutPromise>, Awaited<typeof stderrPromise>]>(resolve => {
      drainTimer = setTimeout(() => {
        killProbe(active);
        void streams.then(resolve);
      }, 100);
    });
    const [stdout, stderr] = await Promise.race([streams, drainTimeout]).finally(() => clearTimeout(drainTimer));
    return {
      exitCode,
      timedOut,
      outputExceeded: stdout.exceeded || stderr.exceeded,
      output: `${stdout.text}\n${stderr.text}`,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    activeProbes?.delete(active);
  }
}

function sanitizedVersion(output: string): string | null {
  const line = output.split(/\r?\n/).map(value => value.trim()).find(Boolean);
  if (!line) return null;
  return line.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 160) || null;
}

export function toolInstallationGuidance(tool: CredentialTool, platform: NodeJS.Platform = process.platform): string {
  const family = tool === "ssh" || tool.startsWith("ssh-") ? "OpenSSH" : tool === "gpg" || tool === "gpgconf" ? "GnuPG" : tool;
  if (platform === "darwin") return `Install ${family} with a trusted macOS package manager, or configure its absolute executable path.`;
  if (platform === "linux") return `Install ${family} with the system package manager, or configure its absolute executable path.`;
  return `Install ${family} for this platform, or configure its absolute executable path.`;
}

export async function probeCredentialTool(
  discovery: ToolDiscovery,
  timeoutMs = PROBE_TIMEOUT_MS,
  activeProbes?: Set<ActiveProbe>,
): Promise<PublicToolReadinessDto> {
  const results: ReadinessResult[] = [];
  if (discovery.invalid) {
    results.push({ layer: "binary", status: "unavailable", message: "The configured executable is missing, unsafe, or not executable." });
    return {
      tool: discovery.tool,
      path: discovery.path,
      version: null,
      results,
      guidance: toolInstallationGuidance(discovery.tool),
    };
  }
  if (!discovery.path) {
    results.push({ layer: "binary", status: "unavailable", message: "Executable was not found." });
    return {
      tool: discovery.tool,
      path: null,
      version: null,
      results,
      guidance: toolInstallationGuidance(discovery.tool),
    };
  }
  results.push({ layer: "binary", status: "ready", message: "Executable is available." });
  let probe: ProcessProbeResult;
  try {
    probe = await runProbe(discovery.path, VERSION_ARGUMENTS[discovery.tool], timeoutMs, activeProbes);
  } catch {
    results.push({ layer: "version", status: "unavailable", message: "Version probe could not start." });
    return { tool: discovery.tool, path: discovery.path, version: null, results, guidance: toolInstallationGuidance(discovery.tool) };
  }
  const version = USAGE_VERSION_TOOLS.has(discovery.tool) ? null : sanitizedVersion(probe.output);
  const acceptedExit = probe.exitCode === 0 || (USAGE_VERSION_TOOLS.has(discovery.tool) && (probe.exitCode === 1 || probe.exitCode === 2));
  if (probe.timedOut) {
    results.push({ layer: "version", status: "unavailable", message: "Version probe timed out." });
  } else if (probe.outputExceeded) {
    results.push({ layer: "version", status: "unavailable", message: "Version probe exceeded the output limit." });
  } else if (!acceptedExit || (!version && !USAGE_VERSION_TOOLS.has(discovery.tool))) {
    results.push({ layer: "version", status: "unavailable", message: "Executable did not report a compatible version." });
  } else if (!TOOL_BANNERS[discovery.tool].test(probe.output)) {
    results.push({ layer: "version", status: "unavailable", message: "Executable did not identify as the configured tool." });
  } else if (discovery.tool === "gh" && !providerCliVersionSupported("github", version)) {
    results.push({ layer: "version", status: "unavailable", message: "GitHub CLI 2.0 or newer is required." });
  } else if (discovery.tool === "glab" && !providerCliVersionSupported("gitlab", version)) {
    results.push({ layer: "version", status: "unavailable", message: "GitLab CLI 1.22 or newer is required." });
  } else {
    results.push({
      layer: "version",
      status: "ready",
      message: version ? "Compatible version was reported." : "Executable responded to the probe.",
    });
  }
  results.push({ layer: "runtime", status: "not-applicable", message: "Runtime readiness is tested when the capability is used." });
  const ready = results.every(result => result.status !== "unavailable");
  return {
    tool: discovery.tool,
    path: discovery.path,
    version: ready ? version : null,
    results,
    guidance: ready ? null : toolInstallationGuidance(discovery.tool),
  };
}

export function readyToolPath(readiness: PublicToolReadinessDto | undefined): string | null {
  return readiness?.path && readiness.results.every(result => result.status !== "unavailable") ? readiness.path : null;
}

export class CredentialToolManager {
  private readiness = new Map<CredentialTool, PublicToolReadinessDto>();
  private operationChain: Promise<unknown> = Promise.resolve();
  private readonly activeProbes = new Set<ActiveProbe>();
  private closing = false;

  constructor(
    private readonly store: CredentialToolOverrideStore,
    private readonly servicePath: string | undefined = process.env.PATH,
    private readonly probe: (discovery: ToolDiscovery) => Promise<PublicToolReadinessDto> = discovery => {
      if (this.closing) throw new Error("credential tool manager is shutting down");
      return probeCredentialTool(discovery, PROBE_TIMEOUT_MS, this.activeProbes);
    },
    private readonly applyRuntime: () => Promise<void> = async () => undefined,
  ) {}

  load(): Promise<void> {
    return this.enqueue(async () => {
      await this.store.load();
      await this.probeAll();
    });
  }

  list(): PublicToolReadinessDto[] {
    return CREDENTIAL_TOOLS.map(tool => this.readiness.get(tool)).filter(value => value !== undefined).map(value => structuredClone(value));
  }

  setOverride(tool: CredentialTool, executablePath: string): Promise<PublicToolReadinessDto> {
    return this.enqueue(async () => {
      const discovery = await discoverExecutable(tool, { override: executablePath, path: this.servicePath });
      const result = await this.probe(discovery);
      if (result.results.some(layer => layer.layer === "version" && layer.status !== "ready")) {
        throw new Error(`tool override failed validation: ${tool}`);
      }
      const previous = this.store.get(tool);
      const previousReadiness = new Map(this.readiness);
      await this.store.set({ tool, path: executablePath });
      try {
        await this.probeAll();
        const persisted = this.readiness.get(tool)!;
        if (persisted.results.some(layer => layer.status === "unavailable")) {
          throw new Error(`tool override failed validation: ${tool}`);
        }
        await this.applyRuntime();
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        try {
          if (previous) await this.store.set(previous);
          else await this.store.delete(tool);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        this.readiness = previousReadiness;
        try {
          await this.applyRuntime();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors], `tool override failed and restoration failed: ${tool}`);
        throw error;
      }
      return structuredClone(this.readiness.get(tool)!);
    });
  }

  clearOverride(tool: CredentialTool): Promise<PublicToolReadinessDto> {
    return this.enqueue(async () => {
      const previous = this.store.get(tool);
      const previousReadiness = new Map(this.readiness);
      await this.store.delete(tool);
      try {
        await this.probeAll();
        await this.applyRuntime();
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        try {
          if (previous) await this.store.set(previous);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        this.readiness = previousReadiness;
        try {
          await this.applyRuntime();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors], `tool override clear failed and restoration failed: ${tool}`);
        throw error;
      }
      return structuredClone(this.readiness.get(tool)!);
    });
  }

  reprobeAll(): Promise<void> {
    return this.enqueue(async () => {
      const previousReadiness = new Map(this.readiness);
      try {
        await this.probeAll();
        await this.applyRuntime();
      } catch (error) {
        this.readiness = previousReadiness;
        try {
          await this.applyRuntime();
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "tool re-probe failed and restoration failed");
        }
        throw error;
      }
    });
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    for (const active of this.activeProbes) killProbe(active);
    await this.operationChain.catch(() => undefined);
  }

  private async probeAll(): Promise<void> {
    const overrides = Object.fromEntries(this.store.list().map(value => [value.tool, value.path]));
    const discoveries = await discoverCredentialTools(overrides, this.servicePath);
    const results = await Promise.all(discoveries.map(discovery => this.probe(discovery)));
    this.readiness = new Map(results.map(result => [result.tool, result]));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("credential tool manager is shutting down"));
    const next = this.operationChain.then(operation, operation);
    this.operationChain = next.catch(() => undefined);
    return next;
  }
}
