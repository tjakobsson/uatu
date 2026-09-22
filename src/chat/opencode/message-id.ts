import { createHash } from "node:crypto";

/**
 * A client-minted OpenCode message id derived from the workspace's own
 * request id, so a retried prompt is the same message to OpenCode. Both
 * generations insist on the `msg_` prefix (2.x rejects anything else at the
 * schema), and an id that already carries it passes through unchanged.
 */
export function stableProviderId(prefix: "msg", identity: string): string {
  if (identity.startsWith(`${prefix}_`)) return identity;
  return `${prefix}_${createHash("sha256").update(identity).digest("hex").slice(0, 26)}`;
}
