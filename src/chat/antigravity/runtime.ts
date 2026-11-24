import { PathAgentRuntime, type PathAgentConfiguration, type PathAgentRuntimeOptions } from "../path-agent-runtime";
import { ANTIGRAVITY_AGENT } from "./descriptor";

/** The leading semantic version `agy --version` prints, on its first line. */
export function parseAntigravityVersion(stdout: string): string | null {
  const first = stdout.trim().split("\n", 1)[0] ?? "";
  return first.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;
}

const ANTIGRAVITY_PATH_AGENT: PathAgentConfiguration = {
  binary: "agy",
  displayName: ANTIGRAVITY_AGENT.name,
  parseVersion: parseAntigravityVersion,
};

/**
 * The Antigravity agent runtime (add-antigravity-chat D3): Antigravity's
 * configuration of the PATH agent runtime. Availability is discovery plus one
 * bounded `agy --version` probe; the probe says nothing about the login,
 * which the provider learns from `agy` itself. Every `agy acp` process is the
 * provider's.
 */
export class AntigravityRuntime extends PathAgentRuntime {
  constructor(options: PathAgentRuntimeOptions) {
    super(ANTIGRAVITY_PATH_AGENT, options);
  }
}
