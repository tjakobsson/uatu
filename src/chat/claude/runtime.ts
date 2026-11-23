import { PathAgentRuntime, type PathAgentConfiguration, type PathAgentRuntimeOptions, type VersionProbeResult } from "../path-agent-runtime";
import { CLAUDE_CODE_AGENT } from "./descriptor";

export type ClaudeProbeResult = VersionProbeResult;
export type ClaudeRuntimeOptions = PathAgentRuntimeOptions;

/** `<version> (Claude Code)` or a bare semver — take the leading version token. */
function parseVersion(stdout: string): string | null {
  const match = stdout.trim().match(/^(\d+\.\d+\.\d+\S*)/);
  return match ? match[1]! : null;
}

const CLAUDE_CODE_PATH_AGENT: PathAgentConfiguration = {
  binary: "claude",
  displayName: CLAUDE_CODE_AGENT.name,
  parseVersion,
};

/**
 * The Claude Code agent runtime (D4): Claude Code's configuration of the
 * PATH agent runtime. Different in kind from OpenCode's: there is no
 * long-lived idle service to spawn and health-probe. Availability is
 * executable discovery plus one bounded `claude --version` probe, and the
 * per-conversation SDK sessions are owned by the provider, not here.
 */
export class ClaudeRuntime extends PathAgentRuntime {
  constructor(options: ClaudeRuntimeOptions) {
    super(CLAUDE_CODE_PATH_AGENT, options);
  }
}
