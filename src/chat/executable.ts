import { access, stat } from "node:fs/promises";
import path from "node:path";

// A PATH entry on a hung network mount (WSL2 DrvFs, an unreachable NFS home)
// can stall a stat indefinitely; the scan must not let that block startup.
const SCAN_BUDGET_MS = 2_000;

// Every match on PATH, in search order (`which -a` semantics). Selection is
// unchanged — the first entry still wins — but the also-rans are reported in
// startup diagnostics, because a shadowed executable is invisible otherwise. A
// Windows shim ahead of a Linux binary under WSL2 is executable on DrvFs and
// passes every check here, so only the candidate list can reveal it.
//
// Deliberately not filtered or reordered: skipping `/mnt/*` on Linux would be a
// heuristic that silently breaks legitimate setups. Report, do not decide.
//
// Checked in parallel under one bounded budget, never sequentially: this scan
// runs before OpenCode is spawned and outside the startup timeout, so a
// single hung mount must cost at most the budget, not block indefinitely. An
// entry that cannot answer in time is reported absent — for a shadowed
// also-ran that only trims the diagnostics list, and an unanswerable first
// entry was never spawnable anyway.
export async function discoverExecutableCandidates(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  budgetMs: number = SCAN_BUDGET_MS,
): Promise<string[]> {
  const pathValue = env.PATH;
  if (!pathValue) return [];
  const extensions = platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];

  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.resolve(directory, platform === "win32" ? `${name}${extension}` : name);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      candidates.push(candidate);
    }
  }
  const usable = await Promise.all(candidates.map(candidate => withinBudget(isExecutableFile(candidate, platform), budgetMs)));
  return candidates.filter((_, index) => usable[index]);
}

async function isExecutableFile(candidate: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    if (platform !== "win32") await access(candidate, 1);
    return true;
  } catch {
    return false;
  }
}

/** Exported for tests — a hung filesystem cannot be staged deterministically. */
export function withinBudget(check: Promise<boolean>, budgetMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), budgetMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    check.then(
      value => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(false); },
    );
  });
}

export async function discoverExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  return (await discoverExecutableCandidates(name, env, platform))[0] ?? null;
}
