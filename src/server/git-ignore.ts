import type { DocumentMeta } from "../shared/types";

export type GitIgnoreStatus = NonNullable<DocumentMeta["gitIgnoreStatus"]>;

// No shell, argv-sized path list, --no-index, or hand-parsed .gitignore.
// Git handles nested/info/global rules and excludes tracked files itself.
export async function classifyGitIgnored(cwd: string, paths: readonly string[], signal?: AbortSignal): Promise<GitIgnoreStatus[]> {
  if (!paths.length) return [];
  try {
    const child = Bun.spawn(["git", "check-ignore", "--stdin", "-z"], {
      cwd, stdin: new Blob([paths.join("\0") + "\0"]), stdout: "pipe", stderr: "ignore",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      signal, timeout: 10_000,
    });
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0 && code !== 1) return paths.map(() => "unknown");
    const ignored = new Set(output.split("\0"));
    return paths.map(file => ignored.has(file) ? "ignored" : "not-ignored");
  } catch { return paths.map(() => "unknown"); }
}
