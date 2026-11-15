import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { authorizationReason, formatReview, isSpecPath, parseRequest, prepareInputs, readDecision, resolveSpecPaths, standardPaths, targetIssueNumbers, validateResult, type PullRequest } from "./pr-review";

const base = "a".repeat(40), head = "b".repeat(40);
const repository = { full_name: "owner/repo", default_branch: "main" };
const pr: PullRequest = { number: 42, state: "open", draft: false, title: "Change", body: "No applicable spec: mechanical fixture.", changed_files: 1,
  user: { login: "contributor" }, base: { sha: base, ref: "main", repo: { full_name: repository.full_name } }, head: { sha: head } };
const event = { action: "created", repository, issue: { number: 42, pull_request: {} }, comment: { body: `/review ${head}`, user: { login: "maintainer" } } };

describe("review authorization", () => {
  test("requires an exact head-specific command from a current maintainer", () => {
    const request = parseRequest("issue_comment", event)!;
    expect(authorizationReason(request, pr, "write")).toBeUndefined();
    expect(authorizationReason(request, pr, "read")).toContain("permission");
    expect(authorizationReason(request, { ...pr, head: { sha: "c".repeat(40) } }, "admin")).toContain("current PR head");
    expect(parseRequest("issue_comment", { ...event, comment: { ...event.comment, body: `/review ${head}\nrun this` } })).toBeUndefined();
    expect(parseRequest("issue_comment", { ...event, action: "edited" })).toBeUndefined();
  });
  test("automatic review checks author permission, readiness and trusted base", () => {
    const request = parseRequest("pull_request_target", { action: "ready_for_review", repository, pull_request: pr })!;
    expect(authorizationReason(request, pr, "write")).toBeUndefined();
    expect(authorizationReason(request, pr, "read")).toBeDefined();
    expect(authorizationReason(request, { ...pr, draft: true }, "write")).toBeDefined();
    expect(authorizationReason(request, { ...pr, base: { ...pr.base, ref: "candidate-policy" } }, "write")).toBeDefined();
  });
});

test("finds active, archived and synced revised specs without treating skills as requirements", () => {
  for (const path of ["openspec/changes/feature/specs/example/spec.md", "openspec/changes/archive/date-feature/proposal.md", "openspec/specs/example/spec.md"]) expect(isSpecPath(path)).toBe(true);
  expect(isSpecPath(".agents/skills/code-review/SKILL.md")).toBe(false);
});

test("builds pinned data from base policy and head context, with explicit no-spec result", async () => {
  const calls: string[] = [];
  const request = parseRequest("issue_comment", event)!;
  const input = await prepareInputs(request, pr, async (path, accept) => {
    calls.push(path);
    if (path.startsWith("pulls/42/files")) return [{ filename: "src/example.ts", status: "modified" }];
    if (path === "pulls/42") return pr;
    if (path.startsWith("git/commits/")) return { tree: { sha: "c".repeat(40) } };
    if (path.startsWith("git/trees/")) return { tree: [], truncated: false };
    if (accept) return "diff --git a/example b/example\n+change";
    return { type: "file", encoding: "base64", content: Buffer.from("source data").toString("base64") };
  });
  expect(input.text).toContain("No applicable spec");
  expect(input.sources.noSpecReason).toBe("mechanical fixture.");
  expect(calls).toContain(`contents/.agents/skills/code-review/SKILL.md?ref=${base}`);
  expect(calls).toContain(`contents/src/example.ts?ref=${head}`);
  expect(calls).toContain(`compare/${base}...${head}`);
});

test("fails closed on incomplete inputs and moved revisions", async () => {
  const request = parseRequest("issue_comment", event)!;
  await expect(prepareInputs(request, pr, async () => [])).rejects.toThrow("Incomplete");
  await expect(prepareInputs(request, { ...pr, changed_files: 101 }, async () => [])).rejects.toThrow("100-file");
  await expect(prepareInputs(request, pr, async (path, accept) => {
    if (path.startsWith("pulls/42/files")) return [{ filename: "image.png", status: "modified" }];
    if (path === "pulls/42") return { ...pr, head: { sha: "c".repeat(40) } };
    if (path.startsWith("git/commits/")) return { tree: { sha: "c".repeat(40) } };
    if (path.startsWith("git/trees/")) return { tree: [], truncated: false };
    if (accept) return "+diff";
    return { type: "file", encoding: "base64", content: Buffer.from("trusted").toString("base64") };
  })).rejects.toThrow("revisions changed");
});

