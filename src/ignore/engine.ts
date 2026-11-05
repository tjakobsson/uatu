import path from "node:path";
import ignore from "ignore";
import { loadIgnoreConfig } from "./config";
import { shouldDenyPath } from "./exposure";

export type IgnoreMatcherOptions = {
  rootPath: string;
  respectGitignore: boolean;
  isSingleFileRoot?: boolean;
};

export type IgnoreMatcher = {
  shouldIgnore(relativePath: string, isDirectory?: boolean): boolean;
  isVisibilityException?(relativePath: string): boolean;
  initialShowIgnored?: boolean;
  explicitInitialShowIgnored?: boolean;
  toChokidarIgnored(): (testPath: string, stats?: { isDirectory(): boolean }) => boolean;
};

// build/dist are soft exclusions. Every other built-in remains mandatory in
// exposure.shouldDenyPath, including inside an admitted output directory.
export async function loadIgnoreMatcher(options: IgnoreMatcherOptions): Promise<IgnoreMatcher> {
  const { rootPath, respectGitignore, isSingleFileRoot = false } = options;
  const config = isSingleFileRoot ? null : (await loadIgnoreConfig(rootPath)).config;
  const positive = ignore().add(config?.exclude.filter(pattern => !pattern.startsWith("!")) ?? []);
  const exceptions = ignore().add(config?.exclude ?? []);
  const includes = config?.include ?? [];
  const shouldIgnore = (relativePath: string, isDirectory = false): boolean => {
    if (!relativePath || relativePath === ".") return false;
    if (shouldDenyPath(relativePath)) return true;
    const test = isDirectory && !relativePath.endsWith("/") ? `${relativePath}/` : relativePath;
    if (positive.ignores(test)) return true;
    const parts = relativePath.replace(/\/$/, "").split("/");
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]!.toLowerCase() !== "build" && parts[i]!.toLowerCase() !== "dist") continue;
      const prefix = parts.slice(0, i + 1).join("/");
      const admitted = includes.some(include => include.startsWith(`${prefix}/`) && (
        isDirectory && relativePath === include || relativePath.startsWith(`${include}/`)
        || isDirectory && include.startsWith(`${relativePath.replace(/\/$/, "")}/`)));
      if (!admitted) return true;
    }
    return false;
  };
  const explicit = !respectGitignore ? true : config?.explicitRespectGitignore === undefined ? undefined : !config.explicitRespectGitignore;
  return {
    shouldIgnore,
    initialShowIgnored: explicit ?? true,
    explicitInitialShowIgnored: explicit,
    isVisibilityException: relative => exceptions.test(relative).unignored,
    toChokidarIgnored: () => (testPath, stats) => {
      const relative = path.relative(rootPath, testPath);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
      return shouldIgnore(relative.split(path.sep).join("/"), stats?.isDirectory() ?? true);
    },
  };
}
