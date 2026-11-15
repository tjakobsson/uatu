// This file runs only from the trusted PR base. Candidate files are data;
// installer execution is a separate, credential-free process/job step.
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { check, files, json, licenseFile, managedOutput, names, parseSource, receiptFile, sourceFile } from "./skills";

const sha = /^[a-f0-9]{40}$/;
export const branch = "renovate/mattpocock-skills";
type FileChange = { filename: string; previous_filename?: string; status: string };
export function authorize(pr: any, repository: string, actor: string, paths: FileChange[], expectedHead?: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || actor !== "renovate[bot]" || pr.user?.login !== "renovate[bot]" ||
      pr.state !== "open" || pr.head?.repo?.full_name !== repository || pr.base?.repo?.full_name !== repository ||
      pr.head?.ref !== branch || !sha.test(pr.head?.sha) || !sha.test(pr.base?.sha) ||
      (expectedHead && pr.head.sha !== expectedHead)) throw new Error("Unauthorized repository/actor/branch, closed PR, or stale head");
  if (!paths.some(p => p.filename === sourceFile) || paths.some(p => p.previous_filename || !["added", "modified", "removed"].includes(p.status) ||
      (p.filename !== sourceFile && !safeOutput(p.filename)))) throw new Error("Unsupported mixed update/renamed path; split the skill source update into its own PR");
}
export function safeOutput(path: string) {
  return !path.startsWith("/") && !path.split("/").some(p => !p || p === "." || p === "..") && managedOutput(path);
}
export function sameHead(actual: string, expected: string) {
  if (!sha.test(expected) || actual !== expected) throw new Error("Stale head: refusing writeback");
}
export function leaseArguments(repository: string, expected: string, head: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !sha.test(expected) || !sha.test(head)) throw new Error("Invalid exact-head push");
  return ["push", `--force-with-lease=refs/heads/${branch}:${expected}`, `https://github.com/${repository}.git`, `${head}:refs/heads/${branch}`];
}
export function ciRunMatches(run: any, head: string) {
  return run.head_sha === head && run.event === "workflow_dispatch";
}
type API = (path: string, method?: string, body?: unknown) => Promise<any>;
function api(repository: string): API {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid repository");
  return async (path, method = "GET", body) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      method, redirect: "error", headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "uatu-skills-updater", "X-GitHub-Api-Version": "2022-11-28" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  };
}
async function changedPaths(get: API, number: number) {
  const paths: FileChange[] = [];
  for (let page = 1; page <= 31; page++) {
    const batch = await get(`pulls/${number}/files?per_page=100&page=${page}`);
    paths.push(...batch);
    if (batch.length < 100) return paths;
  }
  throw new Error("PR file list exceeds supported limit");
}
async function sourceAt(get: API, head: string) {
  const data = await get(`contents/${sourceFile}?ref=${head}`);
  if (data.encoding !== "base64" || data.type !== "file") throw new Error("Source declaration must be a regular file");
  return parseSource(JSON.parse(Buffer.from(data.content, "base64").toString()));
}
export async function prepare(get: API, repository: string, actor: string, number: number, target: string, trustedBase: string) {
  const pr = await get(`pulls/${number}`);
  authorize(pr, repository, actor, await changedPaths(get, number));
  sameHead(pr.base.sha, trustedBase);
  const source = await sourceAt(get, pr.head.sha);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, sourceFile), JSON.stringify(source, null, 2) + "\n");
  await writeFile(join(target, "authorization.json"), JSON.stringify({ repository, actor, number, head: pr.head.sha, base: pr.base.sha, source }));
}
type Entry = { path: string; mode: "100644" | "120000"; content: string };
export async function pack(root: string, output: string) {
  await check(root);
  const paths = ["skills-lock.json", receiptFile, licenseFile, ...await files(root, ".agents/skills/code-review"), ...await files(root, ".agents/skills/pr")];
  const entries: Entry[] = [];
  for (const path of paths) entries.push({ path, mode: "100644", content: (await readFile(join(root, path))).toString("base64") });
  for (const client of [".claude", ".opencode"]) for (const name of names) {
    const path = `${client}/skills/${name}`;
    entries.push({ path, mode: "120000", content: Buffer.from(await readlink(join(root, path))).toString("base64") });
  }
  await writeFile(output, JSON.stringify({ authorization: await json(join(root, "authorization.json")), entries }));
}
export async function pushExact(repository: string, expected: string, head: string, scratch: string) {
  const pushArgs = leaseArguments(repository, expected, head);
  const bare = await mkdtemp(join(scratch, "push-"));
  try {
    // No checkout, repository config, hooks, global auth, or candidate process.
    const env = { PATH: process.env.PATH!, HOME: bare, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString("base64")}`, GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: "/dev/null" };
    const run = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: bare, env, stdio: "pipe" });
      // Never include credential-bearing process environment/output in errors.
      if (result.status !== 0) throw new Error("Exact-head Git operation failed; no fallback attempted");
    };
    run(["init", "--bare"]);
    const remote = `https://github.com/${repository}.git`;
    run(["fetch", "--no-tags", "--depth=1", remote, head]);
    run(pushArgs);
  } finally { await rm(bare, { recursive: true, force: true }); }
}
export async function publish(get: API, payload: any, repository: string, actor: string, number: number, scratch: string, trustedBase: string, push = pushExact) {
  const auth = payload.authorization;
  if (auth.repository !== repository || auth.actor !== actor || auth.number !== number || !sha.test(auth.base)) throw new Error("Artifact authorization mismatch");
  sameHead(auth.base, trustedBase);
  const pr = await get(`pulls/${number}`);
  authorize(pr, repository, actor, await changedPaths(get, number), auth.head);
  if (pr.base.sha !== auth.base) throw new Error("Base changed; regenerate with current trusted policy");
  const source = await sourceAt(get, auth.head);
  if (JSON.stringify(source) !== JSON.stringify(parseSource(auth.source))) throw new Error("Source changed during installation");
  const entries = payload.entries as Entry[];
  if (!Array.isArray(entries) || entries.length > 100 || new Set(entries.map(e => e.path)).size !== entries.length || entries.some(e => !safeOutput(e.path) || !["100644", "120000"].includes(e.mode) || typeof e.content !== "string" || e.content.length > 1_000_000)) throw new Error("Unexpected generated artifact paths/modes/size");
  const temp = await mkdtemp(join(scratch, "verify-"));
  try {
    await writeFile(join(temp, sourceFile), JSON.stringify(source));
    for (const entry of entries) {
      const isLink = [".claude", ".opencode"].some(client => names.some(n => entry.path === `${client}/skills/${n}`));
      if ((entry.mode === "120000") !== isLink) throw new Error("Unexpected artifact symlink mode");
      await mkdir(join(temp, dirname(entry.path)), { recursive: true });
      const bytes = Buffer.from(entry.content, "base64");
      if (isLink) {
        const name = entry.path.split("/").at(-1);
        if (bytes.toString() !== `../../.agents/skills/${name}`) throw new Error("Escaping artifact link");
        await symlink(bytes.toString(), join(temp, entry.path));
      } else await writeFile(join(temp, entry.path), bytes);
    }
    await check(temp);
  } finally { await rm(temp, { recursive: true, force: true }); }
  const commit = await get(`git/commits/${auth.head}`);
  const currentTree = await get(`git/trees/${commit.tree.sha}?recursive=1`);
  if (currentTree.truncated) throw new Error("Candidate tree truncated");
  const tree: any[] = [];
  for (const entry of entries) {
    const blob = await get("git/blobs", "POST", { encoding: "base64", content: entry.content });
    tree.push({ path: entry.path, mode: entry.mode, type: "blob", sha: blob.sha });
  }
  for (const entry of currentTree.tree) if (safeOutput(entry.path) && entry.type !== "tree" && !entries.some(e => e.path === entry.path)) tree.push({ path: entry.path, mode: entry.mode, type: "blob", sha: null });
  const generated = await get("git/trees", "POST", { base_tree: commit.tree.sha, tree });
  let head = auth.head;
  if (generated.sha !== commit.tree.sha) {
    sameHead((await get(`pulls/${number}`)).head.sha, auth.head);
    const updated = await get("git/commits", "POST", { message: "chore(deps): regenerate pinned third-party skills", tree: generated.sha, parents: [auth.head] });
    sameHead((await get(`git/ref/heads/${branch}`)).object.sha, auth.head);
    // Git's explicit lease supplies the compare-and-swap missing from REST
    // update-ref, including racing backwards resets. Never retry without it.
    await push(repository, auth.head, updated.sha, scratch);
    head = updated.sha;
  }
  sameHead((await get(`pulls/${number}`)).head.sha, head);
  await get("actions/workflows/ci.yml/dispatches", "POST", { ref: branch });
  return head;
}
export async function verifyCI(get: API, head: string, number: number) {
  // Dispatch alone is not evidence of required PR checks. Fail closed unless
  // GitHub associates the dispatched run and validate check with this PR/SHA.
  const { workflow_runs: runs } = await get(`actions/workflows/ci.yml/runs?event=workflow_dispatch&head_sha=${head}&per_page=100`);
  const { check_runs: checks } = await get(`commits/${head}/check-runs?per_page=100`);
  const proven = runs.some((run: any) => ciRunMatches(run, head) && run.status === "completed" && run.conclusion === "success" && run.check_suite_id &&
    checks.some((c: any) => c.name === "validate" && c.head_sha === head && c.check_suite?.id === run.check_suite_id && c.conclusion === "success" && c.pull_requests?.some((p: any) => p.number === number)));
  if (!proven) throw new Error(`BLOCKED: required PR validate check not proven on ${head}; maintainers must authorize/verify a supported CI trigger arrangement. Dispatch is not proof.`);
}
if (import.meta.main) {
  const [command, path, extra] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY!;
  const actor = process.env.REQUEST_ACTOR!;
  const number = Number(process.env.PR_NUMBER);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid PR number");
  if (command === "prepare") await prepare(api(repository), repository, actor, number, path, process.env.TRUSTED_BASE_SHA!);
  else if (command === "pack") await pack(path, extra);
  else if (command === "publish") {
    if ((await readFile(path)).length > 2_000_000) throw new Error("Artifact too large");
    const head = await publish(api(repository), await json(path), repository, actor, number, process.env.RUNNER_TEMP!, process.env.TRUSTED_BASE_SHA!);
    await writeFile(extra, head);
  } else if (command === "verify-ci") await verifyCI(api(repository), (await readFile(path, "utf8")).trim(), number);
  else throw new Error("Expected prepare, pack, publish, or verify-ci");
}