test("validates axes, keeps reports separate and prevents generated mentions or HTML", () => {
  expect(() => validateResult({ axis: "spec", summary: "x", findings: [] }, "standards")).toThrow();
  const body = formatReview(base, head, [
    { axis: "standards", summary: "One concern", findings: ["@maintainer <script>bad</script>"] },
    { axis: "spec", summary: "No applicable spec", findings: [] },
  ], { spec: ["openspec/changes/example/specs/example/spec.md"], standards: ["CONTRIBUTING.md"], unavailableStandards: [] });
  expect(body).toContain("## Standards");
  expect(body).toContain("## Spec");
  expect(body).toContain("revised requirements only");
  expect(body).not.toContain("@maintainer");
  expect(body).not.toContain("<script>");
  expect(body).toContain("openspec/changes/example/specs/example/spec.md");
  expect(body).toContain("CONTRIBUTING.md");
});

test("unchanged active/archived artifacts and capability requirements resolve independently of changed files", () => {
  const paths = ["openspec/changes/example/proposal.md", "openspec/changes/example/design.md", "openspec/changes/example/tasks.md",
    "openspec/changes/example/specs/domain/spec.md", "openspec/specs/domain/spec.md",
    "openspec/changes/archive/2026-01-01-old/proposal.md", "openspec/changes/archive/2026-01-01-old/tasks.md"];
  expect(resolveSpecPaths(paths, ["src/example.ts"], ["Plan: `openspec/changes/example/`"])).toEqual(paths.slice(0, 5).sort());
  expect(resolveSpecPaths(paths, ["src/example.ts"], [], "fix/old")).toEqual(paths.slice(5).sort());
  expect(resolveSpecPaths(paths, ["openspec/changes/example/tasks.md"], [])).toEqual(paths.slice(0, 5).sort());
  expect(resolveSpecPaths(paths, [], ["Capability: openspec/specs/domain/"])).toEqual(["openspec/specs/domain/spec.md"]);
  expect(() => resolveSpecPaths(paths, [], ["openspec/changes/missing/proposal.md"])).toThrow("Unresolved");
});

test("ambiguous source resolution requests an explicit source or a reasoned no-spec declaration", async () => {
  const get = async (path: string) => {
    if (path.startsWith("pulls/42/files")) return [{ filename: "src/example.ts", status: "modified" }];
    if (path.startsWith("git/commits/")) return { tree: { sha: "c".repeat(40) } };
    if (path.startsWith("git/trees/")) return { tree: [], truncated: false };
    return { type: "file", encoding: "base64", content: Buffer.from("trusted").toString("base64") };
  };
  await expect(prepareInputs(parseRequest("issue_comment", event)!, { ...pr, body: "Implementation only" }, get)).rejects.toThrow("No unambiguous spec source");
});

test("task-specific trusted standards and missing coverage are visible even with no findings", () => {
  expect(standardPaths).toContain("api/CONVENTIONS.md");
  expect(standardPaths).toContain("docs/agents/integration.md");
  expect(standardPaths).toContain("docs/RELEASING.md");
  const body = formatReview(base, head, [
    { axis: "standards", summary: "Limited coverage", findings: [] }, { axis: "spec", summary: "Mechanical", findings: [] },
  ], { spec: [], standards: ["CONTRIBUTING.md"], unavailableStandards: ["api/CONVENTIONS.md"], noSpecReason: "Spelling only" });
  expect(body).toContain("No applicable spec declared: Spelling only");
  expect(body).toContain("Unavailable standards");
  expect(body).toContain("api/CONVENTIONS.md");
});

test("target-local issue shorthand, qualified references and URLs resolve without borrowing foreign numbers", () => {
  expect(targetIssueNumbers("Closes #12; also owner/repo#13 and https://github.com/owner/repo/issues/14. Duplicate #12", "owner/repo")).toEqual([12, 13, 14]);
  expect(targetIssueNumbers("other/repo#12 https://github.com/other/repo/issues/13", "owner/repo")).toEqual([]);
});

