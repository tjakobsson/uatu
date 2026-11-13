// Private Hub -> child policy authority. Neither workspace credentials nor
// browser-selected identity participate in key generation or verification.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const CHILD_POLICY_HEADER = "x-uatu-hub-chat-policy";
export const CHAT_ACTION_BODY_BYTES = 128 * 1024;
export type ChildPolicyRequest = { method: string; pathname: string; body: string };
export type VerifiedChatPolicy = { principal: string; revision: number; autoBackgroundOnSteer: boolean; unavailable?: true };
type Binding = { workspaceId: string; basePath: string; instanceId: string };
const MAX_ENVELOPE_BYTES = 8192;
const MAX_AGE_MS = 60_000;

export function isChildPolicyAction(method: string, pathname: string, basePath: string): boolean {
  if (!pathname.startsWith(basePath)) return false;
  const suffix = pathname.slice(basePath.length);
  return (method === "POST" && /^api\/chat\/conversations\/[^/]+\/(prompts|queue\/[^/]+\/send-now)$/.test(suffix))
    || (method === "PATCH" && /^api\/chat\/conversations\/[^/]+\/queue\/[^/]+$/.test(suffix));
}

function mac(secret: Buffer, domain: string, text: string): string {
  return createHmac("sha256", secret).update(domain).update("\0").update(text).digest("base64url");
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function digest(body: string): string { return createHash("sha256").update(body).digest("hex"); }
function proofText(binding: Binding, challenge: string): string {
  if (challenge.length < 1 || challenge.length > 256) throw new Error("invalid policy challenge");
  return JSON.stringify([binding.workspaceId, binding.basePath, binding.instanceId, challenge]);
}
function policyValid(value: VerifiedChatPolicy): boolean {
  return typeof value.principal === "string" && value.principal.length > 0 && value.principal.length <= 1024
    && Number.isSafeInteger(value.revision) && value.revision >= 0 && typeof value.autoBackgroundOnSteer === "boolean"
    && (value.unavailable === undefined || value.unavailable === true);
}

export function createChildPolicyAuthority(workspaceId: string, basePath: string) {
  const binding: Binding = { workspaceId, basePath, instanceId: randomUUID() };
  const secret = randomBytes(32);
  let active = true;
  const assertActive = () => { if (!active) throw new Error("child policy authority unavailable"); };
  return {
    instanceId: binding.instanceId,
    bootstrap() { assertActive(); return JSON.stringify({ version: 1, ...binding, secret: secret.toString("base64url") }); },
    sign(request: ChildPolicyRequest, policy: VerifiedChatPolicy): string {
      assertActive();
      if (!isChildPolicyAction(request.method, request.pathname, basePath) || !policyValid(policy)) throw new Error("invalid policy scope");
      const payload = Buffer.from(JSON.stringify({ version: 1, ...binding, ...policy, method: request.method, pathname: request.pathname, bodyDigest: digest(request.body), expiresAt: Date.now() + MAX_AGE_MS })).toString("base64url");
      return `${payload}.${mac(secret, "uatu-chat-policy-v1", payload)}`;
    },
    verifyProof(challenge: string, proof: string): boolean {
      return active && equal(mac(secret, "uatu-chat-readiness-v1", proofText(binding, challenge)), proof);
    },
    dispose() { active = false; secret.fill(0); },
  };
}

export function readChildPolicyBootstrap(text: string) {
  if (text.length > MAX_ENVELOPE_BYTES) throw new Error("invalid policy bootstrap");
  const value = JSON.parse(text);
  if (!value || value.version !== 1 || typeof value.workspaceId !== "string" || !/^[a-z0-9-]+$/.test(value.workspaceId)
    || value.basePath !== `/s/${value.workspaceId}/` || typeof value.instanceId !== "string"
    || !/^[0-9a-f-]{36}$/.test(value.instanceId) || typeof value.secret !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(value.secret)
    || Object.keys(value).some(key => !["version", "workspaceId", "basePath", "instanceId", "secret"].includes(key))) throw new Error("invalid policy bootstrap");
  const secret = Buffer.from(value.secret, "base64url");
  const binding: Binding = { workspaceId: value.workspaceId, basePath: value.basePath, instanceId: value.instanceId };
  let active = true;
  const assertActive = () => { if (!active) throw new Error("child policy trust unavailable"); };
  return {
    instanceId: binding.instanceId,
    basePath: binding.basePath,
    proof(challenge: string) { assertActive(); return mac(secret, "uatu-chat-readiness-v1", proofText(binding, challenge)); },
    verify(request: ChildPolicyRequest, envelope: string): VerifiedChatPolicy {
      assertActive();
      const reject = () => { throw new Error("invalid Hub chat policy"); };
      if (envelope.length > MAX_ENVELOPE_BYTES || !isChildPolicyAction(request.method, request.pathname, binding.basePath)) return reject();
      const parts = envelope.split(".");
      if (parts.length !== 2 || !equal(mac(secret, "uatu-chat-policy-v1", parts[0]!), parts[1]!)) return reject();
      const policy = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
      if (policy.version !== 1 || policy.workspaceId !== binding.workspaceId || policy.instanceId !== binding.instanceId
        || policy.basePath !== binding.basePath || policy.method !== request.method || policy.pathname !== request.pathname
        || policy.bodyDigest !== digest(request.body) || !policyValid(policy) || !Number.isSafeInteger(policy.expiresAt)
        || policy.expiresAt < Date.now() || policy.expiresAt > Date.now() + MAX_AGE_MS) return reject();
      return { principal: policy.principal, revision: policy.revision, autoBackgroundOnSteer: policy.autoBackgroundOnSteer, ...(policy.unavailable === true ? { unavailable: true as const } : {}) };
    },
    dispose() { active = false; secret.fill(0); },
  };
}
