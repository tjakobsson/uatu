import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cleanup, fixture, scratch } from "./skills-fixture";
import { authorize, branch, ciRunMatches, leaseArguments, pack, prepare, publish, safeOutput, sameHead, verifyCI } from "./skills-pr";
import { json, sourceFile } from "./skills";

afterEach(cleanup);
const repository = "owner/uatu";
const actor = "renovate[bot]";
const head = "a".repeat(40), base = "b".repeat(40), next = "c".repeat(40);
const sourcePath = [{ filename: sourceFile, status: "modified" }];
const pr = () => ({ state: "open", user: { login: actor }, head: { ref: branch, sha: head, repo: { full_name: repository } }, base: { sha: base, repo: { full_name: repository } } });
test("authorization accepts only selected same-repository Renovate update", () => {
  authorize(pr(), repository, actor, sourcePath, head);
  for (const mutate of [
    (p: any) => { p.head.repo.full_name = "external/uatu"; },
    (p: any) => { p.base.repo.full_name = "external/uatu"; },
    (p: any) => { p.head.ref = "renovate/other"; },
    (p: any) => { p.user.login = "attacker"; },
    (p: any) => { p.state = "closed"; },
  ]) { const candidate = pr(); mutate(candidate); expect(() => authorize(candidate, repository, actor, sourcePath, head)).toThrow(); }
  expect(() => authorize(pr(), repository, "attacker", sourcePath)).toThrow();
  expect(() => authorize(pr(), repository, actor, sourcePath, next)).toThrow();
  for (const filename of ["package.json", "scripts/skills.ts", ".github/workflows/ci.yml", ".agents/skills/pr/../../evil", ".opencode/skills/openspec-apply-change/SKILL.md", ".claude/commands/opsx/apply.md"]) {
    expect(safeOutput(filename)).toBe(false);
    expect(() => authorize(pr(), repository, actor, [...sourcePath, { filename, status: "modified" }])).toThrow();
  }
  expect(() => authorize(pr(), repository, actor, [{ filename: sourceFile, previous_filename: "evil", status: "renamed" }])).toThrow();
});
test("stale heads and bare dispatch evidence are rejected", async () => {
  expect(() => sameHead(next, head)).toThrow();
  expect(ciRunMatches({ head_sha: head, event: "push" }, head)).toBe(false);
  expect(ciRunMatches({ head_sha: next, event: "workflow_dispatch" }, head)).toBe(false);
  await expect(verifyCI(async path => path.includes("/runs?") ? { workflow_runs: [{ head_sha: head, event: "workflow_dispatch", status: "completed", conclusion: "success", pull_requests: [] }] } : { check_runs: [] }, head, 7)).rejects.toThrow("BLOCKED");
});
test("writeback uses an explicit branch-and-head lease, never an unconditional force", () => {
  expect(leaseArguments(repository, head, next)).toEqual(["push", `--force-with-lease=refs/heads/${branch}:${head}`, `https://github.com/${repository}.git`, `${next}:refs/heads/${branch}`]);
  expect(() => leaseArguments(repository, "HEAD", next)).toThrow();
});
test("CI proof requires successful run and required check associated with exact PR/head", async () => {
  await verifyCI(async path => path.includes("/runs?") ? { workflow_runs: [{ head_sha: head, event: "workflow_dispatch", status: "completed", conclusion: "success", check_suite_id: 42, pull_requests: [] }] } : { check_runs: [{ name: "validate", head_sha: head, check_suite: { id: 42 }, conclusion: "success", pull_requests: [{ number: 7 }] }] }, head, 7);
});
test("an unrelated check suite cannot stand in for dispatched CI", async () => {
  await expect(verifyCI(async path => path.includes("/runs?") ? { workflow_runs: [{ head_sha: head, event: "workflow_dispatch", status: "completed", conclusion: "success", check_suite_id: 42 }] } : { check_runs: [{ name: "validate", head_sha: head, check_suite: { id: 43 }, conclusion: "success", pull_requests: [{ number: 7 }] }] }, head, 7)).rejects.toThrow("BLOCKED");
});
async function payloadFixture() {
  const root = await fixture();
  const source = await json(join(root, sourceFile));
  await writeFile(join(root, "authorization.json"), JSON.stringify({ repository, actor, number: 7, head, base, source }));
  const path = join(root, "payload.json");
  await pack(root, path);
  return { root, payload: await json(path), source };
}
function fakeAPI(source: any, options: { stale?: boolean; noOp?: boolean; staleAtPush?: boolean } = {}) {
  const writes: any[] = [];
  let published = false;
  const get = async (path: string, method = "GET", body?: any): Promise<any> => {
    if (method !== "GET") writes.push({ path, method, body });
    if (path === "pulls/7") { const p = pr(); if (options.stale) p.head.sha = next; else if (published) p.head.sha = next; return p; }
    if (path.startsWith("pulls/7/files")) return sourcePath;
    if (path.startsWith("contents/")) return { type: "file", encoding: "base64", content: Buffer.from(JSON.stringify(source)).toString("base64") };
    if (path === `git/commits/${head}`) return { tree: { sha: "old-tree" } };
    if (path.startsWith("git/trees/")) return { truncated: false, tree: [{ path: ".agents/skills/pr/removed.md", mode: "100644", type: "blob" }, { path: ".claude/skills/openspec-apply-change/SKILL.md", type: "blob" }] };
    if (path === "git/blobs") return { sha: "blob" };
    if (path === "git/trees") return { sha: options.noOp ? "old-tree" : "new-tree" };
    if (path === "git/commits") return { sha: next };
    if (path.startsWith("git/ref/")) return { object: { sha: options.staleAtPush ? next : head } };
    if (path.endsWith("dispatches")) return;
    throw new Error(`Unexpected API call: ${path}`);
  };
  const push = async (_repo: string, expected: string, updated: string) => { expect(expected).toBe(head); expect(updated).toBe(next); writes.push({ path: "exact-lease-push" }); published = true; };
  return { get, push, writes };
}
test("prepare checks trusted base and source identity without executing candidate data", async () => {
  const { root, source } = await payloadFixture();
  const fake = fakeAPI(source);
  await expect(prepare(fake.get, repository, actor, 7, root, next)).rejects.toThrow("Stale");
  await prepare(fake.get, repository, actor, 7, root, base);
  expect((await json(join(root, "authorization.json"))).head).toBe(head);
  const wrong = fakeAPI({ ...source, repository: "attacker/skills" });
  await expect(prepare(wrong.get, repository, actor, 7, root, base)).rejects.toThrow("allowlisted");
});
test("writeback preserves unrelated/OpenSpec tree, deletes obsolete output and dispatches exact resulting head", async () => {
  const { payload, source } = await payloadFixture();
  const fake = fakeAPI(source);
  expect(await publish(fake.get, payload, repository, actor, 7, scratch, base, fake.push)).toBe(next);
  const tree = fake.writes.find(w => w.path === "git/trees").body;
  expect(tree.base_tree).toBe("old-tree");
  expect(tree.tree.some((e: any) => e.path.includes("openspec"))).toBe(false);
  expect(tree.tree.find((e: any) => e.path.endsWith("removed.md")).sha).toBeNull();
  expect(fake.writes.filter(w => w.path === "exact-lease-push")).toHaveLength(1);
  expect(fake.writes.at(-1)).toMatchObject({ path: "actions/workflows/ci.yml/dispatches", body: { ref: branch } });
});
test("idempotent output does not create commits or push; still requests current-head CI", async () => {
  const { payload, source } = await payloadFixture();
  const fake = fakeAPI(source, { noOp: true });
  expect(await publish(fake.get, payload, repository, actor, 7, scratch, base, fake.push)).toBe(head);
  expect(fake.writes.some(w => ["git/commits", "exact-lease-push"].includes(w.path))).toBe(false);
});
test("stale head before or after generation never pushes", async () => {
  const { payload, source } = await payloadFixture();
  for (const options of [{ stale: true }, { staleAtPush: true }]) {
    const fake = fakeAPI(source, options);
    await expect(publish(fake.get, payload, repository, actor, 7, scratch, base, fake.push)).rejects.toThrow("head");
    expect(fake.writes.some(w => w.path === "exact-lease-push" || w.path.endsWith("dispatches"))).toBe(false);
  }
});
test("hostile generated paths, links, bytes and stale artifact source are refused before writes", async () => {
  const original = await payloadFixture();
  for (const mutate of [
    (p: any) => { p.entries[0].path = "../../escape"; },
    (p: any) => { p.entries[0].path = ".claude/skills/openspec-propose/SKILL.md"; },
    (p: any) => { p.entries.find((e: any) => e.mode === "120000").content = Buffer.from("/outside").toString("base64"); },
    (p: any) => { p.entries[0].content = Buffer.from("tampered").toString("base64"); },
    (p: any) => { p.authorization.source.revision = next; },
  ]) {
    const payload = structuredClone(original.payload); mutate(payload);
    const fake = fakeAPI(original.source);
    await expect(publish(fake.get, payload, repository, actor, 7, scratch, base, fake.push)).rejects.toThrow();
    expect(fake.writes).toHaveLength(0);
  }
});
test("Renovate regex extracts and replaces only the allowlisted digest", async () => {
  const config = await json(resolve(import.meta.dir, "../renovate.json"));
  expect(config.enabledManagers).toContain("custom.regex");
  const manager = config.customManagers[0];
  const text = await readFile(resolve(import.meta.dir, `../${sourceFile}`), "utf8");
  const regex = new RegExp(manager.matchStrings[0]);
  const match = text.match(regex)!;
  expect(match.groups!.currentValue).toBe("main");
  const replacement = text.replace(match.groups!.currentDigest, next);
  expect(replacement.match(regex)!.groups!.currentDigest).toBe(next);
  expect(regex.test(text.replace("mattpocock/skills", "attacker/skills"))).toBe(false);
  expect(config.packageRules.find((p: any) => p.branchTopic === "mattpocock-skills").automerge).toBe(false);
});
test("skills-only CI reaches the required validate gate without dependency installation", async () => {
  const ci = await readFile(resolve(import.meta.dir, "../.github/workflows/ci.yml"), "utf8");
  const skillsJob = ci.slice(ci.indexOf("  skills:"), ci.indexOf("  contract-fast:"));
  expect(skillsJob).toContain("bun --no-install run skills:check");
  expect(skillsJob).toContain("bun --no-install test scripts/skills.test.ts scripts/skills-pr.test.ts scripts/pr-review.test.ts");
  expect(skillsJob).not.toContain("bun install");
  expect(skillsJob).not.toContain("if:");
  expect(ci).toContain("needs: [changes, unit, e2e, skills]");
  expect(ci).toContain('if [ "$SKILLS" != "success" ]');
});

