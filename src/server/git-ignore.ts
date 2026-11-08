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

// Folders Git ignores as a whole, and files it ignores individually, relative
// to `cwd` (a watched root inside a working tree). `--directory` collapses an
// ignored folder to one entry without Git descending into it, so a 40,000-file
// node_modules costs one line. Git also collapses untracked folders that merely
// contain ignored files; `check-ignore` on the folder itself confirms it.
// Returns null outside a working tree: nothing is ignored there.
export type IgnoredInventory = { folders: string[]; files: string[] };
export async function collectIgnoredInventory(cwd: string, signal?: AbortSignal): Promise<IgnoredInventory | null> {
  try {
    const child = Bun.spawn(["git", "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], {
      cwd, stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, signal, timeout: 30_000,
    });
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) return null;
    const entries = output.split("\0").filter(Boolean);
    const candidates = entries.filter(entry => entry.endsWith("/"));
    const statuses = await classifyGitIgnored(cwd, candidates, signal);
    if (statuses.includes("unknown")) return null;
    return {
      folders: candidates.filter((_, index) => statuses[index] === "ignored").map(folder => folder.slice(0, -1)),
      files: entries.filter(entry => !entry.endsWith("/")),
    };
  } catch { return null; }
}
