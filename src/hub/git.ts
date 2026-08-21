// Git plumbing for the hub's workspace-creation flows: the non-git-folder
// preflight (mirroring the desktop launcher's rules), `git init` on
// confirmation, and `git clone` into a chosen destination directory. All
// run as the daemon's OS user with its ambient git config/credentials —
// the hub stores no credentials of its own.

export type GitProbeResult =
  | { kind: "repository"; toplevel: string }
  | { kind: "not-a-repository" }
  // The probe failed without proving the repository is missing (git not
  // installed, safe.directory rejection, …) — per the desktop preflight
  // spec, the caller skips the init offer and lets the serve CLI's own
  // preflight report.
  | { kind: "indeterminate"; detail: string };

async function runGit(args: string[], cwd?: string, executable = "git"): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([executable, ...args], {
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

export async function probeGitRepository(folder: string, executable = "git"): Promise<GitProbeResult> {
  const result = await runGit(["rev-parse", "--show-toplevel"], folder, executable);
  if (result.exitCode === 0) {
    return { kind: "repository", toplevel: result.stdout.trim() };
  }
  if (/not a git repository/i.test(result.stderr)) {
    return { kind: "not-a-repository" };
  }
  return { kind: "indeterminate", detail: result.stderr.trim() };
}

export async function gitInit(folder: string, executable = "git"): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await runGit(["init"], folder, executable);
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

export function validCloneFolderName(value: string): boolean {
  return value !== "" && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\") && !value.includes("\0");
}
