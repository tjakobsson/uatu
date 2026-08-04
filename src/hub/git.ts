// Git plumbing for the hub's workspace-creation flows: the non-git-folder
// preflight (mirroring the desktop launcher's rules), `git init` on
// confirmation, and `git clone` into the workspaces root. All run as the
// daemon's OS user with its ambient git config/credentials — the hub stores
// no credentials of its own.

import { promises as fs } from "node:fs";
import path from "node:path";

export type GitProbeResult =
  | { kind: "repository"; toplevel: string }
  | { kind: "not-a-repository" }
  // The probe failed without proving the repository is missing (git not
  // installed, safe.directory rejection, …) — per the desktop preflight
  // spec, the caller skips the init offer and lets the serve CLI's own
  // preflight report.
  | { kind: "indeterminate"; detail: string };

async function runGit(args: string[], cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(["git", ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return { exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export async function probeGitRepository(folder: string): Promise<GitProbeResult> {
  const result = await runGit(["rev-parse", "--show-toplevel"], folder);
  if (result.exitCode === 0) {
    return { kind: "repository", toplevel: result.stdout.trim() };
  }
  if (/not a git repository/i.test(result.stderr)) {
    return { kind: "not-a-repository" };
  }
  return { kind: "indeterminate", detail: result.stderr.trim() };
}

export async function gitInit(folder: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await runGit(["init"], folder);
  if (result.exitCode === 0) {
    return { ok: true };
  }
  return { ok: false, error: result.stderr.trim() || `git init exited ${result.exitCode}` };
}

// Derives the checkout folder name from a clone URL:
// "git@github.com:me/uatu.git" → "uatu", "https://x/y/repo" → "repo".
export function cloneTargetName(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, "");
  const last = trimmed.split(/[/:]/).pop() ?? "";
  const name = last.endsWith(".git") ? last.slice(0, -4) : last;
  if (name === "" || name === "." || name === "..") {
    return null;
  }
  return name;
}

export async function gitClone(
  url: string,
  workspacesDir: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const name = cloneTargetName(url);
  if (!name) {
    return { ok: false, error: `cannot derive a folder name from clone URL: ${url}` };
  }
  const target = path.join(workspacesDir, name);
  if (await Bun.file(path.join(target, ".git", "HEAD")).exists()) {
    return { ok: false, error: `target already exists: ${target}` };
  }
  await fs.mkdir(workspacesDir, { recursive: true });
  const result = await runGit(["clone", url, target]);
  if (result.exitCode === 0) {
    return { ok: true, path: target };
  }
  return { ok: false, error: result.stderr.trim() || `git clone exited ${result.exitCode}` };
}