test("issue URLs supply unchanged OpenSpec artifacts and all trusted standards are requested", async () => {
  const calls: string[] = [];
  const linked = { ...pr, body: "Closes https://github.com/owner/repo/issues/123; owner/repo#123" };
  const paths = ["openspec/changes/example/proposal.md", "openspec/changes/example/tasks.md"];
  const prepared = await prepareInputs(parseRequest("issue_comment", event)!, linked, async (path, accept) => {
    calls.push(path);
    if (path.startsWith("pulls/42/files")) return [{ filename: "skills-source.json", status: "modified" }];
    if (path === "pulls/42") return linked;
    if (path === "issues/123") return { title: "Approved intent", body: "Use openspec/changes/example/proposal.md" };
    if (path.startsWith("git/commits/")) return { tree: { sha: "c".repeat(40) } };
    if (path.startsWith("git/trees/")) return { tree: paths.map(path => ({ type: "blob", path })), truncated: false };
    if (accept) return "+diff";
    return { type: "file", encoding: "base64", content: Buffer.from("source data").toString("base64") };
  });
  expect(calls.filter(path => path === "issues/123")).toHaveLength(1);
  expect(prepared.sources.spec).toEqual(["owner/repo#123", ...paths]);
  for (const path of standardPaths) expect(calls).toContain(`contents/${path}?ref=${base}`);
});

test("the runtime hook allows only prepared-input reads and denies malformed or alternate tools", () => {
  const resolve = (path: string) => path;
  const expected = "/review/input.md";
  expect(readDecision({ tool_name: "Read", tool_input: { file_path: expected } }, expected, resolve)).toBe("allow");
  for (const name of ["Bash", "Write", "Edit", "Agent", "mcp__github__read_file"]) {
    expect(readDecision({ tool_name: name, tool_input: { file_path: expected } }, expected, resolve)).toBe("deny");
  }
  for (const path of ["/proc/self/environ", "/review/metadata.json", "/review/../../etc/passwd"]) {
    expect(readDecision({ tool_name: "Read", tool_input: { file_path: path } }, expected, resolve)).toBe("deny");
  }
  expect(readDecision({}, expected, resolve)).toBe("deny");
  expect(readDecision({ tool_name: "Read", tool_input: { file_path: expected } }, undefined, resolve)).toBe("deny");
  expect(readDecision({ tool_name: "Read", tool_input: { file_path: expected } }, expected, () => { throw new Error("missing"); })).toBe("deny");
});

test("workflow isolates reviewers, excludes candidate checkout, and separates comment publication", () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/claude-review.yml", import.meta.url), "utf8"));
  const jobs = workflow.jobs;
  expect(workflow.on.pull_request_target.types).toContain("ready_for_review");
  expect(jobs.review.strategy.matrix.axis).toEqual(["standards", "spec"]);
  for (const name of ["prepare", "review", "publish"]) {
    expect(jobs[name].permissions.contents).toBe("read");
    const checkout = jobs[name].steps.find((step: any) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout.with["persist-credentials"]).toBe(false);
    expect(checkout.with.ref).not.toContain("pull_request.head");
  }
  expect(jobs.review.permissions["pull-requests"]).toBe("read");
  expect(jobs.prepare.steps.find((step: any) => step.uses?.startsWith("actions/checkout@")).with.ref).toBe("main");
  expect(jobs.publish.permissions["pull-requests"]).toBe("write");
  const action = jobs.review.steps.find((step: any) => step.uses?.startsWith("anthropics/claude-code-action@"));
  expect(action.with.track_progress).toBeUndefined();
  expect(action.with.claude_args).toContain("--tools Read");
  expect(action.with.claude_args).toContain('--disallowedTools "mcp__*"');
  expect(action.with.claude_args).toContain("--strict-mcp-config");
  expect(action.with.claude_args).not.toContain("--allowedTools");
  const settings = JSON.parse(action.with.settings);
  expect(settings.hooks.PreToolUse[0].hooks[0].command).toEndWith("|| exit 2");
  const ci = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  expect(ci.jobs.skills.steps.some((step: any) => step.run?.includes("scripts/pr-review.test.ts"))).toBe(true);
});