test("privileged skill jobs pin the fixed trusted checkout rather than an event ref", async () => {
  const workflow = Bun.YAML.parse(await readFile(resolve(import.meta.dir, "../.github/workflows/update-skills.yml"), "utf8"));
  for (const name of ["generate", "writeback"]) {
    const job = workflow.jobs[name];
    const checkout = job.steps.findIndex((step: any) => step.uses?.startsWith("actions/checkout@"));
    expect(job.steps[checkout].with.ref).toBe("main");
    expect(job.env.TRUSTED_BASE_SHA).toBeUndefined();
    expect(job.steps[checkout + 1].run).toBe('echo "TRUSTED_BASE_SHA=$(git rev-parse HEAD)" >> "$GITHUB_ENV"');
  }
});

test("helper scratch uses runner context only at the executing step", async () => {
  const workflow = Bun.YAML.parse(await readFile(resolve(import.meta.dir, "../.github/workflows/update-skills.yml"), "utf8"));
  const job = workflow.jobs.generate;
  expect(job.env.SKILLS_SCRATCH).toBeUndefined();
  const generation = job.steps.find((step: any) => step.run?.includes("scripts/skills.ts update"));
  expect(generation.env.SKILLS_SCRATCH).toBe("${{ runner.temp }}/skills-scratch");
});
