import { expect, test } from "bun:test";
import { createChildPolicyAuthority, readChildPolicyBootstrap } from "./child-policy";

test("independent per-child authority binds action, body, principal scope and fresh instance", () => {
  const first = createChildPolicyAuthority("project", "/s/project/");
  const second = createChildPolicyAuthority("project", "/s/project/");
  expect(first.instanceId).not.toBe(second.instanceId);
  expect(JSON.parse(first.bootstrap()).secret === JSON.parse(second.bootstrap()).secret).toBe(false);
  const child = readChildPolicyBootstrap(first.bootstrap());
  const request = { method: "POST", pathname: "/s/project/api/chat/conversations/opencode%3Aparent/prompts", body: '{"messageId":"stable","text":"steer"}' };
  const policy = { principal: "alice", autoBackgroundOnSteer: true, revision: 2 };
  const signed = first.sign(request, policy);
  expect(child.verify(request, signed)).toEqual(policy);
  for (const changed of [{ ...request, body: "{}" }, { ...request, method: "PATCH" }, { ...request, pathname: request.pathname.replace("parent", "other") }]) {
    expect(() => child.verify(changed, signed)).toThrow();
  }
  expect(() => readChildPolicyBootstrap(second.bootstrap()).verify(request, signed)).toThrow();
  const parts = signed.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[0], "base64url").toString()), principal: "bob" })).toString("base64url");
  expect(() => child.verify(request, `${forged}.${parts[1]}`)).toThrow();
  expect(() => child.verify(request, `${parts[0]}.workspace-credential`)).toThrow();
  expect(() => first.sign({ ...request, pathname: "/s/project/api/chat/conversations/x/background" }, policy)).toThrow();
  expect(() => child.verify({ ...request, pathname: "/s/foreign/api/chat/conversations/x/prompt" }, signed)).toThrow();
  const challenge = "fresh-challenge";
  expect(first.verifyProof(challenge, child.proof(challenge))).toBe(true);
  expect(second.verifyProof(challenge, child.proof(challenge))).toBe(false);
  expect(first.verifyProof("different", child.proof(challenge))).toBe(false);
  child.dispose();
  expect(() => child.verify(request, signed)).toThrow();
  expect(() => child.proof(challenge)).toThrow();
});

test("bootstrap is closed and never accepts workspace token fallback or missing identity", () => {
  const first = createChildPolicyAuthority("project", "/s/project/");
  const data = JSON.parse(first.bootstrap());
  for (const invalid of [{ ...data, instanceId: "" }, { ...data, secret: "short" }, { ...data, version: 2 }, { ...data, token: "workspace-credential" }, { ...data, basePath: "/s/other/" }]) {
    expect(() => readChildPolicyBootstrap(JSON.stringify(invalid))).toThrow();
  }
  first.dispose();
  expect(() => first.bootstrap()).toThrow();
  expect(() => first.sign({ method: "POST", pathname: "/s/project/api/chat/conversations/x/prompts", body: "{}" }, { principal: "alice", revision: 0, autoBackgroundOnSteer: true })).toThrow();
});
