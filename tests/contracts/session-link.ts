// Test adapter for the session contract: a real session link for a fake
// endpoint, built from the contract's own constructors. Policy signing is
// real, with a fixed secret, and the matching verifier is returned so a test
// can check what a workspace session would accept. `src/` holds product code
// only, so this lives beside the other test harnesses.

import type { RunningSession } from "../../src/hub/backend";
import { createSessionLink, type SessionLink } from "../../src/session-contract/link";
import { sessionBasePath } from "../../src/session-contract/paths";
import { createChildPolicyAuthority, readChildPolicyBootstrap } from "../../src/session-contract/policy";

export const TEST_POLICY_SECRET = Buffer.alloc(32, 7);
export const TEST_INSTANCE_ID = "00000000-0000-4000-8000-000000000001";

export type TestSessionLinkOptions = {
  workspaceId?: string;
  basePath?: string;
  hostname?: string;
  port?: number;
  // Defaults to a fixed synthetic token; null models a ready line without one.
  token?: string | null;
  // Whether the link holds a policy authority. Defaults to false, the state
  // of a session that never proved readiness.
  trusted?: boolean;
};

export function testSessionLink(options: TestSessionLinkOptions = {}): {
  link: SessionLink;
  // What the session side would hold; null when the link is untrusted.
  verifier: ReturnType<typeof readChildPolicyBootstrap> | null;
} {
  const workspaceId = options.workspaceId ?? "project";
  const basePath = options.basePath ?? sessionBasePath(workspaceId);
  const authority = options.trusted
    ? createChildPolicyAuthority(workspaceId, basePath, { secret: TEST_POLICY_SECRET, instanceId: TEST_INSTANCE_ID })
    : null;
  const link = createSessionLink({
    workspaceId,
    instanceId: authority?.instanceId ?? TEST_INSTANCE_ID,
    basePath,
    endpoint: { hostname: options.hostname ?? "127.0.0.1", port: options.port ?? 1 },
    token: options.token === undefined ? "synthetic-session-token" : options.token,
    authority,
  });
  return { link, verifier: authority ? readChildPolicyBootstrap(authority.bootstrap()) : null };
}

// A running session for a SessionBackend fake: the link above plus the
// lifecycle fields the session manager reads. By default it never exits and
// stopping it does nothing.
export function testRunningSession(options: TestSessionLinkOptions & {
  exited?: Promise<number | null>;
  stop?: () => Promise<void>;
} = {}): RunningSession {
  return {
    link: testSessionLink(options).link,
    exited: options.exited ?? new Promise<number | null>(() => undefined),
    stop: options.stop ?? (async () => undefined),
  };
}
