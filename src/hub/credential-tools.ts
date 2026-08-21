import { constants, promises as fs } from "node:fs";
import path from "node:path";

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
  "ssh-agent": ["-?"],
  "ssh-add": ["-?"],
  "ssh-keygen": ["-?"],
  gpg: ["--version"],
  gpgconf: ["--version"],
  git: ["--version"],
  gh: ["--version"],
  glab: ["--version"],
};

const USAGE_VERSION_TOOLS = new Set<CredentialTool>(["ssh-agent", "ssh-add", "ssh-keygen"]);

export type ToolDiscovery = {
  tool: CredentialTool;
  path: string | null;
  source: "override" | "path" | "missing";
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
  return Promise.all(CREDENTIAL_TOOLS.map(tool => discoverExecutable(tool, {
    override: overrides[tool],
    path: servicePath,
  })));
}

type ProcessProbeResult = {
  exitCode: number;
  timedOut: boolean;
  outputExceeded: boolean;
  output: string;
};

async function collectBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<{ text: string; exceeded: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let exceeded = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = limit - size;
      if (remaining > 0) {
        chunks.push(next.value.slice(0, remaining));
        size += Math.min(next.value.length, remaining);
      }
      if (next.value.length > remaining) exceeded = true;
    }
  } finally {
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

async function runProbe(executablePath: string, args: string[], timeoutMs: number): Promise<ProcessProbeResult> {
  const child = Bun.spawn([executablePath, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", LANG: "C", LC_ALL: "C" },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have exited between the timer firing and the signal.
    }
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      collectBounded(child.stdout, PROBE_OUTPUT_LIMIT),
      collectBounded(child.stderr, PROBE_OUTPUT_LIMIT),
      child.exited,
    ]);
    return {
      exitCode,
      timedOut,
      outputExceeded: stdout.exceeded || stderr.exceeded,
      output: `${stdout.text}\n${stderr.text}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function sanitizedVersion(output: string): string | null {
  const line = output.split(/\r?\n/).map(value => value.trim()).find(Boolean);
  if (!line) return null;
  return line.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 160) || null;
}

export function toolInstallationGuidance(tool: CredentialTool, platform: NodeJS.Platform = process.platform): string {
  const family = tool.startsWith("ssh-") ? "OpenSSH" : tool === "gpg" || tool === "gpgconf" ? "GnuPG" : tool;
  if (platform === "darwin") return `Install ${family} with a trusted macOS package manager, or configure its absolute executable path.`;
  if (platform === "linux") return `Install ${family} with the system package manager, or configure its absolute executable path.`;
  return `Install ${family} for this platform, or configure its absolute executable path.`;
}

export async function probeCredentialTool(
  discovery: ToolDiscovery,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<PublicToolReadinessDto> {
  const results: ReadinessResult[] = [];
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
    probe = await runProbe(discovery.path, VERSION_ARGUMENTS[discovery.tool], timeoutMs);
  } catch {
    results.push({ layer: "version", status: "unavailable", message: "Version probe could not start." });
    return { tool: discovery.tool, path: discovery.path, version: null, results, guidance: toolInstallationGuidance(discovery.tool) };
  }
  const version = sanitizedVersion(probe.output);
  const acceptedExit = probe.exitCode === 0 || (USAGE_VERSION_TOOLS.has(discovery.tool) && probe.exitCode === 1);
  if (probe.timedOut) {
    results.push({ layer: "version", status: "unavailable", message: "Version probe timed out." });
  } else if (probe.outputExceeded) {
    results.push({ layer: "version", status: "unavailable", message: "Version probe exceeded the output limit." });
  } else if (!acceptedExit || !version) {
    results.push({ layer: "version", status: "unavailable", message: "Executable did not report a compatible version." });
  } else if (discovery.tool === "gh" && !providerCliVersionSupported("github", version)) {
    results.push({ layer: "version", status: "unavailable", message: "GitHub CLI 2.0 or newer is required." });
  } else if (discovery.tool === "glab" && !providerCliVersionSupported("gitlab", version)) {
    results.push({ layer: "version", status: "unavailable", message: "GitLab CLI 1.22 or newer is required." });
  } else {
    results.push({ layer: "version", status: "ready", message: "Compatible version was reported." });
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

  constructor(
    private readonly store: CredentialToolOverrideStore,
    private readonly servicePath: string | undefined = process.env.PATH,
    private readonly probe: (discovery: ToolDiscovery) => Promise<PublicToolReadinessDto> = probeCredentialTool,
  ) {}

  async load(): Promise<void> {
    await this.store.load();
    await this.reprobeAll();
  }

  list(): PublicToolReadinessDto[] {
    return CREDENTIAL_TOOLS.map(tool => this.readiness.get(tool)).filter(value => value !== undefined).map(value => structuredClone(value));
  }

  async setOverride(tool: CredentialTool, executablePath: string): Promise<PublicToolReadinessDto> {
    const discovery = await discoverExecutable(tool, { override: executablePath, path: this.servicePath });
    const result = await this.probe(discovery);
    if (result.results.some(layer => layer.layer === "version" && layer.status !== "ready")) {
      throw new Error(`tool override failed validation: ${tool}`);
    }
    await this.store.set({ tool, path: executablePath });
    await this.reprobeAll();
    return structuredClone(this.readiness.get(tool)!);
  }

  async clearOverride(tool: CredentialTool): Promise<PublicToolReadinessDto> {
    await this.store.delete(tool);
    await this.reprobeAll();
    return structuredClone(this.readiness.get(tool)!);
  }

  async reprobeAll(): Promise<void> {
    const overrides = Object.fromEntries(this.store.list().map(value => [value.tool, value.path]));
    const discoveries = await discoverCredentialTools(overrides, this.servicePath);
    const results = await Promise.all(discoveries.map(discovery => this.probe(discovery)));
    this.readiness = new Map(results.map(result => [result.tool, result]));
  }
}
