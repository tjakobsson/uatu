import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyGitIgnored } from "./git-ignore";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() { const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-git-ignore-")); dirs.push(dir); return dir; }
async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  expect(await child.exited).toBe(0);
}

test("Git resolves nested/info/global rules, tracked semantics and NUL-safe paths", async () => {
  const cwd = await fixture();
  await git(cwd, "init", "-q");
  await mkdir(path.join(cwd, "nested"));
  await writeFile(path.join(cwd, ".gitignore"), "*.log\n");
  await writeFile(path.join(cwd, "nested/.gitignore"), "!keep.log\n*.render\n");
  await writeFile(path.join(cwd, ".git/info/exclude"), "info.txt\n");
  const global = path.join(await fixture(), "ignore");
  await writeFile(global, "global.txt\n");
  await git(cwd, "config", "core.excludesFile", global);
  await writeFile(path.join(cwd, "tracked.log"), "tracked");
  await git(cwd, "add", "-f", "tracked.log");
  const names = ["plain.txt", "out.log", "nested/keep.log", "nested/out.render", "info.txt", "global.txt", "tracked.log", "space and\nnewline.log"];
  expect(await classifyGitIgnored(cwd, names)).toEqual(["not-ignored", "ignored", "not-ignored", "ignored", "ignored", "ignored", "not-ignored", "ignored"]);
  expect(await classifyGitIgnored(path.join(cwd, "nested"), ["keep.log", "out.render", path.join(cwd, "tracked.log")])).toEqual(["not-ignored", "ignored", "not-ignored"]);
});

test("unavailable Git/repository yields unknown, including cancelled work", async () => {
  const cwd = await fixture();
  expect(await classifyGitIgnored(cwd, ["a.md"])).toEqual(["unknown"]);
  expect(await classifyGitIgnored(path.join(cwd, "missing"), ["a.md"])).toEqual(["unknown"]);
  const abort = new AbortController(); abort.abort();
  expect(await classifyGitIgnored(cwd, ["a.md"], abort.signal)).toEqual(["unknown"]);
});
