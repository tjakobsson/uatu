import { access, stat } from "node:fs/promises";
import path from "node:path";

// Every match on PATH, in search order (`which -a` semantics). Selection is
// unchanged — the first entry still wins — but the also-rans are reported in
// startup diagnostics, because a shadowed executable is invisible otherwise. A
// Windows shim ahead of a Linux binary under WSL2 is executable on DrvFs and
// passes every check here, so only the candidate list can reveal it.
//
// Deliberately not filtered or reordered: skipping `/mnt/*` on Linux would be a
// heuristic that silently breaks legitimate setups. Report, do not decide.
export async function discoverExecutableCandidates(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  const pathValue = env.PATH;
  if (!pathValue) return [];
  const extensions = platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];

  const found: string[] = [];
  const seen = new Set<string>();
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.resolve(directory, platform === "win32" ? `${name}${extension}` : name);
      if (seen.has(candidate)) continue;
      try {
        const info = await stat(candidate);
        if (!info.isFile()) continue;
        if (platform !== "win32") await access(candidate, 1);
        seen.add(candidate);
        found.push(candidate);
      } catch {
        // Continue searching the configured PATH.
      }
    }
  }
  return found;
}

export async function discoverExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  return (await discoverExecutableCandidates(name, env, platform))[0] ?? null;
}

export function discoverOpenCodeExecutable(env?: NodeJS.ProcessEnv): Promise<string | null> {
  return discoverExecutable("opencode", env);
}

export function discoverOpenCodeCandidates(env?: NodeJS.ProcessEnv): Promise<string[]> {
  return discoverExecutableCandidates("opencode", env);
}
