import { access, stat } from "node:fs/promises";
import path from "node:path";

export async function discoverExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const pathValue = env.PATH;
  if (!pathValue) return null;
  const extensions = platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];

  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.resolve(directory, platform === "win32" ? `${name}${extension}` : name);
      try {
        const info = await stat(candidate);
        if (!info.isFile()) continue;
        if (platform !== "win32") await access(candidate, 1);
        return candidate;
      } catch {
        // Continue searching the configured PATH.
      }
    }
  }
  return null;
}

export function discoverOpenCodeExecutable(env?: NodeJS.ProcessEnv): Promise<string | null> {
  return discoverExecutable("opencode", env);
}
